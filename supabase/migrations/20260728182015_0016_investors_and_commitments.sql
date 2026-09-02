-- ============================================================================
-- 0016 — Investor commitments, classified funding, and the master summary.
--
-- THE MODEL, IN THE OWNER'S WORDS
-- Five investors agree 20% each on a 1 crore project, so each commits 20 lakh.
-- Money then arrives in pieces over months, into BOTH books. The app must answer
-- per investor: how much have they put in, and how much is still to come.
--
-- Share % is FIXED BY AGREEMENT at setup. It is never recalculated from who
-- happened to fund fastest — that is the single most likely cause of a dispute
-- between partners.
--
-- Statutory share capital is usually a SUBSET of the commitment: authorised
-- capital may be 15 lakh while the project needs 1 crore. So every rupee that
-- arrives is classified into one of four buckets.
-- ============================================================================

alter table companies
  add column if not exists target_investment  numeric(18,2) not null default 0,
  add column if not exists authorised_capital numeric(18,2) not null default 0,
  -- the CEO's switch: reveal the internal book to investors when they choose
  add column if not exists show_internal_to_investors boolean not null default false;

create table if not exists investors (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references companies(id) on delete cascade,
  party_id           uuid not null references parties(id) on delete restrict,
  display_name       text not null,
  -- agreed at setup, fixed. NOT derived from contributions.
  agreed_share_pct   numeric(9,6) not null default 0 check (agreed_share_pct >= 0),
  committed_amount   numeric(18,2) not null default 0 check (committed_amount >= 0),
  -- each investor gets their OWN capital account, as Indian partnership and LLP
  -- accounts are expected to present them
  capital_account_id uuid references accounts(id) on delete restrict,
  linked_user_id     uuid references auth.users(id) on delete set null,
  joined_on          date,
  is_active          boolean not null default true,
  notes              text,
  created_at         timestamptz not null default now(),
  unique (company_id, party_id)
);
create index if not exists investors_company_idx on investors (company_id);

grant select, insert, update, delete on investors to authenticated;
alter table investors enable row level security;

drop policy if exists investors_select on investors;
create policy investors_select on investors for select to authenticated
  using (public.company_is_member(company_id));
drop policy if exists investors_write on investors;
create policy investors_write on investors for all to authenticated
  using (public.company_has_right(company_id,'manage_members'))
  with check (public.company_has_right(company_id,'manage_members'));

-- ---------------------------------------------------------------------------
-- The two shared accounts every company needs for investor funding.
-- ---------------------------------------------------------------------------
create or replace function public.ensure_funding_accounts(p_company uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into accounts (company_id, code, name, account_type, account_group,
                        sub_group, normal_balance, is_system)
  values
    (p_company, '2230', 'Unsecured Loan from Investors', 'liability',
     'Current Liabilities', 'Short Term Borrowings', 'C', true),
    -- money received before anyone has decided what it legally is. Real
    -- businesses take money in before the paperwork is done; pretending
    -- otherwise just produces a wrong classification.
    (p_company, '2240', 'Investor Funds - Pending Classification', 'liability',
     'Current Liabilities', 'Other Current Liabilities', 'C', true)
  on conflict (company_id, code) do nothing;
end; $$;

-- ---------------------------------------------------------------------------
-- add_investor — creates the party, their own capital account, and the record.
-- Either a share % or an amount may be given; each derives the other from the
-- company's target investment.
-- ---------------------------------------------------------------------------
create or replace function public.add_investor(p_payload jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_company uuid := (p_payload->>'company_id')::uuid;
  v_name    text := nullif(trim(p_payload->>'name'),'');
  v_pct     numeric(9,6) := nullif(p_payload->>'agreed_share_pct','')::numeric;
  v_amt     numeric(18,2) := nullif(p_payload->>'committed_amount','')::numeric;
  v_target  numeric(18,2);
  v_party   uuid;
  v_acct    uuid;
  v_id      uuid;
  v_code    text;
  v_n       int;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if not public.company_has_right(v_company,'manage_members') then
    raise exception 'you do not have permission to add investors';
  end if;
  if v_name is null then raise exception 'an investor name is required'; end if;

  select target_investment into v_target from companies where id = v_company;
  perform public.ensure_funding_accounts(v_company);

  -- percentage and amount each derive the other
  if v_pct is null and v_amt is not null and coalesce(v_target,0) > 0 then
    v_pct := round(v_amt / v_target * 100, 6);
  elsif v_amt is null and v_pct is not null and coalesce(v_target,0) > 0 then
    v_amt := round(v_target * v_pct / 100, 2);
  end if;

  v_party := public.find_or_create_party(v_company, v_name, 'investor');

  -- their own capital account, numbered 3011, 3012, ...
  select count(*) into v_n from investors where company_id = v_company;
  v_code := (3011 + v_n)::text;
  while exists (select 1 from accounts where company_id = v_company and code = v_code) loop
    v_n := v_n + 1;
    v_code := (3011 + v_n)::text;
  end loop;

  insert into accounts (company_id, code, name, account_type, account_group,
                        sub_group, normal_balance, capex_role)
  values (v_company, v_code, 'Capital - ' || v_name, 'equity',
          'Owners Funds', 'Partners Capital', 'C', 'capital')
  returning id into v_acct;

  insert into investors (company_id, party_id, display_name, agreed_share_pct,
                         committed_amount, capital_account_id, joined_on)
  values (v_company, v_party, v_name, coalesce(v_pct,0), coalesce(v_amt,0), v_acct,
          coalesce(nullif(p_payload->>'joined_on','')::date, current_date))
  on conflict (company_id, party_id) do update
     set display_name = excluded.display_name,
         agreed_share_pct = excluded.agreed_share_pct,
         committed_amount = excluded.committed_amount
  returning id into v_id;

  return v_id;
end; $$;

-- ---------------------------------------------------------------------------
-- record_investment — money arriving from an investor, classified.
--   kind: share_capital | investor_loan | pending
-- 'outside' contributions do not pass through here; they are management-book
-- entries recorded from the guided screen, because no company money moved.
-- ---------------------------------------------------------------------------
create or replace function public.record_investment(p_payload jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_company uuid := (p_payload->>'company_id')::uuid;
  v_inv     uuid := (p_payload->>'investor_id')::uuid;
  v_kind    text := coalesce(p_payload->>'kind','investor_loan');
  v_amt     numeric(18,2) := round((p_payload->>'amount')::numeric, 2);
  v_money   uuid := (p_payload->>'money_account_id')::uuid;
  v_book    uuid;
  v_party   uuid;
  v_credit  uuid;
  v_name    text;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if v_amt <= 0 then raise exception 'amount must be greater than zero'; end if;
  if v_kind not in ('share_capital','investor_loan','pending') then
    raise exception 'kind must be share_capital, investor_loan or pending';
  end if;

  select party_id, capital_account_id, display_name
    into v_party, v_credit, v_name
    from investors where id = v_inv and company_id = v_company;
  if v_party is null then raise exception 'investor not found'; end if;

  select id into v_book from books where company_id = v_company and kind = 'primary';

  if v_kind = 'investor_loan' then
    select id into v_credit from accounts where company_id = v_company and code = '2230';
  elsif v_kind = 'pending' then
    select id into v_credit from accounts where company_id = v_company and code = '2240';
  end if;
  if v_credit is null then raise exception 'funding account missing; run ensure_funding_accounts'; end if;

  return public.save_journal_entry(jsonb_build_object(
    'company_id', v_company, 'book_id', v_book,
    'voucher_type','receipt',
    'entry_date', coalesce(nullif(p_payload->>'date','')::date, current_date),
    'narration', coalesce(nullif(trim(p_payload->>'narration'),''),
      case v_kind
        when 'share_capital' then 'Share capital received from ' || v_name
        when 'investor_loan' then 'Funding received from ' || v_name || ' (repayable)'
        else 'Funds received from ' || v_name || ' - classification pending'
      end),
    'party_id', v_party,
    'payment_mode', nullif(p_payload->>'mode',''),
    'reference_no', nullif(p_payload->>'reference',''),
    'proof_url', nullif(p_payload->>'proof_url',''),
    'status','posted',
    'lines', jsonb_build_array(
      jsonb_build_object('account_id', v_money,  'debit',  v_amt),
      jsonb_build_object('account_id', v_credit, 'credit', v_amt, 'party_id', v_party))));
end; $$;

-- ---------------------------------------------------------------------------
-- reclassify_investment — move funds between buckets once the legal position is
-- settled. A real journal entry, never a silent edit, so the audit trail shows
-- exactly when and why the classification changed.
-- ---------------------------------------------------------------------------
create or replace function public.reclassify_investment(p_payload jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_company uuid := (p_payload->>'company_id')::uuid;
  v_inv     uuid := (p_payload->>'investor_id')::uuid;
  v_from    text := p_payload->>'from_kind';
  v_to      text := p_payload->>'to_kind';
  v_amt     numeric(18,2) := round((p_payload->>'amount')::numeric, 2);
  v_book    uuid; v_party uuid; v_name text;
  v_dr uuid; v_cr uuid;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if not public.company_has_right(v_company,'post_entry') then
    raise exception 'you do not have permission to reclassify funds';
  end if;
  if v_from = v_to then raise exception 'nothing to change'; end if;
  if v_amt <= 0 then raise exception 'amount must be greater than zero'; end if;

  select party_id, display_name into v_party, v_name
    from investors where id = v_inv and company_id = v_company;
  select id into v_book from books where company_id = v_company and kind = 'primary';

  v_dr := public.funding_account(v_company, v_inv, v_from);
  v_cr := public.funding_account(v_company, v_inv, v_to);

  return public.save_journal_entry(jsonb_build_object(
    'company_id', v_company, 'book_id', v_book,
    'voucher_type','journal',
    'entry_date', coalesce(nullif(p_payload->>'date','')::date, current_date),
    'narration', coalesce(nullif(trim(p_payload->>'narration'),''),
      'Reclassified ' || v_name || ' funds: ' || v_from || ' to ' || v_to),
    'party_id', v_party, 'status','posted',
    'lines', jsonb_build_array(
      jsonb_build_object('account_id', v_dr, 'debit',  v_amt, 'party_id', v_party),
      jsonb_build_object('account_id', v_cr, 'credit', v_amt, 'party_id', v_party))));
end; $$;

create or replace function public.funding_account(p_company uuid, p_investor uuid, p_kind text)
returns uuid language plpgsql stable security definer set search_path = public as $$
declare v uuid;
begin
  if p_kind = 'share_capital' then
    select capital_account_id into v from investors where id = p_investor;
  elsif p_kind = 'investor_loan' then
    select id into v from accounts where company_id = p_company and code = '2230';
  elsif p_kind = 'pending' then
    select id into v from accounts where company_id = p_company and code = '2240';
  end if;
  if v is null then raise exception 'no account for %', p_kind; end if;
  return v;
end; $$;

revoke all on function public.ensure_funding_accounts(uuid)  from public, anon, authenticated;
revoke all on function public.funding_account(uuid,uuid,text) from public, anon;
revoke all on function public.add_investor(jsonb)            from public, anon;
revoke all on function public.record_investment(jsonb)       from public, anon;
revoke all on function public.reclassify_investment(jsonb)   from public, anon;
grant execute on function public.add_investor(jsonb),
                         public.record_investment(jsonb),
                         public.reclassify_investment(jsonb),
                         public.funding_account(uuid,uuid,text) to authenticated;
