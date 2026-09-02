-- Paying a bill that lives in the internal book failed with "an internal-book
-- entry needs a reason", because pay_bill never supplied one.
--
-- Asking the owner to type a reason here would be the wrong fix: the payment is
-- internal for one reason only — the bill it settles is internal — and that
-- reason is already recorded on the bill. So the settlement inherits it.
-- A payment can no more be in a different book from its bill than it can be for
-- a different amount, so there is nothing here for a person to decide.
create or replace function public.pay_bill(p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid := (p_payload->>'company_id')::uuid;
  v_bill    uuid := (p_payload->>'bill_entry_id')::uuid;
  v_amt     numeric(18,2) := round((p_payload->>'amount')::numeric, 2);
  v_src     uuid := (p_payload->>'source_account_id')::uuid;
  v_book    uuid;
  v_party   uuid;
  v_payables uuid;
  v_out     numeric(18,2);
  v_entry   uuid;
  v_reason  text;
  v_kind    text;
  v_is_adv  boolean := coalesce((p_payload->>'from_advance')::boolean, false);
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if v_amt <= 0 then raise exception 'amount must be greater than zero'; end if;

  select book_id, party_id, adjustment_reason into v_book, v_party, v_reason
    from journal_entries where id = v_bill and company_id = v_company;
  if v_book is null then raise exception 'bill not found'; end if;

  select outstanding into v_out
    from public.open_bills(v_company, v_book) where entry_id = v_bill;
  if v_out is null then raise exception 'bill not found'; end if;
  if v_amt > v_out then
    raise exception 'that is more than the % still outstanding on this bill', v_out;
  end if;

  -- An internal-book settlement carries the bill's own reason. If the bill
  -- somehow has none, say plainly why this entry is internal rather than
  -- failing in front of the user.
  select kind into v_kind from books where id = v_book;
  if v_kind = 'adjustment' then
    v_reason := coalesce(nullif(trim(v_reason), ''), 'Settles a bill recorded in the internal book');
  else
    v_reason := null;
  end if;

  select id into v_payables from accounts
   where company_id = v_company and sub_group = 'Trade Payables' and not is_group
   order by code limit 1;

  v_entry := public.save_journal_entry(jsonb_build_object(
    'company_id', v_company, 'book_id', v_book,
    'voucher_type', case when v_is_adv then 'journal' else 'payment' end,
    'entry_date', coalesce(nullif(p_payload->>'date','')::date, current_date),
    'narration', coalesce(nullif(trim(p_payload->>'narration'),''),
                          case when v_is_adv then 'Advance set against bill'
                               else 'Payment against bill' end),
    'party_id', v_party,
    'payment_mode', nullif(p_payload->>'mode',''),
    'reference_no', nullif(p_payload->>'reference',''),
    'adjustment_reason', v_reason,
    'status','posted',
    'lines', jsonb_build_array(
      jsonb_build_object('account_id', v_payables, 'debit', v_amt, 'party_id', v_party),
      jsonb_build_object('account_id', v_src, 'credit', v_amt,
                         'party_id', case when v_is_adv then v_party else null end))));

  insert into bill_allocations (company_id, bill_entry_id, settling_entry_id, amount, created_by)
  values (v_company, v_bill, v_entry, v_amt, auth.uid());

  return v_entry;
end;
$$;

revoke all on function public.pay_bill(jsonb) from public, anon;
grant execute on function public.pay_bill(jsonb) to authenticated;
