-- `source` is constrained to a fixed list; 'amend' was not on it. The corrected
-- entry is produced by the system on the owner's instruction, so 'system' is
-- the honest value — and the amendment itself is already recorded in
-- entry_audit_log, which is where that history belongs.
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

  if (select count(*) from journal_lines where entry_id = p_entry) <> 2 then
    raise exception 'This entry has more than two lines, so there is no single amount to change. Use Correct, then record it again.';
  end if;

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
    'adjustment_reason', e.adjustment_reason, 'status', 'posted', 'source', 'system',
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

revoke all on function public.amend_entry(uuid, text, numeric, date, text) from public, anon;
grant execute on function public.amend_entry(uuid, text, numeric, date, text) to authenticated;
