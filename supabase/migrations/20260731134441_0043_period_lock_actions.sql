-- ============================================================================
-- 0043  Closing a period, for real.
--
-- save_journal_entry has always checked period_locks.locked_through and
-- refused to touch a locked date — but nothing ever wrote to that table. The
-- enforcement existed with no way to trigger it. These two functions are that
-- missing half.
-- ============================================================================
create or replace function public.lock_period(p_company uuid, p_book uuid, p_through date)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  if not public.company_has_right(p_company, 'close_period') then
    raise exception 'Your role cannot close a period.';
  end if;
  if p_through is null or p_through > current_date then
    raise exception 'Choose a date that has already passed.';
  end if;

  insert into period_locks (company_id, book_id, locked_through, locked_by, locked_at)
  values (p_company, p_book, p_through, auth.uid(), now())
  on conflict (company_id, book_id) do update
    set locked_through = excluded.locked_through,
        locked_by = excluded.locked_by,
        locked_at = now();
end;
$$;

create or replace function public.unlock_period(p_company uuid, p_book uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  -- Deliberately a stricter right than closing one: anyone who can close a
  -- period should not be able to unilaterally reopen it again — that would
  -- make the lock decorative.
  if not public.company_has_right(p_company, 'unlock_period') then
    raise exception 'Your role cannot reopen a closed period.';
  end if;
  delete from period_locks where company_id = p_company and book_id = p_book;
end;
$$;

create or replace function public.period_lock_status(p_company uuid, p_book uuid)
returns table (locked_through date, locked_by_name text, locked_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select pl.locked_through,
         (select coalesce(pr.full_name, pr.email) from profiles pr where pr.id = pl.locked_by),
         pl.locked_at
    from period_locks pl
   where pl.company_id = p_company and pl.book_id = p_book
     and public.company_is_member(p_company);
$$;

revoke all on function public.lock_period(uuid, uuid, date) from public, anon;
revoke all on function public.unlock_period(uuid, uuid) from public, anon;
revoke all on function public.period_lock_status(uuid, uuid) from public, anon;
grant execute on function public.lock_period(uuid, uuid, date) to authenticated;
grant execute on function public.unlock_period(uuid, uuid) to authenticated;
grant execute on function public.period_lock_status(uuid, uuid) to authenticated;
