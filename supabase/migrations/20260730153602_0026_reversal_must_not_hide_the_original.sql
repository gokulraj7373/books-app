create or replace function public.reverse_entry(p_entry uuid, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  e        journal_entries%rowtype;
  v_new    uuid;
  v_lines  jsonb;
begin
  select * into e from journal_entries where id = p_entry;
  if e.id is null then raise exception 'entry not found'; end if;
  if e.status <> 'posted' then raise exception 'only a posted entry can be reversed'; end if;
  if not public.company_has_right(e.company_id, 'reverse_entry') then
    raise exception 'you do not have permission to reverse entries';
  end if;
  if e.reversed_by_entry_id is not null then raise exception 'entry is already reversed'; end if;
  if e.reverses_entry_id is not null then
    raise exception 'this entry is itself a correction. Correct the original voucher instead.';
  end if;

  select jsonb_agg(jsonb_build_object(
           'account_id', l.account_id,
           'debit',      l.credit,
           'credit',     l.debit,
           'party_id',   l.party_id,
           'line_narration', l.line_narration)
         order by l.line_no)
    into v_lines from journal_lines l where l.entry_id = p_entry;

  v_new := public.save_journal_entry(jsonb_build_object(
    'company_id', e.company_id,
    'book_id',    e.book_id,
    'voucher_type', e.voucher_type,
    'entry_date', greatest(current_date, e.entry_date),
    'narration',  'Reversal of ' || e.voucher_no || ' - ' || coalesce(p_reason,'no reason given'),
    'adjustment_reason', e.adjustment_reason,
    'status',     'posted',
    'source',     'system',
    'lines',      v_lines));

  update journal_entries set reverses_entry_id = p_entry where id = v_new;
  update journal_entries set reversed_by_entry_id = v_new where id = p_entry;
  return v_new;
end;
$$;

revoke all on function public.reverse_entry(uuid, text) from public, anon;
grant execute on function public.reverse_entry(uuid, text) to authenticated;

update journal_entries
   set status = 'posted'
 where status = 'reversed'
   and reversed_by_entry_id is not null;
