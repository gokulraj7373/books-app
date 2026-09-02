-- ============================================================================
-- 0015 — Never let the bills list and the ledger disagree.
--
-- THE BUG THIS CLOSES
-- open_bills() computes what is settled from bill_allocations. But a payment or
-- an advance adjustment can be posted straight to the ledger without being tied
-- to a bill (the guided screens did exactly that). The ledger then said
-- 1,35,000 payable while the bills list said 1,75,000 — two screens, two
-- answers, no way for the owner to know which to believe.
--
-- The ledger is authoritative. A bill list is a VIEW over it. So rather than
-- silently reconciling, this surfaces the difference as an "unapplied credit",
-- which is exactly what Zoho and QuickBooks call it, and lets it be applied to
-- a specific bill.
-- ============================================================================

create or replace function public.unapplied_credits(p_company uuid, p_book uuid)
returns table (
  party_id uuid,
  party_name text,
  amount numeric(18,2))
language sql stable security definer set search_path = public as $$
  with scope as (select unnest(public.book_scope(p_book)) as book_id),
  -- every debit to payables = something that reduced what we owe
  settlements as (
    select l.party_id, e.id as entry_id, sum(l.base_debit) as amt
      from journal_lines l
      join journal_entries e on e.id = l.entry_id
      join accounts a on a.id = l.account_id
     where e.company_id = p_company
       and e.book_id in (select book_id from scope)
       and e.status = 'posted'
       and a.sub_group = 'Trade Payables'
       and l.base_debit > 0
       and l.party_id is not null
     group by l.party_id, e.id),
  allocated as (
    select settling_entry_id, sum(amount) as amt
      from bill_allocations where company_id = p_company
     group by settling_entry_id)
  select s.party_id, p.name,
         round(sum(s.amt - coalesce(al.amt, 0)), 2) as unapplied
    from settlements s
    join parties p on p.id = s.party_id
    left join allocated al on al.settling_entry_id = s.entry_id
   where public.company_is_member(p_company)
     and public.company_has_right(p_company,'view_ledger')
   group by s.party_id, p.name
  having round(sum(s.amt - coalesce(al.amt, 0)), 2) > 0
   order by p.name;
$$;

-- ---------------------------------------------------------------------------
-- apply_credit_to_bill — link an already-posted settlement to a specific bill.
-- Creates no new journal entry: the money already moved. It only records WHICH
-- bill it settled, which is what makes the bills list agree with the ledger.
-- ---------------------------------------------------------------------------
create or replace function public.apply_credit_to_bill(
  p_company uuid, p_settling_entry uuid, p_bill_entry uuid, p_amount numeric)
returns void
language plpgsql security definer set search_path = public as $$
declare v_out numeric(18,2); v_book uuid;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if not public.company_has_right(p_company, 'post_entry') then
    raise exception 'you do not have permission to apply credits';
  end if;

  select book_id into v_book from journal_entries
   where id = p_bill_entry and company_id = p_company;
  if v_book is null then raise exception 'bill not found'; end if;

  select outstanding into v_out from public.open_bills(p_company, v_book)
   where entry_id = p_bill_entry;
  if p_amount > v_out then
    raise exception 'that is more than the % still outstanding on this bill', v_out;
  end if;

  insert into bill_allocations (company_id, bill_entry_id, settling_entry_id, amount, created_by)
  values (p_company, p_bill_entry, p_settling_entry, round(p_amount,2), auth.uid())
  on conflict (bill_entry_id, settling_entry_id)
    do update set amount = excluded.amount;
end; $$;

revoke all on function public.unapplied_credits(uuid,uuid)                       from public, anon;
revoke all on function public.apply_credit_to_bill(uuid,uuid,uuid,numeric)       from public, anon;
grant execute on function public.unapplied_credits(uuid,uuid),
                         public.apply_credit_to_bill(uuid,uuid,uuid,numeric) to authenticated;
