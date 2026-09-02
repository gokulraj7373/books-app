-- ============================================================================
-- 0012 — Credit bills and payables.
--
-- WHY THIS IS A CORRECTNESS FIX, NOT A FEATURE
-- Until now the app could only record "I paid money". It could not record
-- "I owe money". A business with unpaid supplier bills therefore had a balance
-- sheet that UNDERSTATED its liabilities and overstated its net worth — which is
-- materially misleading to an investor or a CA. A payable is not optional.
--
-- WHAT IS DELIBERATELY NOT HERE
-- Quotations and purchase orders. They are non-posting documents in every
-- serious system (Sage, Dynamics, QuickBooks, Xero): nothing touches the ledger
-- until a bill exists. Modelling them here would add a large amount of surface
-- area for zero accounting value.
--
-- The real-world chain this supports:
--   quote (outside the books) -> advance paid -> bill received -> advance
--   adjusted -> balance paid -> asset owned
-- ============================================================================

alter table journal_entries
  add column if not exists due_date date;

comment on column journal_entries.due_date is
  'For a credit bill: when payment is due. Null for immediate transactions.';

create index if not exists je_due_date_idx
  on journal_entries (company_id, due_date)
  where due_date is not null;

-- ---------------------------------------------------------------------------
-- payables_ageing — who we owe, how much, and how urgently.
--
-- HONEST LIMITATION: this ages by PARTY, not bill-by-bill. Matching each
-- payment to a specific bill needs an allocation table, which is a bigger piece
-- of work and only pays off once there are many part-paid bills. The party
-- balance is exact; the "oldest due date" is the earliest unpaid bill's date,
-- which is the right thing to chase first.
-- ---------------------------------------------------------------------------
create or replace function public.payables_ageing(p_company uuid, p_book uuid)
returns table (
  party_id uuid,
  party_name text,
  owed numeric(18,2),
  oldest_due date,
  days_overdue int,
  bill_count bigint)
language sql stable security definer set search_path = public as $$
  with scope as (select unnest(public.book_scope(p_book)) as book_id),
  payable_lines as (
    select l.party_id, l.base_debit, l.base_credit, e.due_date, e.id as entry_id
      from journal_lines l
      join journal_entries e on e.id = l.entry_id
      join accounts a on a.id = l.account_id
     where e.company_id = p_company
       and e.book_id in (select book_id from scope)
       and e.status = 'posted'
       and a.sub_group = 'Trade Payables'
       and l.party_id is not null)
  select p.id,
         p.name,
         -- payables are a credit balance; show what we owe as a positive number
         round(sum(pl.base_credit - pl.base_debit), 2) as owed,
         min(pl.due_date) filter (where pl.due_date is not null) as oldest_due,
         greatest(0, (current_date - min(pl.due_date) filter (where pl.due_date is not null)))::int,
         count(distinct pl.entry_id)
    from payable_lines pl
    join parties p on p.id = pl.party_id
   where public.company_is_member(p_company)
     and public.company_has_right(p_company, 'view_ledger')
   group by p.id, p.name
  having round(sum(pl.base_credit - pl.base_debit), 2) <> 0
   order by min(pl.due_date) nulls last;
$$;

-- ---------------------------------------------------------------------------
-- supplier_advances — advances sitting with a supplier, ready to be set against
-- a bill. This is what makes "pay advance -> get bill -> settle the balance"
-- work without the owner having to remember what they already paid.
-- ---------------------------------------------------------------------------
create or replace function public.supplier_advances(p_company uuid, p_book uuid)
returns table (
  party_id uuid,
  party_name text,
  account_id uuid,
  account_name text,
  advance_outstanding numeric(18,2))
language sql stable security definer set search_path = public as $$
  with scope as (select unnest(public.book_scope(p_book)) as book_id)
  select p.id, p.name, a.id, a.name,
         round(sum(l.base_debit - l.base_credit), 2)
    from journal_lines l
    join journal_entries e on e.id = l.entry_id
    join accounts a on a.id = l.account_id
    join parties p on p.id = l.party_id
   where e.company_id = p_company
     and e.book_id in (select book_id from scope)
     and e.status = 'posted'
     and (a.capex_role in ('capital_advance','deposit')
          or a.sub_group = 'Loans & Advances (Current)')
     and public.company_is_member(p_company)
     and public.company_has_right(p_company, 'view_ledger')
   group by p.id, p.name, a.id, a.name
  having round(sum(l.base_debit - l.base_credit), 2) > 0
   order by p.name, a.name;
$$;

revoke all on function public.payables_ageing(uuid,uuid)    from public, anon;
revoke all on function public.supplier_advances(uuid,uuid)  from public, anon;
grant execute on function public.payables_ageing(uuid,uuid),
                         public.supplier_advances(uuid,uuid) to authenticated;
