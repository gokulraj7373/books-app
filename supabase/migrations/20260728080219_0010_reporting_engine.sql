-- ============================================================================
-- 0010 — The reporting engine.
--
-- ONE function computes account balances. Trial Balance, P&L, Balance Sheet,
-- General Ledger and the Cash Book all read from it, so they cannot drift apart
-- and disagree — the classic way a set of books stops tallying.
--
-- Book semantics (NetSuite adjustment-book model):
--   statutory view  = the primary book's lines only
--   management view = primary lines UNION its own adjustment lines
-- The management book stores only its adjustments; it never duplicates a row.
-- ============================================================================

-- Resolve a requested book into the set of book ids that make up its view.
create or replace function public.book_scope(p_book uuid)
returns uuid[] language sql stable security definer set search_path = public as $$
  select case
    when b.kind = 'adjustment' then array[b.id, b.base_book_id]
    else array[b.id]
  end
  from books b where b.id = p_book;
$$;

-- ---------------------------------------------------------------------------
-- account_balances — the single source of truth for every report.
--   p_as_on   : closing balances up to and including this date
--   p_from    : if given, movement is restricted to [p_from, p_as_on]
-- Returns Dr-positive `net`; a credit balance is negative.
-- ---------------------------------------------------------------------------
create or replace function public.account_balances(
  p_company uuid,
  p_book    uuid,
  p_as_on   date default null,
  p_from    date default null)
returns table (
  account_id     uuid,
  code           text,
  name           text,
  account_type   text,
  account_group  text,
  sub_group      text,
  capex_role     text,
  is_bank_or_cash boolean,
  opening_debit  numeric(18,2),
  opening_credit numeric(18,2),
  period_debit   numeric(18,2),
  period_credit  numeric(18,2),
  closing_debit  numeric(18,2),
  closing_credit numeric(18,2),
  net            numeric(18,2)
)
language sql stable security definer set search_path = public as $$
  with scope as (select unnest(public.book_scope(p_book)) as book_id),
  lim as (select coalesce(p_as_on, date '9999-12-31') as as_on),
  -- movement strictly before the period start = opening
  opening as (
    select l.account_id,
           sum(l.base_debit)  as dr,
           sum(l.base_credit) as cr
      from journal_lines l
      join journal_entries e on e.id = l.entry_id
     where e.company_id = p_company
       and e.book_id in (select book_id from scope)
       and e.status = 'posted'
       and p_from is not null
       and e.entry_date < p_from
     group by l.account_id),
  movement as (
    select l.account_id,
           sum(l.base_debit)  as dr,
           sum(l.base_credit) as cr
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

-- ---------------------------------------------------------------------------
-- general_ledger — every posting to one account, with a running balance.
-- ---------------------------------------------------------------------------
create or replace function public.general_ledger(
  p_company uuid,
  p_book    uuid,
  p_account uuid,
  p_from    date default null,
  p_to      date default null)
returns table (
  entry_date    date,
  voucher_no    text,
  voucher_type  text,
  narration     text,
  counter_accounts text,
  debit         numeric(18,2),
  credit        numeric(18,2),
  running       numeric(18,2),
  entry_id      uuid,
  book_code     text
)
language sql stable security definer set search_path = public as $$
  with scope as (select unnest(public.book_scope(p_book)) as book_id),
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

-- ---------------------------------------------------------------------------
-- cash_book — every movement through a bank/cash account, running balance.
-- Gated on view_cash_bank so a cashier can use it without seeing the ledger.
-- ---------------------------------------------------------------------------
create or replace function public.cash_book(
  p_company uuid,
  p_book    uuid,
  p_from    date default null,
  p_to      date default null)
returns table (
  entry_date   date,
  voucher_no   text,
  account_name text,
  contra       text,
  money_in     numeric(18,2),
  money_out    numeric(18,2),
  running      numeric(18,2)
)
language sql stable security definer set search_path = public as $$
  with scope as (select unnest(public.book_scope(p_book)) as book_id),
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
           e.seq, l.line_no,
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
                                                     rows between unbounded preceding and current row), 2)
    from rows r
   where public.company_is_member(p_company)
     and public.company_has_right(p_company, 'view_cash_bank')
   order by r.entry_date, r.seq, r.line_no;
$$;

revoke all on function public.book_scope(uuid)                              from public, anon;
revoke all on function public.account_balances(uuid,uuid,date,date)         from public, anon;
revoke all on function public.general_ledger(uuid,uuid,uuid,date,date)      from public, anon;
revoke all on function public.cash_book(uuid,uuid,date,date)                from public, anon;
grant execute on function public.book_scope(uuid),
                         public.account_balances(uuid,uuid,date,date),
                         public.general_ledger(uuid,uuid,uuid,date,date),
                         public.cash_book(uuid,uuid,date,date) to authenticated;
