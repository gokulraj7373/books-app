-- 0033 renamed open_bills' output columns by accident while adding the
-- reversed-bill guard (id/entry_date/reference_no instead of the original
-- entry_id/bill_date/supplier_bill_no), which apply_credit_to_bill and the
-- client both depend on by name. Restoring the exact original shape.
drop function if exists public.open_bills(uuid, uuid);

create function public.open_bills(p_company uuid, p_book uuid)
returns table (
  entry_id uuid, voucher_no text, supplier_bill_no text, party_id uuid, party_name text,
  bill_date date, due_date date, payment_terms text,
  total numeric, settled numeric, outstanding numeric, days_overdue int,
  narration text
)
language sql
stable
security definer
set search_path = public
as $$
  with scope as (select unnest(public.book_scope(p_book)) as book_id),
  bills as (
    select e.id, e.voucher_no, e.reference_no, e.entry_date, e.due_date,
           e.payment_terms, e.narration, l.party_id,
           sum(l.base_credit) as total
      from journal_entries e
      join journal_lines l on l.entry_id = e.id
      join accounts a on a.id = l.account_id
     where e.company_id = p_company
       and e.book_id in (select book_id from scope)
       and e.status = 'posted'
       and e.reversed_by_entry_id is null   -- a corrected bill is closed; its replacement is a new entry
       and e.voucher_type = 'purchase'
       and a.sub_group = 'Trade Payables'
       and l.base_credit > 0
     group by e.id, e.voucher_no, e.reference_no, e.entry_date, e.due_date,
              e.payment_terms, e.narration, l.party_id)
  select b.id, b.voucher_no, b.reference_no, b.party_id, p.name,
         b.entry_date, b.due_date, b.payment_terms,
         round(b.total,2),
         round(coalesce(al.settled,0),2),
         round(b.total - coalesce(al.settled,0),2),
         case when b.due_date is null then 0
              else greatest(0, (current_date - b.due_date))::int end,
         b.narration
    from bills b
    left join parties p on p.id = b.party_id
    left join (select bill_entry_id, sum(amount) as settled
                 from bill_allocations group by bill_entry_id) al
           on al.bill_entry_id = b.id
   where public.company_is_member(p_company)
     and public.company_has_right(p_company,'view_ledger')
   order by (b.total - coalesce(al.settled,0)) > 0 desc, b.due_date nulls last, b.entry_date;
$$;

revoke all on function public.open_bills(uuid, uuid) from public, anon;
grant execute on function public.open_bills(uuid, uuid) to authenticated;
