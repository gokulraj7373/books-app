-- ============================================================================
-- 0019 — Let the internal book hold its own cash, without weakening the rule.
--
-- THE PROBLEM FOUND IN USE
-- An investor hands over 2,00,000 in cash that is deliberately not going into
-- the official books. Recording it hit "a management-book entry cannot touch a
-- bank or cash account" and failed at submit.
--
-- The rule itself is right, but it was too broad. Its real purpose is that the
-- STATUTORY cash and bank balances must reconcile to a real bank statement —
-- third-party evidence you cannot argue with. An internal cash box has no bank
-- statement to reconcile against, so it does not threaten that at all.
--
-- So: an account may be restricted to one book. An account restricted to the
-- internal book is invisible to the statutory book and excluded from statutory
-- reconciliation, and the management book may use it freely. A statutory
-- cash/bank account remains off-limits to management entries, exactly as before.
-- ============================================================================

alter table accounts
  add column if not exists restricted_to_book_id uuid references books(id) on delete set null;

comment on column accounts.restricted_to_book_id is
  'When set, this account may only be used in that book. Used for internal-only '
  'cash, which must never appear in statutory reconciliation.';

create index if not exists accounts_restricted_idx
  on accounts (restricted_to_book_id) where restricted_to_book_id is not null;

-- give every existing company an internal cash box
create or replace function public.ensure_internal_cash(p_company uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_mgmt uuid;
begin
  select id into v_mgmt from books where company_id = p_company and kind = 'adjustment';
  if v_mgmt is null then return; end if;

  insert into accounts (company_id, code, name, account_type, account_group, sub_group,
                        normal_balance, is_bank_or_cash, is_system, restricted_to_book_id)
  values (p_company, '1090', 'Cash in Hand (internal only)', 'asset', 'Current Assets',
          'Cash & Bank', 'D', true, true, v_mgmt)
  on conflict (company_id, code) do update
     set restricted_to_book_id = excluded.restricted_to_book_id;
end; $$;

do $$
declare c record;
begin
  for c in select id from companies loop
    perform public.ensure_internal_cash(c.id);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- save_journal_entry: the refined two-book rule, plus book restriction.
-- ---------------------------------------------------------------------------
create or replace function public.save_journal_entry(p_payload jsonb)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_company    uuid := (p_payload->>'company_id')::uuid;
  v_book       uuid := (p_payload->>'book_id')::uuid;
  v_type       text := p_payload->>'voucher_type';
  v_date       date := (p_payload->>'entry_date')::date;
  v_status     text := coalesce(p_payload->>'status', 'posted');
  v_idem       text := nullif(p_payload->>'idempotency_key','');
  v_book_kind  text;
  v_fy         uuid;
  v_fy_status  text;
  v_locked     date;
  v_role       text;
  v_entry      uuid;
  v_line       jsonb;
  v_no         text;
  v_seq        bigint;
  v_prev       bytea;
  v_canon      text;
  v_debit      numeric(18,2) := 0;
  v_credit     numeric(18,2) := 0;
  v_n          int := 0;
  v_existing   uuid;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if v_company is null or v_book is null then raise exception 'company_id and book_id are required'; end if;
  if v_status not in ('draft','posted') then raise exception 'status must be draft or posted'; end if;

  if v_idem is not null then
    select id into v_existing from journal_entries
      where company_id = v_company and idempotency_key = v_idem;
    if v_existing is not null then return v_existing; end if;
  end if;

  if not public.company_is_member(v_company) then
    raise exception 'not a member of this company';
  end if;
  if v_status = 'posted' and not public.company_has_right(v_company, 'post_entry') then
    raise exception 'you do not have permission to post entries';
  end if;
  if v_status = 'draft' and not (public.company_has_right(v_company, 'draft_entry')
                                 or public.company_has_right(v_company, 'post_entry')) then
    raise exception 'you do not have permission to create entries';
  end if;

  v_role := public.company_role(v_company);
  if v_role = 'cashier' and v_type not in ('receipt','payment','contra') then
    raise exception 'cashiers may only create receipt, payment or contra vouchers';
  end if;

  select kind into v_book_kind from books where id = v_book and company_id = v_company;
  if v_book_kind is null then raise exception 'book does not belong to this company'; end if;

  select id, status into v_fy, v_fy_status from fiscal_years
    where company_id = v_company and period @> v_date;
  if v_fy is null then
    raise exception 'no financial year covers %. Add one in Settings first.', v_date;
  end if;
  if v_fy_status = 'closed' then
    raise exception 'the financial year is closed, so entries dated % are not allowed', v_date;
  end if;

  select locked_through into v_locked from period_locks
    where company_id = v_company and book_id = v_book;
  if v_locked is not null and v_date <= v_locked
     and not public.company_has_right(v_company, 'unlock_period') then
    raise exception 'the books are locked up to %, so nothing dated on or before that can be changed', v_locked;
  end if;

  if v_book_kind = 'adjustment'
     and coalesce(trim(p_payload->>'adjustment_reason'),'') = '' then
    raise exception 'an internal-book entry needs a reason';
  end if;

  insert into journal_entries (
    company_id, book_id, fiscal_year_id, voucher_no, voucher_type, entry_date,
    narration, party_id, payment_mode, reference_no, proof_url, status,
    adjustment_reason, source, idempotency_key, due_date, payment_terms, created_by)
  values (
    v_company, v_book, v_fy, 'PENDING-' || gen_random_uuid()::text, v_type, v_date,
    p_payload->>'narration',
    nullif(p_payload->>'party_id','')::uuid,
    nullif(p_payload->>'payment_mode',''),
    nullif(p_payload->>'reference_no',''),
    nullif(p_payload->>'proof_url',''),
    'draft',
    nullif(trim(p_payload->>'adjustment_reason'),''),
    coalesce(p_payload->>'source','manual'),
    v_idem,
    nullif(p_payload->>'due_date','')::date,
    nullif(p_payload->>'payment_terms',''),
    auth.uid())
  returning id into v_entry;

  for v_line in select * from jsonb_array_elements(p_payload->'lines') loop
    v_n := v_n + 1;
    declare
      v_acct     uuid := (v_line->>'account_id')::uuid;
      v_d        numeric(18,2) := round(coalesce((v_line->>'debit')::numeric, 0), 2);
      v_c        numeric(18,2) := round(coalesce((v_line->>'credit')::numeric, 0), 2);
      v_fx       numeric(18,8) := coalesce((v_line->>'fx_rate')::numeric, 1);
      v_is_group boolean;
      v_is_cash  boolean;
      v_acct_co  uuid;
      v_active   boolean;
      v_restrict uuid;
      v_acct_nm  text;
    begin
      select company_id, is_group, is_bank_or_cash, is_active, restricted_to_book_id, name
        into v_acct_co, v_is_group, v_is_cash, v_active, v_restrict, v_acct_nm
        from accounts where id = v_acct;

      if v_acct_co is null or v_acct_co <> v_company then
        raise exception 'the account on line % does not belong to this company', v_n;
      end if;
      if v_is_group then
        raise exception '"%" is a heading, not an account you can post to', v_acct_nm;
      end if;
      if not v_active then
        raise exception '"%" is no longer in use', v_acct_nm;
      end if;

      -- an account tied to one book may not be used in another
      if v_restrict is not null and v_restrict <> v_book then
        raise exception '"%" can only be used in its own book', v_acct_nm;
      end if;

      -- ===== THE TWO-BOOK RULE =====
      -- Statutory cash and bank must reconcile to a real bank statement, so an
      -- internal entry may not touch them. An account restricted to the internal
      -- book has no statement to reconcile against, so it is allowed.
      if v_book_kind = 'adjustment' and v_is_cash and v_restrict is distinct from v_book then
        raise exception
          '"%" is an official bank or cash account, so it cannot be used in an internal-only entry. Money that went through the company''s own bank or cash has to appear in the official books, because the bank statement has to match. Use "Cash in Hand (internal only)" instead, or untick "keep this out of the official books".', v_acct_nm;
      end if;

      insert into journal_lines (
        entry_id, line_no, account_id, debit, credit, currency, fx_rate,
        base_debit, base_credit, party_id, line_narration, capital_project_line_id,
        qty, unit, hsn_sac)
      values (
        v_entry, v_n, v_acct, v_d, v_c,
        coalesce(v_line->>'currency','INR'), v_fx,
        round(v_d * v_fx, 2), round(v_c * v_fx, 2),
        nullif(v_line->>'party_id','')::uuid,
        nullif(v_line->>'line_narration',''),
        nullif(v_line->>'capital_project_line_id','')::uuid,
        nullif(v_line->>'qty','')::numeric,
        nullif(v_line->>'unit',''),
        nullif(v_line->>'hsn_sac',''));

      v_debit  := v_debit  + round(v_d * v_fx, 2);
      v_credit := v_credit + round(v_c * v_fx, 2);
    end;
  end loop;

  if v_status = 'posted' then
    if v_n < 2 then raise exception 'an entry needs at least two sides'; end if;
    if v_debit <> v_credit then
      raise exception 'the two sides do not match: % against %', v_debit, v_credit;
    end if;

    perform pg_advisory_xact_lock(hashtext(v_company::text || v_book::text)::bigint);

    insert into voucher_series (company_id, book_id, voucher_type, prefix, next_number)
      values (v_company, v_book, v_type, upper(substr(v_type,1,2)), 1)
      on conflict (company_id, book_id, voucher_type) do nothing;

    update voucher_series
       set next_number = next_number + 1
     where company_id = v_company and book_id = v_book and voucher_type = v_type
    returning prefix || '-' || lpad((next_number - 1)::text, width, '0') into v_no;

    select coalesce(max(seq), 0) + 1 into v_seq
      from journal_entries where company_id = v_company and book_id = v_book;
    select hash into v_prev
      from journal_entries
     where company_id = v_company and book_id = v_book and seq = v_seq - 1;
    v_prev := coalesce(v_prev, decode(repeat('00', 32), 'hex'));

    select string_agg(
             l.line_no || ':' || l.account_id || ':' || l.base_debit || ':' || l.base_credit,
             '|' order by l.line_no)
      into v_canon
      from journal_lines l where l.entry_id = v_entry;

    update journal_entries
       set voucher_no = v_no, status = 'posted', seq = v_seq, prev_hash = v_prev,
           hash = extensions.digest(v_prev ||
                    convert_to(v_company::text || v_book::text || v_no ||
                               v_date::text || coalesce(v_canon,''), 'UTF8'), 'sha256'),
           posted_by = auth.uid(), posted_at = now()
     where id = v_entry;
  else
    update journal_entries
       set voucher_no = 'DRAFT-' || substr(v_entry::text, 1, 8)
     where id = v_entry;
  end if;

  return v_entry;
end; $$;

-- keep new companies supplied with an internal cash box
create or replace function public.create_company(p_payload jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_co uuid;
begin
  v_co := public.create_company_base(p_payload);
  perform public.ensure_internal_cash(v_co);
  return v_co;
end; $$;

grant execute on function public.save_journal_entry(jsonb) to authenticated;
revoke all on function public.ensure_internal_cash(uuid) from public, anon, authenticated;
