-- amend_entry posts two vouchers: one that cancels the original, one that
-- replaces it. Only the replacement was linked back to the original via
-- reversed_by_entry_id — the cancelling voucher itself carried nothing but a
-- narration saying "Cancels X", so it read in every list as an unrelated
-- third entry. It is now linked the same way reverse_entry links its own
-- cancelling voucher: reverses_entry_id points at what it cancels.
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
  v_lines jsonb; v_cancel uuid; v_new uuid; v_old numeric;
  v_dr uuid; v_cr uuid; v_dr_party uuid; v_cr_party uuid;
begin
  select * into e from journal_entries where id = p_entry;
  if e.id is null then raise exception 'Entry not found.'; end if;
  if e.status <> 'posted' then raise exception 'Only a posted entry can be changed.'; end if;
  if e.reversed_by_entry_id is not null then raise exception 'This entry has already been corrected.'; end if;
  if e.reverses_entry_id is not null then raise exception 'This entry is itself a correction. Change the original instead.'; end if;
  if coalesce(trim(p_reason),'') = '' then raise exception 'Say why this is changing.'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Enter the correct amount.'; end if;

  if exists (select 1 from bill_allocations where bill_entry_id = p_entry or settling_entry_id = p_entry) then
    raise exception 'This entry is linked to a bill. Use "Start it again from scratch" instead, so the amount owed stays correct.';
  end if;

  if (select count(*) from journal_lines where entry_id = p_entry) <> 2 then
    raise exception 'This entry has more than two lines, so there is no single amount to change. Use "Start it again from scratch" instead.';
  end if;

  select sum(l.debit) into v_old from journal_lines l where l.entry_id = p_entry;

  select l.account_id, l.party_id into v_dr, v_dr_party
    from journal_lines l where l.entry_id = p_entry and l.debit > 0 limit 1;
  select l.account_id, l.party_id into v_cr, v_cr_party
    from journal_lines l where l.entry_id = p_entry and l.credit > 0 limit 1;

  v_dr := coalesce(p_debit_account, v_dr);
  v_cr := coalesce(p_credit_account, v_cr);
  if v_dr = v_cr then
    raise exception 'Money cannot come from and go to the same account.';
  end if;

  select jsonb_agg(jsonb_build_object(
           'account_id', l.account_id, 'debit', l.credit, 'credit', l.debit,
           'party_id', l.party_id, 'line_narration', l.line_narration) order by l.line_no)
    into v_lines from journal_lines l where l.entry_id = p_entry;

  v_cancel := public.save_journal_entry(jsonb_build_object(
    'company_id', e.company_id, 'book_id', e.book_id, 'voucher_type', e.voucher_type,
    'entry_date', greatest(current_date, e.entry_date),
    'narration', 'Cancels ' || e.voucher_no || ' - ' || trim(p_reason),
    'adjustment_reason', e.adjustment_reason, 'status', 'posted', 'source', 'system',
    'lines', v_lines));

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

  -- the cancelling voucher visibly points back at what it cancels
  update journal_entries set reverses_entry_id = p_entry where id = v_cancel;
  -- and the original points at its replacement, exactly as reverse_entry does
  update journal_entries set reversed_by_entry_id = v_new where id = p_entry;

  insert into entry_audit_log (company_id, entry_id, action, reason, acted_by, acted_by_name, snapshot)
  values (e.company_id, e.id, 'amend',
          format('%s (was %s, now %s)', trim(p_reason), v_old, p_amount),
          auth.uid(), (select coalesce(full_name, email) from profiles where id = auth.uid()),
          public.snapshot_entry(e.id));

  return v_new;
end;
$$;

revoke all on function public.amend_entry(uuid, text, numeric, date, text, uuid, uuid, uuid, text, text) from public, anon;
grant execute on function public.amend_entry(uuid, text, numeric, date, text, uuid, uuid, uuid, text, text) to authenticated;
