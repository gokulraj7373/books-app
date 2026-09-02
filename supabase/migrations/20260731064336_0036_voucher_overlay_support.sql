-- ============================================================================
-- 0036  Data the voucher overlay needs in one call.
--
-- entry_detail already returned enough for the Fix panel to pre-fill itself.
-- The overlay shows the WHOLE voucher, so it also needs: who it was for, what
-- book it is in, whether there is paperwork attached, and the correction chain
-- (what it cancels / what replaced it) so a click on either side of that chain
-- opens the other half instead of a dead end.
-- ============================================================================
create or replace function public.entry_detail(p_entry uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case when public.company_is_member(e.company_id) then jsonb_build_object(
    'id', e.id, 'voucher_no', e.voucher_no, 'voucher_type', e.voucher_type,
    'entry_date', e.entry_date, 'narration', e.narration,
    'party_id', e.party_id,
    'party_name', (select p.name from parties p where p.id = e.party_id),
    'payment_mode', e.payment_mode, 'reference_no', e.reference_no,
    'due_date', e.due_date, 'proof_url', e.proof_url,
    'book_id', e.book_id,
    'book_name', (select b.name from books b where b.id = e.book_id),
    'book_kind', (select b.kind from books b where b.id = e.book_id),
    'status', e.status,
    'created_by_name', e.created_by_name, 'posted_by_name', e.posted_by_name,
    'posted_at', e.posted_at,
    'reverses_entry_id', e.reverses_entry_id,
    'reverses_voucher_no', (select r.voucher_no from journal_entries r where r.id = e.reverses_entry_id),
    'reversed_by_entry_id', e.reversed_by_entry_id,
    'reversed_by_voucher_no', (select r.voucher_no from journal_entries r where r.id = e.reversed_by_entry_id),
    'lines', (select coalesce(jsonb_agg(jsonb_build_object(
                'account_id', l.account_id, 'account_name', a.name, 'account_code', a.code,
                'debit', l.debit, 'credit', l.credit, 'party_id', l.party_id,
                'party_name', (select p2.name from parties p2 where p2.id = l.party_id))
              order by l.line_no), '[]'::jsonb)
              from journal_lines l join accounts a on a.id = l.account_id
             where l.entry_id = e.id)
  ) end
  from journal_entries e where e.id = p_entry;
$$;

revoke all on function public.entry_detail(uuid) from public, anon;
grant execute on function public.entry_detail(uuid) to authenticated;

-- cash_book had no entry_id, so a row there could not link to the overlay.
drop function if exists public.cash_book(uuid, uuid, date, date);

create function public.cash_book(p_company uuid, p_book uuid, p_from date default null, p_to date default null)
returns table (entry_date date, voucher_no text, account_name text, contra text,
               money_in numeric, money_out numeric, running numeric, entry_id uuid)
language sql
stable
security definer
set search_path = public
as $$
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

revoke all on function public.cash_book(uuid, uuid, date, date) from public, anon;
grant execute on function public.cash_book(uuid, uuid, date, date) to authenticated;
