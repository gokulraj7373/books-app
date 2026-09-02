-- ============================================================================
-- 0017 — The investor master summary, spanning both books.
--
-- Every investor has FOUR figures, not one. Blending them would mislead the
-- investor; showing only the statutory one would mislead them differently.
-- So all four are returned separately and the caller decides what to show to
-- whom (companies.show_internal_to_investors governs the internal column).
-- ============================================================================

create or replace function public.investor_summary(p_company uuid)
returns table (
  investor_id       uuid,
  name              text,
  agreed_share_pct  numeric(9,6),
  committed         numeric(18,2),
  share_capital     numeric(18,2),   -- statutory, their own capital account
  investor_loan     numeric(18,2),   -- statutory, repayable
  pending           numeric(18,2),   -- statutory, not yet classified
  outside_books     numeric(18,2),   -- internal book only
  statutory_total   numeric(18,2),
  total_in          numeric(18,2),
  still_to_bring    numeric(18,2),
  pct_funded        numeric(9,2),
  last_received     date,
  receipt_count     bigint)
language sql stable security definer set search_path = public as $$
  with bk as (
    select
      (select id from books where company_id = p_company and kind = 'primary')     as stat,
      (select id from books where company_id = p_company and kind = 'adjustment')  as mgmt
  ),
  acc as (
    select (select id from accounts where company_id = p_company and code = '2230') as loan_acct,
           (select id from accounts where company_id = p_company and code = '2240') as pend_acct
  ),
  -- every equity/liability movement attributable to an investor, per book
  moves as (
    select l.party_id,
           e.book_id,
           l.account_id,
           sum(l.base_credit - l.base_debit) as amt,
           max(e.entry_date)                 as last_date,
           count(distinct e.id)              as n
      from journal_lines l
      join journal_entries e on e.id = l.entry_id
     where e.company_id = p_company
       and e.status = 'posted'
       and l.party_id is not null
     group by l.party_id, e.book_id, l.account_id)
  select
    i.id,
    i.display_name,
    i.agreed_share_pct,
    i.committed_amount,
    round(coalesce((select sum(m.amt) from moves m, bk
                     where m.party_id = i.party_id and m.book_id = bk.stat
                       and m.account_id = i.capital_account_id), 0), 2),
    round(coalesce((select sum(m.amt) from moves m, bk, acc
                     where m.party_id = i.party_id and m.book_id = bk.stat
                       and m.account_id = acc.loan_acct), 0), 2),
    round(coalesce((select sum(m.amt) from moves m, bk, acc
                     where m.party_id = i.party_id and m.book_id = bk.stat
                       and m.account_id = acc.pend_acct), 0), 2),
    -- anything in the internal book credited to this investor, whichever
    -- account it landed in (capital or loan — the owner chooses per entry)
    round(coalesce((select sum(m.amt) from moves m, bk
                     where m.party_id = i.party_id and m.book_id = bk.mgmt), 0), 2),
    0::numeric(18,2),   -- statutory_total, filled below
    0::numeric(18,2),   -- total_in
    0::numeric(18,2),   -- still_to_bring
    0::numeric(9,2),    -- pct_funded
    (select max(m.last_date) from moves m where m.party_id = i.party_id),
    coalesce((select sum(m.n) from moves m where m.party_id = i.party_id), 0)
  from investors i
  where i.company_id = p_company
    and public.company_is_member(p_company)
  order by i.agreed_share_pct desc, i.display_name;
$$;

-- The derived columns are easier to get right in one place than repeated in
-- five correlated subqueries, so the shaped version wraps the raw one.
create or replace function public.investor_master(p_company uuid)
returns table (
  investor_id uuid, name text, agreed_share_pct numeric(9,6), committed numeric(18,2),
  share_capital numeric(18,2), investor_loan numeric(18,2), pending numeric(18,2),
  outside_books numeric(18,2), statutory_total numeric(18,2), total_in numeric(18,2),
  still_to_bring numeric(18,2), pct_funded numeric(9,2),
  last_received date, receipt_count bigint)
language sql stable security definer set search_path = public as $$
  select s.investor_id, s.name, s.agreed_share_pct, s.committed,
         s.share_capital, s.investor_loan, s.pending, s.outside_books,
         round(s.share_capital + s.investor_loan + s.pending, 2) as statutory_total,
         round(s.share_capital + s.investor_loan + s.pending + s.outside_books, 2) as total_in,
         round(greatest(s.committed
               - (s.share_capital + s.investor_loan + s.pending + s.outside_books), 0), 2)
           as still_to_bring,
         case when s.committed > 0
              then round((s.share_capital + s.investor_loan + s.pending + s.outside_books)
                         / s.committed * 100, 2)
              else 0 end as pct_funded,
         s.last_received, s.receipt_count
    from public.investor_summary(p_company) s;
$$;

-- ---------------------------------------------------------------------------
-- unclassified_investor_funds — surfaced on Book Health. Money taken in before
-- anyone decided what it legally is, which must not be forgotten.
-- ---------------------------------------------------------------------------
create or replace function public.unclassified_investor_funds(p_company uuid)
returns numeric language sql stable security definer set search_path = public as $$
  select round(coalesce(sum(l.base_credit - l.base_debit), 0), 2)
    from journal_lines l
    join journal_entries e on e.id = l.entry_id
    join accounts a on a.id = l.account_id
   where e.company_id = p_company
     and e.status = 'posted'
     and a.code = '2240'
     and public.company_is_member(p_company);
$$;

revoke all on function public.investor_summary(uuid)            from public, anon;
revoke all on function public.investor_master(uuid)             from public, anon;
revoke all on function public.unclassified_investor_funds(uuid) from public, anon;
grant execute on function public.investor_summary(uuid),
                         public.investor_master(uuid),
                         public.unclassified_investor_funds(uuid) to authenticated;
