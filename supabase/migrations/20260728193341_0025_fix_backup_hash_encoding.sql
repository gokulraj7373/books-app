-- journal_entries.hash is bytea. Comparing it to a text field from the backup
-- file fails outright, so the fingerprint is hex-encoded on both sides.
create or replace function public.export_company_snapshot(p_company uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_out jsonb;
begin
  if auth.uid() is null then
    raise exception 'Sign in first.';
  end if;
  if not public.company_is_member(p_company) then
    raise exception 'You are not a member of this company.';
  end if;
  if not (public.company_has_right(p_company, 'view_audit_trail')
          and public.company_has_right(p_company, 'view_ledger')) then
    raise exception 'Your role cannot take a full backup. Ask an owner or your accountant.';
  end if;

  select jsonb_build_object(
    'format',       'books-app-snapshot',
    'format_version', 1,
    'taken_at',     now(),
    'company_id',   p_company,
    'company',      (select to_jsonb(c) from companies c where c.id = p_company),
    'books',        (select coalesce(jsonb_agg(to_jsonb(b) order by b.code), '[]'::jsonb)
                       from books b where b.company_id = p_company),
    'fiscal_years', (select coalesce(jsonb_agg(to_jsonb(f)), '[]'::jsonb)
                       from fiscal_years f where f.company_id = p_company),
    'accounts',     (select coalesce(jsonb_agg(to_jsonb(a) order by a.code), '[]'::jsonb)
                       from accounts a where a.company_id = p_company),
    'parties',      (select coalesce(jsonb_agg(to_jsonb(p) order by p.name), '[]'::jsonb)
                       from parties p where p.company_id = p_company),
    'investors',    (select coalesce(jsonb_agg(to_jsonb(i)), '[]'::jsonb)
                       from investors i where i.company_id = p_company),
    'capital_projects', (select coalesce(jsonb_agg(to_jsonb(cp)), '[]'::jsonb)
                       from capital_projects cp where cp.company_id = p_company),
    'capital_project_lines', (select coalesce(jsonb_agg(to_jsonb(cl)), '[]'::jsonb)
                       from capital_project_lines cl where cl.company_id = p_company),
    'capitalization_events', (select coalesce(jsonb_agg(to_jsonb(ce)), '[]'::jsonb)
                       from capitalization_events ce where ce.company_id = p_company),
    'entries',      (select coalesce(jsonb_agg(to_jsonb(e) order by e.book_id, e.seq), '[]'::jsonb)
                       from journal_entries e where e.company_id = p_company),
    'lines',        (select coalesce(jsonb_agg(to_jsonb(l) order by l.entry_id, l.line_no), '[]'::jsonb)
                       from journal_lines l
                       join journal_entries e on e.id = l.entry_id
                      where e.company_id = p_company),
    'bill_allocations', (select coalesce(jsonb_agg(to_jsonb(ba)), '[]'::jsonb)
                       from bill_allocations ba where ba.company_id = p_company),
    'period_locks', (select coalesce(jsonb_agg(to_jsonb(pl)), '[]'::jsonb)
                       from period_locks pl where pl.company_id = p_company),
    'voucher_series', (select coalesce(jsonb_agg(to_jsonb(vs)), '[]'::jsonb)
                       from voucher_series vs where vs.company_id = p_company),
    'members',      (select coalesce(jsonb_agg(jsonb_build_object(
                         'user_id', cm.user_id, 'role_key', cm.role_key,
                         'email', pr.email, 'full_name', pr.full_name)), '[]'::jsonb)
                       from company_members cm
                       left join profiles pr on pr.id = cm.user_id
                      where cm.company_id = p_company),
    'integrity',    (select coalesce(jsonb_agg(jsonb_build_object(
                         'book_id',     b.id,
                         'book_name',   b.name,
                         'entry_count', (select count(*) from journal_entries e
                                          where e.book_id = b.id and e.status = 'posted'),
                         'last_seq',    (select max(e.seq) from journal_entries e
                                          where e.book_id = b.id and e.status = 'posted'),
                         'head_hash',   (select encode(e.hash, 'hex') from journal_entries e
                                          where e.book_id = b.id and e.status = 'posted'
                                          order by e.seq desc limit 1),
                         'total_debit', (select coalesce(sum(l.debit), 0) from journal_lines l
                                          join journal_entries e on e.id = l.entry_id
                                         where e.book_id = b.id and e.status = 'posted'),
                         'total_credit',(select coalesce(sum(l.credit), 0) from journal_lines l
                                          join journal_entries e on e.id = l.entry_id
                                         where e.book_id = b.id and e.status = 'posted')
                       ) order by b.code), '[]'::jsonb)
                       from books b where b.company_id = p_company)
  ) into v_out;

  return v_out;
end;
$$;

create or replace function public.check_backup(p_company uuid, p_integrity jsonb)
returns table (book_name text, matches boolean, detail text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.company_is_member(p_company) then
    raise exception 'You are not a member of this company.';
  end if;

  return query
  select
    coalesce(f.book_name, b.name) as book_name,
    (b.id is not null
      and f.entry_count = (select count(*) from journal_entries e
                            where e.book_id = b.id and e.status = 'posted')
      and f.head_hash is not distinct from (select encode(e.hash, 'hex') from journal_entries e
                            where e.book_id = b.id and e.status = 'posted'
                            order by e.seq desc limit 1)) as matches,
    case
      when b.id is null then 'This book is in the file but not in the database.'
      when f.entry_count <> (select count(*) from journal_entries e
                              where e.book_id = b.id and e.status = 'posted')
        then format('The file holds %s posted entries, the database now has %s. That is expected if you have posted entries since the backup was taken.',
                    f.entry_count,
                    (select count(*) from journal_entries e where e.book_id = b.id and e.status = 'posted'))
      when f.head_hash is distinct from (select encode(e.hash, 'hex') from journal_entries e
                              where e.book_id = b.id and e.status = 'posted'
                              order by e.seq desc limit 1)
        then 'Same number of entries, but the audit-trail fingerprint differs. Something was changed outside the app.'
      else 'The file and the database agree exactly.'
    end as detail
  from jsonb_to_recordset(coalesce(p_integrity, '[]'::jsonb))
       as f(book_id uuid, book_name text, entry_count int, last_seq bigint, head_hash text)
  left join books b on b.id = f.book_id and b.company_id = p_company;
end;
$$;

revoke all on function public.export_company_snapshot(uuid) from public, anon;
revoke all on function public.check_backup(uuid, jsonb) from public, anon;
grant execute on function public.export_company_snapshot(uuid) to authenticated;
grant execute on function public.check_backup(uuid, jsonb) to authenticated;
