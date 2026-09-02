-- The impersonation matrix showed an investor could read the full chart of
-- accounts (90 rows), every book, and the complete member roster — because
-- those policies only asked "are you a member of this company?".
--
-- An investor is a member, but they are not staff. They should learn nothing
-- about the company's internal structure or who else is involved; their two
-- legitimate reads (own capital, published reports) go through SECURITY DEFINER
-- RPCs instead. Membership alone is therefore not sufficient for these tables.

-- a right that means "you do bookkeeping work here", i.e. not an investor
create or replace function public.company_is_staff(p_company uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select public.company_has_right(p_company,'view_ledger')
      or public.company_has_right(p_company,'view_reports')
      or public.company_has_right(p_company,'view_cash_bank')
      or public.company_has_right(p_company,'draft_entry')
      or public.company_has_right(p_company,'edit_coa');
$$;
revoke all on function public.company_is_staff(uuid) from public, anon;
grant execute on function public.company_is_staff(uuid) to authenticated;

drop policy if exists accounts_select on accounts;
create policy accounts_select on accounts for select to authenticated
  using (public.company_is_staff(company_id));

drop policy if exists parties_select on parties;
create policy parties_select on parties for select to authenticated
  using (public.company_is_staff(company_id));

drop policy if exists books_select on books;
create policy books_select on books for select to authenticated
  using (public.company_is_staff(company_id));

drop policy if exists fy_select on fiscal_years;
create policy fy_select on fiscal_years for select to authenticated
  using (public.company_is_staff(company_id));

drop policy if exists vs_select on voucher_series;
create policy vs_select on voucher_series for select to authenticated
  using (public.company_is_staff(company_id));

drop policy if exists pl_select on period_locks;
create policy pl_select on period_locks for select to authenticated
  using (public.company_is_staff(company_id));

-- Roster: staff see colleagues; an investor sees only their own seat, so they
-- cannot enumerate who else has invested or who works on the books.
drop policy if exists company_members_select on company_members;
create policy company_members_select on company_members for select to authenticated
  using (user_id = auth.uid() or public.company_is_staff(company_id));

-- The management book is not visible to everyone with view_ledger; it needs its
-- own right, so an auditor defaults to the statutory book only.
drop policy if exists je_select on journal_entries;
create policy je_select on journal_entries for select to authenticated
  using (
    public.company_has_right(company_id, 'view_ledger')
    and (
      exists (select 1 from books b where b.id = journal_entries.book_id and b.kind = 'primary')
      or public.company_has_right(company_id, 'view_management_book')
    )
  );

drop policy if exists jl_select on journal_lines;
create policy jl_select on journal_lines for select to authenticated
  using (exists (
    select 1 from journal_entries je join books b on b.id = je.book_id
     where je.id = journal_lines.entry_id
       and public.company_has_right(je.company_id, 'view_ledger')
       and (b.kind = 'primary'
            or public.company_has_right(je.company_id, 'view_management_book'))));
