alter table public.parties
  add column if not exists is_active boolean not null default true;

create table if not exists public.master_audit_log (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  object_type   text not null check (object_type in
                  ('account','party','investor','capital_project','opening_balance')),
  object_id     uuid not null,
  action        text not null check (action in
                  ('create','rename','update','deactivate','reactivate','merge','capitalize')),
  summary       text not null,
  before_state  jsonb,
  after_state   jsonb,
  acted_by      uuid references auth.users(id) on delete set null,
  acted_by_name text,
  acted_at      timestamptz not null default now()
);

create index if not exists master_audit_log_company_idx
  on public.master_audit_log (company_id, acted_at desc);

alter table public.master_audit_log enable row level security;

drop policy if exists master_audit_read on public.master_audit_log;
create policy master_audit_read on public.master_audit_log
  for select using (public.company_is_member(company_id));

grant select on public.master_audit_log to authenticated;

create or replace function public.log_master_change(
  p_company uuid, p_type text, p_id uuid, p_action text,
  p_summary text, p_before jsonb default null, p_after jsonb default null)
returns void
language sql
security definer
set search_path = public
as $$
  insert into master_audit_log (company_id, object_type, object_id, action,
                                summary, before_state, after_state,
                                acted_by, acted_by_name)
  values (p_company, p_type, p_id, p_action, p_summary, p_before, p_after,
          auth.uid(),
          (select coalesce(full_name, email) from profiles where id = auth.uid()));
$$;
revoke all on function public.log_master_change(uuid,text,uuid,text,text,jsonb,jsonb)
  from public, anon, authenticated;

create or replace function public.create_account(p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid := (p_payload->>'company_id')::uuid;
  v_code    text := nullif(trim(p_payload->>'code'), '');
  v_name    text := nullif(trim(regexp_replace(coalesce(p_payload->>'name',''), '\s+', ' ', 'g')), '');
  v_type    text := nullif(p_payload->>'account_type', '');
  v_sub     text := nullif(trim(p_payload->>'sub_group'), '');
  v_group   text := nullif(trim(p_payload->>'account_group'), '');
  v_nb      text := nullif(p_payload->>'normal_balance', '');
  v_capex   text := nullif(p_payload->>'capex_role', '');
  v_cash    boolean := coalesce((p_payload->>'is_bank_or_cash')::boolean, false);
  v_book    uuid := nullif(p_payload->>'restricted_to_book_id','')::uuid;
  v_id      uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  if not public.company_has_right(v_company, 'edit_coa') then
    raise exception 'Your role cannot change the chart of accounts.';
  end if;

  if v_code is null then raise exception 'Give the account a code.'; end if;
  if v_name is null then raise exception 'Give the account a name.'; end if;
  if v_type not in ('asset','liability','equity','income','expense') then
    raise exception 'Pick what kind of account this is.';
  end if;
  if v_sub is null then raise exception 'Choose where this account belongs in the reports.'; end if;

  if exists (select 1 from accounts where company_id = v_company and code = v_code) then
    raise exception 'Code % is already used by another account.', v_code;
  end if;
  if exists (select 1 from accounts
              where company_id = v_company and lower(trim(name)) = lower(v_name)) then
    raise exception 'An account called "%" already exists.', v_name;
  end if;

  if v_group is null then
    select a.account_group into v_group
      from accounts a
     where a.company_id = v_company and a.sub_group = v_sub
     limit 1;
  end if;

  if v_nb is null then
    v_nb := case when v_type in ('asset','expense') then 'D' else 'C' end;
  end if;
  if v_nb not in ('D','C') then raise exception 'normal_balance must be D or C.'; end if;

  if v_book is not null
     and not exists (select 1 from books where id = v_book and company_id = v_company) then
    raise exception 'That book does not belong to this company.';
  end if;

  insert into accounts (company_id, code, name, account_type, account_group, sub_group,
                        normal_balance, capex_role, is_bank_or_cash, is_active,
                        is_system, restricted_to_book_id)
  values (v_company, v_code, v_name, v_type, v_group, v_sub,
          v_nb, v_capex, v_cash, true, false, v_book)
  returning id into v_id;

  perform public.log_master_change(
    v_company, 'account', v_id, 'create',
    format('Added account %s %s', v_code, v_name),
    null,
    (select to_jsonb(a) from accounts a where a.id = v_id));

  return v_id;
end;
$$;

create or replace function public.update_account(p_account uuid, p_payload jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  a         accounts%rowtype;
  v_before  jsonb;
  v_name    text := nullif(trim(regexp_replace(coalesce(p_payload->>'name',''), '\s+', ' ', 'g')), '');
  v_active  boolean := (p_payload->>'is_active')::boolean;
  v_capex   text;
  v_bal     numeric(18,2);
  v_changes text[] := '{}';
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;

  select * into a from accounts where id = p_account;
  if a.id is null then raise exception 'Account not found.'; end if;
  if not public.company_has_right(a.company_id, 'edit_coa') then
    raise exception 'Your role cannot change the chart of accounts.';
  end if;
  if a.is_system then
    raise exception '"%" is one of the app''s built-in accounts and cannot be changed.', a.name;
  end if;

  v_before := to_jsonb(a);

  if v_name is not null and v_name <> a.name then
    if exists (select 1 from accounts
                where company_id = a.company_id and id <> a.id
                  and lower(trim(name)) = lower(v_name)) then
      raise exception 'An account called "%" already exists.', v_name;
    end if;
    v_changes := v_changes || format('renamed from "%s" to "%s"', a.name, v_name);
    update accounts set name = v_name where id = p_account;
  end if;

  if p_payload ? 'capex_role' then
    v_capex := nullif(p_payload->>'capex_role','');
    if v_capex is distinct from a.capex_role then
      v_changes := v_changes || format('capex role %s -> %s',
                                       coalesce(a.capex_role,'none'), coalesce(v_capex,'none'));
      update accounts set capex_role = v_capex where id = p_account;
    end if;
  end if;

  if v_active is not null and v_active <> a.is_active then
    if not v_active then
      select round(coalesce(a.opening_debit,0) - coalesce(a.opening_credit,0)
                   + coalesce(sum(l.base_debit - l.base_credit), 0), 2)
        into v_bal
        from journal_lines l
        join journal_entries e on e.id = l.entry_id
       where l.account_id = p_account and e.status = 'posted';

      if v_bal <> 0 then
        raise exception
          '"%" still holds a balance of %. Move it to another account with a journal entry first, then switch this one off.',
          a.name, to_char(abs(v_bal), 'FM99,99,99,990.00');
      end if;

      if exists (select 1 from journal_lines l
                  join journal_entries e on e.id = l.entry_id
                 where l.account_id = p_account and e.status = 'draft') then
        raise exception
          '"%" is used by a draft entry. Post or discard that draft first.', a.name;
      end if;
    end if;

    v_changes := v_changes || case when v_active then 'switched back on' else 'switched off' end;
    update accounts set is_active = v_active where id = p_account;
  end if;

  if array_length(v_changes, 1) is null then return; end if;

  perform public.log_master_change(
    a.company_id, 'account', p_account,
    case when v_active is not null and not v_active then 'deactivate'
         when v_active is not null and v_active then 'reactivate'
         when v_name is not null and v_name <> a.name then 'rename'
         else 'update' end,
    format('%s %s: %s', a.code, coalesce(v_name, a.name), array_to_string(v_changes, ', ')),
    v_before,
    (select to_jsonb(x) from accounts x where x.id = p_account));
end;
$$;

create or replace function public.update_party(p_party uuid, p_payload jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  p         parties%rowtype;
  v_before  jsonb;
  v_name    text := nullif(trim(regexp_replace(coalesce(p_payload->>'name',''), '\s+', ' ', 'g')), '');
  v_changes text[] := '{}';
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;

  select * into p from parties where id = p_party;
  if p.id is null then raise exception 'That name is not in your list.'; end if;
  if not public.company_has_right(p.company_id, 'edit_coa') then
    raise exception 'Your role cannot change party details.';
  end if;

  v_before := to_jsonb(p);

  if v_name is not null and v_name <> p.name then
    if exists (select 1 from parties
                where company_id = p.company_id and id <> p.id
                  and lower(trim(name)) = lower(v_name)) then
      raise exception '"%" already exists. Use Merge if they are the same person or business.', v_name;
    end if;
    v_changes := v_changes || format('renamed from "%s" to "%s"', p.name, v_name);
    update parties set name = v_name where id = p_party;
  end if;

  if p_payload ? 'party_type' then
    update parties set party_type = nullif(p_payload->>'party_type','') where id = p_party;
  end if;
  if p_payload ? 'gstin' then
    update parties set gstin = nullif(upper(trim(p_payload->>'gstin')),'') where id = p_party;
  end if;
  if p_payload ? 'pan' then
    update parties set pan = nullif(upper(trim(p_payload->>'pan')),'') where id = p_party;
  end if;
  if p_payload ? 'phone' then
    update parties set phone = nullif(trim(p_payload->>'phone'),'') where id = p_party;
  end if;
  if p_payload ? 'email' then
    update parties set email = nullif(trim(p_payload->>'email'),'') where id = p_party;
  end if;
  if p_payload ? 'notes' then
    update parties set notes = nullif(trim(p_payload->>'notes'),'') where id = p_party;
  end if;
  if p_payload ? 'is_related_party' then
    update parties set is_related_party = coalesce((p_payload->>'is_related_party')::boolean, false)
     where id = p_party;
  end if;
  if p_payload ? 'is_active' then
    update parties set is_active = coalesce((p_payload->>'is_active')::boolean, true)
     where id = p_party;
  end if;

  if (select to_jsonb(x) from parties x where x.id = p_party) = v_before then return; end if;

  perform public.log_master_change(
    p.company_id, 'party', p_party,
    case when array_length(v_changes,1) is not null then 'rename' else 'update' end,
    format('%s: %s', coalesce(v_name, p.name),
           case when array_length(v_changes,1) is not null
                then array_to_string(v_changes, ', ')
                else 'details updated' end),
    v_before,
    (select to_jsonb(x) from parties x where x.id = p_party));
end;
$$;

create or replace function public.block_lines_if_posted()
returns trigger language plpgsql set search_path = public as $$
declare v_status text;
begin
  select status into v_status from journal_entries
    where id = coalesce(new.entry_id, old.entry_id);

  if v_status in ('posted','reversed','void') then
    if tg_op = 'UPDATE'
       and coalesce(current_setting('app.party_merge', true), '') = 'on'
       and new.party_id is distinct from old.party_id
       and row(new.entry_id, new.line_no, new.account_id, new.debit, new.credit,
               new.currency, new.fx_rate, new.base_debit, new.base_credit,
               new.line_narration, new.capital_project_line_id,
               new.tax_code, new.hsn_sac, new.qty, new.unit)
           is not distinct from
           row(old.entry_id, old.line_no, old.account_id, old.debit, old.credit,
               old.currency, old.fx_rate, old.base_debit, old.base_credit,
               old.line_narration, old.capital_project_line_id,
               old.tax_code, old.hsn_sac, old.qty, old.unit)
    then
      return new;
    end if;
    raise exception 'lines of a posted entry are immutable; reverse it and re-enter';
  end if;
  return coalesce(new, old);
end; $$;

create or replace function public.block_if_posted()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if old.status in ('posted','reversed','void') then
      raise exception 'posted entry % cannot be deleted; reverse or void it instead', old.id;
    end if;
    return old;
  end if;

  if old.status in ('posted','reversed','void') then
    if coalesce(current_setting('app.party_merge', true), '') = 'on'
       and new.party_id is distinct from old.party_id
       and row(new.company_id, new.book_id, new.fiscal_year_id, new.voucher_no, new.voucher_type,
               new.entry_date, new.narration, new.payment_mode, new.reference_no,
               new.adjustment_reason, new.seq, new.prev_hash, new.hash, new.posted_by, new.posted_at)
           is not distinct from
           row(old.company_id, old.book_id, old.fiscal_year_id, old.voucher_no, old.voucher_type,
               old.entry_date, old.narration, old.payment_mode, old.reference_no,
               old.adjustment_reason, old.seq, old.prev_hash, old.hash, old.posted_by, old.posted_at)
    then
      return new;
    end if;

    if row(new.company_id, new.book_id, new.fiscal_year_id, new.voucher_no, new.voucher_type,
           new.entry_date, new.narration, new.party_id, new.payment_mode, new.reference_no,
           new.adjustment_reason, new.seq, new.prev_hash, new.hash, new.posted_by, new.posted_at)
       is distinct from
       row(old.company_id, old.book_id, old.fiscal_year_id, old.voucher_no, old.voucher_type,
           old.entry_date, old.narration, old.party_id, old.payment_mode, old.reference_no,
           old.adjustment_reason, old.seq, old.prev_hash, old.hash, old.posted_by, old.posted_at)
    then
      raise exception 'posted entry % is immutable; reverse it and re-enter', old.id;
    end if;
  end if;
  return new;
end; $$;

revoke all on function public.block_lines_if_posted() from public, anon, authenticated;
revoke all on function public.block_if_posted()       from public, anon, authenticated;

create or replace function public.merge_parties(
  p_company uuid, p_keep uuid, p_merge uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  k parties%rowtype;
  m parties%rowtype;
  v_lines int; v_entries int;
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  if not public.company_has_right(p_company, 'edit_coa') then
    raise exception 'Your role cannot merge parties.';
  end if;
  if p_keep = p_merge then raise exception 'Those are the same name.'; end if;

  select * into k from parties where id = p_keep  and company_id = p_company;
  select * into m from parties where id = p_merge and company_id = p_company;
  if k.id is null or m.id is null then raise exception 'One of those names is not in your list.'; end if;

  if (select count(*) from investors i
       where i.company_id = p_company and i.party_id in (p_keep, p_merge)) > 1 then
    raise exception 'Both of those are investors. Merging investor records changes who owns what — do that on the Investors screen.';
  end if;

  perform set_config('app.party_merge', 'on', true);

  update journal_lines l
     set party_id = p_keep
    from journal_entries e
   where e.id = l.entry_id and e.company_id = p_company and l.party_id = p_merge;
  get diagnostics v_lines = row_count;

  update journal_entries
     set party_id = p_keep
   where company_id = p_company and party_id = p_merge;
  get diagnostics v_entries = row_count;

  update investors set party_id = p_keep
   where company_id = p_company and party_id = p_merge;

  perform set_config('app.party_merge', 'off', true);

  update parties set
    gstin            = coalesce(k.gstin, m.gstin),
    pan              = coalesce(k.pan, m.pan),
    phone            = coalesce(k.phone, m.phone),
    email            = coalesce(k.email, m.email),
    party_type       = coalesce(k.party_type, m.party_type),
    is_related_party = k.is_related_party or m.is_related_party,
    notes            = nullif(concat_ws(E'\n', k.notes, m.notes), '')
   where id = p_keep;

  delete from parties where id = p_merge;

  perform public.log_master_change(
    p_company, 'party', p_keep, 'merge',
    format('Merged "%s" into "%s" — %s entries and %s lines re-tagged.%s',
           m.name, k.name, v_entries, v_lines,
           case when coalesce(trim(p_reason),'') = '' then ''
                else ' Reason: ' || trim(p_reason) end),
    to_jsonb(m), to_jsonb(k));

  return jsonb_build_object('kept', p_keep, 'lines_moved', v_lines, 'entries_moved', v_entries);
end;
$$;

create or replace function public.possible_duplicate_parties(p_company uuid, p_name text)
returns table (id uuid, name text, party_type text, entry_count bigint)
language sql
stable
security definer
set search_path = public
as $$
  with target as (
    select regexp_replace(lower(coalesce(p_name,'')), '[^a-z0-9]', '', 'g') as key
  )
  select p.id, p.name, p.party_type,
         (select count(*) from journal_lines l where l.party_id = p.id)
    from parties p, target t
   where p.company_id = p_company
     and public.company_is_member(p_company)
     and t.key <> ''
     and (regexp_replace(lower(p.name), '[^a-z0-9]', '', 'g') = t.key
       or regexp_replace(lower(p.name), '[^a-z0-9]', '', 'g') like t.key || '%'
       or t.key like regexp_replace(lower(p.name), '[^a-z0-9]', '', 'g') || '%')
   order by p.name
   limit 8;
$$;

revoke all on function public.create_account(jsonb)                      from public, anon;
revoke all on function public.update_account(uuid, jsonb)                from public, anon;
revoke all on function public.update_party(uuid, jsonb)                  from public, anon;
revoke all on function public.merge_parties(uuid, uuid, uuid, text)      from public, anon;
revoke all on function public.possible_duplicate_parties(uuid, text)     from public, anon;

grant execute on function public.create_account(jsonb)                   to authenticated;
grant execute on function public.update_account(uuid, jsonb)             to authenticated;
grant execute on function public.update_party(uuid, jsonb)               to authenticated;
grant execute on function public.merge_parties(uuid, uuid, uuid, text)   to authenticated;
grant execute on function public.possible_duplicate_parties(uuid, text)  to authenticated;
