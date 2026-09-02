-- Amending only the amount was too narrow. A wrong entry is just as often the
-- wrong date, the wrong narration, the wrong party, or money recorded against
-- the wrong account — and "cancel it and type the whole thing again" is not a
-- fix, it is a chore that invites a second mistake.
--
-- Still a cancel-and-repost underneath, so the history stays honest. What
-- changes is that the owner states the corrected version once, in one card.
create or replace function public.amend_entry(
  p_entry uuid,
  p_reason text,
  p_amount numeric,
  p_date date default null,
  p_narration text default null,
  p_debit_account uuid default null,
  p_credit_account uuid default null,
  p_party uuid default null,
  p_payment_mode text default null,
  p_reference text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  e journal_entries%rowtype;
  v_lines jsonb; v_new uuid; v_old numeric;
  v_dr uuid; v_cr uuid; v_dr_party uuid; v_cr_party uuid;
begin
  select * into e from journal_entries where id = p_entry;
  if e.id is null then raise exception 'Entry not found.'; end if;
  if e.status <> 'posted' then raise exception 'Only a posted entry can be changed.'; end if;
  if e.reversed_by_entry_id is not null then raise exception 'This entry has already been corrected.'; end if;
  if e.reverses_entry_id is not null then raise exception 'This entry is itself a correction. Change the original instead.'; end if;
  if coalesce(trim(p_reason),'') = '' then raise exception 'Say why this is changing.'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Enter the correct amount.'; end if;

  if (select count(*) from journal_lines where entry_id = p_entry) <> 2 then
    raise exception 'This entry has more than two lines, so there is no single amount to change. Use "the whole entry is wrong", then record it again.';
  end if;

  select sum(l.debit) into v_old from journal_lines l where l.entry_id = p_entry;

  -- what the entry says today, so anything left blank simply stays as it was
  select l.account_id, l.party_id into v_dr, v_dr_party
    from journal_lines l where l.entry_id = p_entry and l.debit > 0 limit 1;
  select l.account_id, l.party_id into v_cr, v_cr_party
    from journal_lines l where l.entry_id = p_entry and l.credit > 0 limit 1;

  v_dr := coalesce(p_debit_account, v_dr);
  v_cr := coalesce(p_credit_account, v_cr);
  if v_dr = v_cr then
    raise exception 'Money cannot come from and go to the same account.';
  end if;

  -- 1. cancel the original at its own value
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

  -- 2. post the corrected version
  v_new := public.save_journal_entry(jsonb_build_object(
    'company_id', e.company_id, 'book_id', e.book_id, 'voucher_type', e.voucher_type,
    'entry_date', coalesce(p_date, e.entry_date),
    'narration', coalesce(nullif(trim(p_narration),''), e.narration),
    'party_id', coalesce(p_party, e.party_id),
    'payment_mode', coalesce(nullif(trim(p_payment_mode),''), e.payment_mode),
    'reference_no', coalesce(nullif(trim(p_reference),''), e.reference_no),
    'proof_url', e.proof_url, 'due_date', e.due_date,
    'adjustment_reason', e.adjustment_reason, 'status', 'posted', 'source', 'system',
    'lines', jsonb_build_array(
      jsonb_build_object('account_id', v_dr, 'debit', p_amount,
                         'party_id', coalesce(p_party, v_dr_party)),
      jsonb_build_object('account_id', v_cr, 'credit', p_amount,
                         'party_id', coalesce(p_party, v_cr_party)))));

  insert into entry_audit_log (company_id, entry_id, action, reason, acted_by, acted_by_name, snapshot)
  values (e.company_id, e.id, 'amend',
          format('%s (was %s, now %s)', trim(p_reason), v_old, p_amount),
          auth.uid(), (select coalesce(full_name, email) from profiles where id = auth.uid()),
          public.snapshot_entry(e.id));

  update journal_entries set reversed_by_entry_id = v_new where id = p_entry;
  return v_new;
end;
$$;

-- What an entry says right now, so the edit card can open pre-filled with it.
create or replace function public.entry_detail(p_entry uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case when public.company_is_member(e.company_id) then jsonb_build_object(
    'id', e.id, 'voucher_no', e.voucher_no, 'voucher_type', e.voucher_type,
    'entry_date', e.entry_date, 'narration', e.narration, 'party_id', e.party_id,
    'payment_mode', e.payment_mode, 'reference_no', e.reference_no,
    'book_id', e.book_id, 'status', e.status,
    'lines', (select coalesce(jsonb_agg(jsonb_build_object(
                'account_id', l.account_id, 'account_name', a.name, 'account_code', a.code,
                'debit', l.debit, 'credit', l.credit, 'party_id', l.party_id)
              order by l.line_no), '[]'::jsonb)
              from journal_lines l join accounts a on a.id = l.account_id
             where l.entry_id = e.id)
  ) end
  from journal_entries e where e.id = p_entry;
$$;

revoke all on function public.amend_entry(uuid, text, numeric, date, text, uuid, uuid, uuid, text, text) from public, anon;
revoke all on function public.entry_detail(uuid) from public, anon;
grant execute on function public.amend_entry(uuid, text, numeric, date, text, uuid, uuid, uuid, text, text) to authenticated;
grant execute on function public.entry_detail(uuid) to authenticated;

-- The old five-argument version would otherwise sit alongside the new one and
-- make every call ambiguous.
drop function if exists public.amend_entry(uuid, text, numeric, date, text);
