-- ============================================================================
-- 0038  Reports can now show ONE book alone, not only "official" or "merged".
--
-- book_scope(management_book_id) has always returned BOTH books' ids, so every
-- report silently merged the moment the internal toggle was on. That was a
-- deliberate design ("management view = official + internal layered"), but it
-- means there was no way to see the internal book on its own, and no way to
-- reach the merged view except by being in internal mode — the two ideas were
-- welded together.
--
-- report_scope(p_book, p_solo) is the new switch: p_solo = true means exactly
-- that one book, nothing else. p_solo = false keeps today's merge behaviour.
-- Every report function gets the extra parameter, defaulting to false so
-- nothing already calling these functions breaks.
-- ============================================================================
create or replace function public.report_scope(p_book uuid, p_solo boolean)
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select case when p_solo then array[p_book] else public.book_scope(p_book) end;
$$;

revoke all on function public.report_scope(uuid, boolean) from public, anon;
grant execute on function public.report_scope(uuid, boolean) to authenticated;

create or replace function public.account_balances(
  p_company uuid, p_book uuid, p_as_on date default null, p_from date default null,
  p_solo boolean default false
)
returns table (account_id uuid, code text, name text, account_type text, account_group text,
               sub_group text, capex_role text, is_bank_or_cash boolean,
               opening_debit numeric, opening_credit numeric, period_debit numeric,
               period_credit numeric, closing_debit numeric, closing_credit numeric, net numeric)
language sql stable security definer set search_path = public
as $$
  with scope as (select unnest(public.report_scope(p_book, p_solo)) as book_id),
  lim as (select coalesce(p_as_on, date '9999-12-31') as as_on),
  opening as (
    select l.account_id, sum(l.base_debit) as dr, sum(l.base_credit) as cr
      from journal_lines l
      join journal_entries e on e.id = l.entry_id
     where e.company_id = p_company
       and e.book_id in (select book_id from scope)
       and e.status = 'posted'
       and p_from is not null
       and e.entry_date < p_from
     group by l.account_id),
  movement as (
    select l.account_id, sum(l.base_debit) as dr, sum(l.base_credit) as cr
      from journal_lines l
      join journal_entries e on e.id = l.entry_id, lim
     where e.company_id = p_company
       and e.book_id in (select book_id from scope)
       and e.status = 'posted'
       and e.entry_date <= lim.as_on
       and (p_from is null or e.entry_date >= p_from)
     group by l.account_id)
  select a.id,
         a.code, a.name, a.account_type, a.account_group, a.sub_group,
         a.capex_role, a.is_bank_or_cash,
         round(a.opening_debit  + coalesce(o.dr,0), 2),
         round(a.opening_credit + coalesce(o.cr,0), 2),
         round(coalesce(m.dr,0), 2),
         round(coalesce(m.cr,0), 2),
         round(greatest(
           (a.opening_debit + coalesce(o.dr,0) + coalesce(m.dr,0))
         - (a.opening_credit + coalesce(o.cr,0) + coalesce(m.cr,0)), 0), 2),
         round(greatest(
           (a.opening_credit + coalesce(o.cr,0) + coalesce(m.cr,0))
         - (a.opening_debit + coalesce(o.dr,0) + coalesce(m.dr,0)), 0), 2),
         round(
           (a.opening_debit + coalesce(o.dr,0) + coalesce(m.dr,0))
         - (a.opening_credit + coalesce(o.cr,0) + coalesce(m.cr,0)), 2)
    from accounts a
    left join opening  o on o.account_id = a.id
    left join movement m on m.account_id = a.id
   where a.company_id = p_company
     and a.is_group = false
     and public.company_is_member(p_company)
     and public.company_has_right(p_company, 'view_reports')
   order by a.code;
$$;

create or replace function public.general_ledger(
  p_company uuid, p_book uuid, p_account uuid, p_from date default null, p_to date default null,
  p_solo boolean default false
)
returns table (entry_date date, voucher_no text, voucher_type text, narration text,
               counter_accounts text, debit numeric, credit numeric, running numeric,
               entry_id uuid, book_code text)
language sql stable security definer set search_path = public
as $$
  with scope as (select unnest(public.report_scope(p_book, p_solo)) as book_id),
  opening as (
    select coalesce(sum(l.base_debit - l.base_credit),0)
             + coalesce((select a.opening_debit - a.opening_credit
                           from accounts a where a.id = p_account), 0) as bal
      from journal_lines l
      join journal_entries e on e.id = l.entry_id
     where e.company_id = p_company and e.book_id in (select book_id from scope)
       and e.status='posted' and l.account_id = p_account
       and p_from is not null and e.entry_date < p_from),
  rows as (
    select e.entry_date, e.voucher_no, e.voucher_type, e.narration, e.id as entry_id,
           b.code as book_code,
           l.base_debit as debit, l.base_credit as credit,
           e.seq, l.line_no,
           (select string_agg(distinct a2.name, ', ')
              from journal_lines l2 join accounts a2 on a2.id = l2.account_id
             where l2.entry_id = e.id and l2.account_id <> p_account) as counter_accounts
      from journal_lines l
      join journal_entries e on e.id = l.entry_id
      join books b on b.id = e.book_id
     where e.company_id = p_company and e.book_id in (select book_id from scope)
       and e.status='posted' and l.account_id = p_account
       and (p_from is null or e.entry_date >= p_from)
       and (p_to   is null or e.entry_date <= p_to))
  select r.entry_date, r.voucher_no, r.voucher_type, r.narration, r.counter_accounts,
         r.debit, r.credit,
         round((select bal from opening)
               + sum(r.debit - r.credit) over (order by r.entry_date, r.seq, r.line_no
                                               rows between unbounded preceding and current row), 2),
         r.entry_id, r.book_code
    from rows r
   where public.company_is_member(p_company)
     and public.company_has_right(p_company, 'view_ledger')
   order by r.entry_date, r.seq, r.line_no;
$$;

create or replace function public.cash_book(
  p_company uuid, p_book uuid, p_from date default null, p_to date default null,
  p_solo boolean default false
)
returns table (entry_date date, voucher_no text, account_name text, contra text,
               money_in numeric, money_out numeric, running numeric, entry_id uuid)
language sql stable security definer set search_path = public
as $$
  with scope as (select unnest(public.report_scope(p_book, p_solo)) as book_id),
  opening as (
    select coalesce(sum(l.base_debit - l.base_credit),0) as bal
      from journal_lines l
      join journal_entries e on e.id = l.entry_id
      join accounts a on a.id = l.account_id
     where e.company_id = p_company and e.book_id in (select book_id from scope)
       and e.status='posted' and a.is_bank_or_cash
       and p_from is not null and e.entry_date < p_from),
  rows as (
    select e.entry_date, e.voucher_no, a.name as account_name,
           l.base_debit as money_in, l.base_credit as money_out,
           e.seq, l.line_no, e.id as entry_id,
           (select string_agg(distinct a2.name, ', ')
              from journal_lines l2 join accounts a2 on a2.id = l2.account_id
             where l2.entry_id = e.id and a2.is_bank_or_cash = false) as contra
      from journal_lines l
      join journal_entries e on e.id = l.entry_id
      join accounts a on a.id = l.account_id
     where e.company_id = p_company and e.book_id in (select book_id from scope)
       and e.status='posted' and a.is_bank_or_cash
       and (p_from is null or e.entry_date >= p_from)
       and (p_to   is null or e.entry_date <= p_to))
  select r.entry_date, r.voucher_no, r.account_name, r.contra, r.money_in, r.money_out,
         round((select bal from opening)
               + sum(r.money_in - r.money_out) over (order by r.entry_date, r.seq, r.line_no
                                                     rows between unbounded preceding and current row), 2),
         r.entry_id
    from rows r
   where public.company_is_member(p_company)
     and public.company_has_right(p_company, 'view_cash_bank')
   order by r.entry_date, r.seq, r.line_no;
$$;

create or replace function public.open_bills(p_company uuid, p_book uuid, p_solo boolean default false)
returns table (entry_id uuid, voucher_no text, supplier_bill_no text, party_id uuid, party_name text,
               bill_date date, due_date date, payment_terms text,
               total numeric, settled numeric, outstanding numeric, days_overdue int,
               narration text)
language sql stable security definer set search_path = public
as $$
  with scope as (select unnest(public.report_scope(p_book, p_solo)) as book_id),
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
       and e.reversed_by_entry_id is null
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

create or replace function public.party_balances(p_company uuid, p_book uuid, p_solo boolean default false)
returns table (party_id uuid, name text, party_type text, is_related_party boolean,
               balance numeric, last_activity date, entry_count bigint)
language sql stable security definer set search_path = public
as $$
  with scope as (select unnest(public.report_scope(p_book, p_solo)) as book_id)
  select p.id, p.name, p.party_type, p.is_related_party,
         round(coalesce(sum(l.base_debit - l.base_credit),0),2),
         max(e.entry_date),
         count(distinct e.id)
    from parties p
    left join journal_lines l on l.party_id = p.id
    left join journal_entries e on e.id = l.entry_id
         and e.status='posted' and e.book_id in (select book_id from scope)
   where p.company_id = p_company
     and public.company_is_member(p_company)
     and public.company_has_right(p_company,'view_ledger')
   group by p.id, p.name, p.party_type, p.is_related_party
   order by abs(round(coalesce(sum(l.base_debit - l.base_credit),0),2)) desc, p.name;
$$;

create or replace function public.party_statement(
  p_company uuid, p_party uuid, p_book uuid, p_from date default null, p_to date default null,
  p_solo boolean default false
)
returns table (entry_date date, voucher_no text, narration text, account_name text,
               debit numeric, credit numeric, running numeric, entry_id uuid)
language sql stable security definer set search_path = public
as $$
  with scope as (select unnest(public.report_scope(p_book, p_solo)) as book_id),
  opening as (
    select coalesce(sum(l.base_debit - l.base_credit),0) as bal
      from journal_lines l join journal_entries e on e.id = l.entry_id
     where e.company_id = p_company and e.book_id in (select book_id from scope)
       and e.status='posted' and l.party_id = p_party
       and p_from is not null and e.entry_date < p_from),
  rows as (
    select e.entry_date, e.voucher_no, e.narration, a.name as account_name,
           l.base_debit as debit, l.base_credit as credit,
           e.seq, l.line_no, e.id as entry_id
      from journal_lines l
      join journal_entries e on e.id = l.entry_id
      join accounts a on a.id = l.account_id
     where e.company_id = p_company and e.book_id in (select book_id from scope)
       and e.status='posted' and l.party_id = p_party
       and (p_from is null or e.entry_date >= p_from)
       and (p_to   is null or e.entry_date <= p_to))
  select r.entry_date, r.voucher_no, r.narration, r.account_name, r.debit, r.credit,
         round((select bal from opening)
               + sum(r.debit - r.credit) over (order by r.entry_date, r.seq, r.line_no
                                               rows between unbounded preceding and current row), 2),
         r.entry_id
    from rows r
   where public.company_is_member(p_company)
     and public.company_has_right(p_company,'view_ledger')
   order by r.entry_date, r.seq, r.line_no;
$$;

create or replace function public.supplier_advances(p_company uuid, p_book uuid, p_solo boolean default false)
returns table (party_id uuid, party_name text, account_id uuid, account_name text,
               advance_outstanding numeric)
language sql stable security definer set search_path = public
as $$
  with scope as (select unnest(public.report_scope(p_book, p_solo)) as book_id)
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

create or replace function public.unapplied_credits(p_company uuid, p_book uuid, p_solo boolean default false)
returns table (party_id uuid, party_name text, amount numeric)
language sql stable security definer set search_path = public
as $$
  with scope as (select unnest(public.report_scope(p_book, p_solo)) as book_id),
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

create or replace function public.capex_summary(p_company uuid, p_book uuid, p_solo boolean default false)
returns table (project_id uuid, name text, status text, budget_amount numeric,
               planned_amount numeric, spent numeric, cwip_balance numeric,
               line_count bigint, capitalized_on date)
language sql stable security definer set search_path = public
as $$
  with scope as (select unnest(public.report_scope(p_book, p_solo)) as book_id),
  spend as (
    select cpl.capital_project_id as pid,
           sum(l.base_debit - l.base_credit) as spent
      from journal_lines l
      join capital_project_lines cpl on cpl.id = l.capital_project_line_id
      join journal_entries e on e.id = l.entry_id
     where e.status='posted' and e.book_id in (select book_id from scope)
     group by cpl.capital_project_id),
  cwip as (
    select cp.id as pid, sum(l.base_debit - l.base_credit) as bal
      from capital_projects cp
      join journal_lines l on l.account_id = cp.cwip_account_id
      join journal_entries e on e.id = l.entry_id
     where e.status='posted' and e.book_id in (select book_id from scope)
       and cp.company_id = p_company
     group by cp.id)
  select cp.id, cp.name, cp.status, cp.budget_amount,
         round(coalesce((select sum(planned_amount) from capital_project_lines
                          where capital_project_id = cp.id),0),2),
         round(coalesce(s.spent,0),2),
         round(coalesce(w.bal,0),2),
         (select count(*) from capital_project_lines where capital_project_id = cp.id),
         cp.capitalized_on
    from capital_projects cp
    left join spend s on s.pid = cp.id
    left join cwip  w on w.pid = cp.id
   where cp.company_id = p_company
     and public.company_is_member(p_company)
     and public.company_has_right(p_company,'view_capex')
   order by cp.created_at;
$$;

revoke all on function public.account_balances(uuid, uuid, date, date, boolean) from public, anon;
revoke all on function public.general_ledger(uuid, uuid, uuid, date, date, boolean) from public, anon;
revoke all on function public.cash_book(uuid, uuid, date, date, boolean) from public, anon;
revoke all on function public.open_bills(uuid, uuid, boolean) from public, anon;
revoke all on function public.party_balances(uuid, uuid, boolean) from public, anon;
revoke all on function public.party_statement(uuid, uuid, uuid, date, date, boolean) from public, anon;
revoke all on function public.supplier_advances(uuid, uuid, boolean) from public, anon;
revoke all on function public.unapplied_credits(uuid, uuid, boolean) from public, anon;
revoke all on function public.capex_summary(uuid, uuid, boolean) from public, anon;

grant execute on function public.account_balances(uuid, uuid, date, date, boolean) to authenticated;
grant execute on function public.general_ledger(uuid, uuid, uuid, date, date, boolean) to authenticated;
grant execute on function public.cash_book(uuid, uuid, date, date, boolean) to authenticated;
grant execute on function public.open_bills(uuid, uuid, boolean) to authenticated;
grant execute on function public.party_balances(uuid, uuid, boolean) to authenticated;
grant execute on function public.party_statement(uuid, uuid, uuid, date, date, boolean) to authenticated;
grant execute on function public.supplier_advances(uuid, uuid, boolean) to authenticated;
grant execute on function public.unapplied_credits(uuid, uuid, boolean) to authenticated;
grant execute on function public.capex_summary(uuid, uuid, boolean) to authenticated;
