-- ============================================================================
-- 0027  A real PIN, and two honest ways to fix a wrong entry.
--
-- WHY THE PIN MOVED TO THE SERVER
-- It used to live in the browser. That made it per-browser (set it on one URL
-- and another does not know about it), it vanished when the cache was cleared,
-- and — fatally — a PIN checked in the browser cannot protect anything, since
-- the API call it is supposed to guard can simply be made directly. Now the
-- PIN belongs to the user, is stored only as a bcrypt hash, and is verified
-- inside the same function that performs the protected action.
--
-- WHAT REPLACES "DELETE"
--   amend_entry  - change a wrong amount. Reverses the original and posts the
--                  corrected version in one transaction, linked together. To
--                  the owner it behaves like editing; to an auditor it reads
--                  as a correction, which is what it is.
--   void_entry   - take an entry out of every report entirely. Needs the PIN.
--                  The row is kept, marked void, with a full copy of what it
--                  said, who voided it, when and why.
--
-- Neither erases history. Companies (Accounts) Rules require accounting
-- software used by a company to keep an audit trail of every change, with the
-- date, and to make that trail impossible to switch off. A silent delete would
-- put the company's own auditor in the position of having to report it.
-- ============================================================================

create table if not exists public.user_pins (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  pin_hash     text not null,
  updated_at   timestamptz not null default now(),
  failed_count int not null default 0,
  locked_until timestamptz
);

alter table public.user_pins enable row level security;
-- No policies at all: the table is reachable only through the functions below.
-- A readable hash is a hash someone can attack offline.

create or replace function public.set_user_pin(p_pin text, p_current text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_existing text;
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  if p_pin !~ '^\d{4,8}$' then raise exception 'The PIN must be 4 to 8 digits.'; end if;

  select pin_hash into v_existing from user_pins where user_id = auth.uid();
  -- Changing a PIN needs the old one, or it is not a lock.
  if v_existing is not null then
    if p_current is null or extensions.crypt(p_current, v_existing) <> v_existing then
      raise exception 'Your current PIN is not right.';
    end if;
  end if;

  insert into user_pins (user_id, pin_hash, updated_at, failed_count, locked_until)
  values (auth.uid(), extensions.crypt(p_pin, extensions.gen_salt('bf', 10)), now(), 0, null)
  on conflict (user_id) do update
    set pin_hash = excluded.pin_hash, updated_at = now(), failed_count = 0, locked_until = null;
end;
$$;

create or replace function public.clear_user_pin(p_current text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_existing text;
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  select pin_hash into v_existing from user_pins where user_id = auth.uid();
  if v_existing is null then return; end if;
  if extensions.crypt(p_current, v_existing) <> v_existing then
    raise exception 'That PIN is not right.';
  end if;
  delete from user_pins where user_id = auth.uid();
end;
$$;

create or replace function public.has_user_pin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$ select exists (select 1 from user_pins where user_id = auth.uid()); $$;

-- Shared by every protected action. Counts failures and locks out after five,
-- so a four-digit PIN cannot simply be guessed by a script.
create or replace function public.check_pin(p_pin text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare r user_pins%rowtype;
begin
  select * into r from user_pins where user_id = auth.uid();
  if r.user_id is null then return true; end if;  -- no PIN set: nothing to check
  if r.locked_until is not null and r.locked_until > now() then
    raise exception 'Too many wrong PINs. Try again after %',
      to_char(r.locked_until, 'HH24:MI');
  end if;

  if extensions.crypt(p_pin, r.pin_hash) = r.pin_hash then
    update user_pins set failed_count = 0, locked_until = null where user_id = auth.uid();
    return true;
  end if;

  update user_pins
     set failed_count = failed_count + 1,
         locked_until = case when failed_count + 1 >= 5 then now() + interval '15 minutes' end
   where user_id = auth.uid();
  return false;
end;
$$;

-- ----------------------------------------------------------------------------
-- The permanent record of anything taken out of the books.
-- ----------------------------------------------------------------------------
create table if not exists public.entry_audit_log (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  entry_id    uuid not null,
  action      text not null check (action in ('void','amend')),
  reason      text not null,
  acted_by    uuid references auth.users(id) on delete set null,
  acted_by_name text,
  acted_at    timestamptz not null default now(),
  snapshot    jsonb not null            -- exactly what the entry said beforehand
);

create index if not exists entry_audit_log_company_idx
  on public.entry_audit_log (company_id, acted_at desc);

alter table public.entry_audit_log enable row level security;

drop policy if exists entry_audit_read on public.entry_audit_log;
create policy entry_audit_read on public.entry_audit_log
  for select using (public.company_is_member(company_id));
-- Deliberately no insert, update or delete policy. Only the functions write
-- here, and nothing removes a row — that is the whole point of the table.

create or replace function public.snapshot_entry(p_entry uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'entry', to_jsonb(e),
    'lines', (select coalesce(jsonb_agg(jsonb_build_object(
                       'account_id', l.account_id, 'account', a.name,
                       'debit', l.debit, 'credit', l.credit,
                       'party_id', l.party_id, 'line_narration', l.line_narration)
                     order by l.line_no), '[]'::jsonb)
                from journal_lines l join accounts a on a.id = l.account_id
               where l.entry_id = e.id))
    from journal_entries e where e.id = p_entry;
$$;

-- ----------------------------------------------------------------------------
-- Void: out of every report, still on the record.
-- ----------------------------------------------------------------------------
create or replace function public.void_entry(p_entry uuid, p_reason text, p_pin text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare e journal_entries%rowtype; v_locked date;
begin
  select * into e from journal_entries where id = p_entry;
  if e.id is null then raise exception 'Entry not found.'; end if;
  if not public.company_has_right(e.company_id, 'reverse_entry') then
    raise exception 'Your role cannot remove entries.';
  end if;
  if coalesce(trim(p_reason),'') = '' then
    raise exception 'Say why this is being removed. It goes on the record.';
  end if;
  if not public.check_pin(p_pin) then
    raise exception 'That PIN is not right.';
  end if;
  if e.status = 'void' then raise exception 'This entry is already removed.'; end if;
  if e.reversed_by_entry_id is not null then
    raise exception 'This entry has already been corrected by another one.';
  end if;

  select locked_through into v_locked from period_locks
   where company_id = e.company_id and book_id = e.book_id;
  if v_locked is not null and e.entry_date <= v_locked then
    raise exception 'That period is closed. Ask an owner to reopen it first.';
  end if;

  insert into entry_audit_log (company_id, entry_id, action, reason, acted_by, acted_by_name, snapshot)
  values (e.company_id, e.id, 'void', trim(p_reason), auth.uid(),
          (select coalesce(full_name, email) from profiles where id = auth.uid()),
          public.snapshot_entry(e.id));

  update journal_entries set status = 'void' where id = p_entry;
end;
$$;

-- ----------------------------------------------------------------------------
-- Amend: change a wrong amount without pretending it never happened.
-- ----------------------------------------------------------------------------
create or replace function public.amend_entry(
  p_entry uuid, p_reason text, p_amount numeric,
  p_date date default null, p_narration text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  e journal_entries%rowtype; v_lines jsonb; v_new uuid; v_old numeric;
begin
  select * into e from journal_entries where id = p_entry;
  if e.id is null then raise exception 'Entry not found.'; end if;
  if e.status <> 'posted' then raise exception 'Only a posted entry can be changed.'; end if;
  if e.reversed_by_entry_id is not null then raise exception 'This entry has already been corrected.'; end if;
  if e.reverses_entry_id is not null then raise exception 'This entry is itself a correction. Change the original instead.'; end if;
  if coalesce(trim(p_reason),'') = '' then raise exception 'Say why the amount is changing.'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Enter the correct amount.'; end if;

  select sum(l.debit) into v_old from journal_lines l where l.entry_id = p_entry;
  if v_old is null or v_old = 0 then raise exception 'This entry has no amount to change.'; end if;

  -- Amending is only offered on a simple two-sided entry, where "the amount"
  -- is unambiguous. A split entry has several amounts and no single one to
  -- change; correcting and re-entering it is the honest route.
  if (select count(*) from journal_lines where entry_id = p_entry) <> 2 then
    raise exception 'This entry has more than two lines, so there is no single amount to change. Use Correct, then record it again.';
  end if;

  -- 1. cancel the original, at its own value
  select jsonb_agg(jsonb_build_object(
           'account_id', l.account_id, 'debit', l.credit, 'credit', l.debit,
           'party_id', l.party_id, 'line_narration', l.line_narration) order by l.line_no)
    into v_lines from journal_lines l where l.entry_id = p_entry;

  perform public.save_journal_entry(jsonb_build_object(
    'company_id', e.company_id, 'book_id', e.book_id, 'voucher_type', e.voucher_type,
    'entry_date', greatest(current_date, e.entry_date),
    'narration', 'Cancels ' || e.voucher_no || ' - ' || trim(p_reason),
    'adjustment_reason', e.adjustment_reason, 'status', 'posted', 'source', 'system',
    'lines', v_lines));

  -- 2. post the corrected version, same accounts, new amount
  select jsonb_agg(jsonb_build_object(
           'account_id', l.account_id,
           'debit',  case when l.debit  > 0 then p_amount else 0 end,
           'credit', case when l.credit > 0 then p_amount else 0 end,
           'party_id', l.party_id, 'line_narration', l.line_narration) order by l.line_no)
    into v_lines from journal_lines l where l.entry_id = p_entry;

  v_new := public.save_journal_entry(jsonb_build_object(
    'company_id', e.company_id, 'book_id', e.book_id, 'voucher_type', e.voucher_type,
    'entry_date', coalesce(p_date, e.entry_date),
    'narration', coalesce(nullif(trim(p_narration),''), e.narration),
    'party_id', e.party_id, 'payment_mode', e.payment_mode, 'reference_no', e.reference_no,
    'proof_url', e.proof_url, 'due_date', e.due_date,
    'adjustment_reason', e.adjustment_reason, 'status', 'posted', 'source', 'amend',
    'lines', v_lines));

  insert into entry_audit_log (company_id, entry_id, action, reason, acted_by, acted_by_name, snapshot)
  values (e.company_id, e.id, 'amend',
          format('%s (was %s, now %s)', trim(p_reason), v_old, p_amount),
          auth.uid(), (select coalesce(full_name, email) from profiles where id = auth.uid()),
          public.snapshot_entry(e.id));

  update journal_entries set reversed_by_entry_id = v_new where id = p_entry;
  return v_new;
end;
$$;

revoke all on function public.set_user_pin(text, text) from public, anon;
revoke all on function public.clear_user_pin(text) from public, anon;
revoke all on function public.has_user_pin() from public, anon;
revoke all on function public.check_pin(text) from public, anon;
revoke all on function public.snapshot_entry(uuid) from public, anon;
revoke all on function public.void_entry(uuid, text, text) from public, anon;
revoke all on function public.amend_entry(uuid, text, numeric, date, text) from public, anon;

grant execute on function public.set_user_pin(text, text) to authenticated;
grant execute on function public.clear_user_pin(text) to authenticated;
grant execute on function public.has_user_pin() to authenticated;
grant execute on function public.void_entry(uuid, text, text) to authenticated;
grant execute on function public.amend_entry(uuid, text, numeric, date, text) to authenticated;
-- check_pin and snapshot_entry stay internal: they are building blocks, not
-- actions, and an exposed check_pin is an oracle for guessing the PIN.
