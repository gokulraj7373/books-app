create table if not exists public.backup_log (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  taken_by    uuid references auth.users(id) on delete set null,
  taken_by_name text,
  taken_at    timestamptz not null default now(),
  kind        text not null check (kind in ('snapshot','excel')),
  entry_count int  not null default 0,
  chain_head  text,
  note        text
);

create index if not exists backup_log_company_idx on public.backup_log (company_id, taken_at desc);

alter table public.backup_log enable row level security;

drop policy if exists backup_log_read on public.backup_log;
create policy backup_log_read on public.backup_log
  for select using (public.company_is_member(company_id));

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
                         'head_hash',   (select e.hash from journal_entries e
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

create or replace function public.record_backup(
  p_company uuid,
  p_kind    text,
  p_entry_count int default 0,
  p_chain_head  text default null,
  p_note        text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Sign in first.';
  end if;
  if not public.company_is_member(p_company) then
    raise exception 'You are not a member of this company.';
  end if;
  if p_kind not in ('snapshot','excel') then
    raise exception 'Unknown backup kind.';
  end if;

  insert into backup_log (company_id, taken_by, taken_by_name, kind, entry_count, chain_head, note)
  values (
    p_company, auth.uid(),
    (select coalesce(full_name, email) from profiles where id = auth.uid()),
    p_kind, coalesce(p_entry_count, 0), p_chain_head, p_note
  )
  returning id into v_id;

  return v_id;
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
      and f.head_hash is not distinct from (select e.hash from journal_entries e
                            where e.book_id = b.id and e.status = 'posted'
                            order by e.seq desc limit 1)) as matches,
    case
      when b.id is null then 'This book is in the file but not in the database.'
      when f.entry_count <> (select count(*) from journal_entries e
                              where e.book_id = b.id and e.status = 'posted')
        then format('The file holds %s entries, the database now has %s. That is expected if you have posted entries since the backup.',
                    f.entry_count,
                    (select count(*) from journal_entries e where e.book_id = b.id and e.status = 'posted'))
      when f.head_hash is distinct from (select e.hash from journal_entries e
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

create or replace function public.backup_alert(p_company uuid)
returns table (id text, severity text, title text, body text, href text, amount numeric(18,2))
language sql
stable
security definer
set search_path = public
as $$
  with posted as (
    select count(*)::int as n
      from journal_entries e
     where e.company_id = p_company and e.status = 'posted'
  ), last_bk as (
    select max(bl.taken_at) as at
      from backup_log bl
     where bl.company_id = p_company and bl.kind = 'snapshot'
  )
  select
    'backup_stale'::text,
    'warn'::text,
    case when lb.at is null
         then 'You have never taken a backup'
         else 'Your last backup is ' || extract(day from now() - lb.at)::int || ' days old' end,
    case when lb.at is null
         then 'Take one copy now and keep it somewhere this app cannot reach. It is the only thing that protects you if an account is lost.'
         else 'You have posted entries since then. Take a fresh copy so a lost account cannot cost you the books.' end,
    '/data'::text,
    null::numeric(18,2)
  from posted p
  left join last_bk lb on true
  where p.n > 0
    and (lb.at is null or lb.at < now() - interval '7 days');
$$;

create or replace function public.live_alerts(p_company uuid, p_book uuid)
returns table (id text, severity text, title text, body text, href text,
               amount numeric(18,2), dismissible boolean, fingerprint text)
language sql
stable
security definer
set search_path = public
as $$
  with all_alerts as (
    select a.id, a.severity, a.title, a.body, a.href, a.amount
      from public.company_alerts(p_company, p_book) a
    union all
    select b.id, b.severity, b.title, b.body, b.href, b.amount
      from public.backup_alert(p_company) b
  )
  select a.id, a.severity, a.title, a.body, a.href, a.amount,
         (a.severity <> 'danger') as dismissible,
         coalesce(a.amount::text, '-') as fingerprint
    from all_alerts a
   where a.severity = 'danger'
      or not exists (
           select 1 from alert_dismissals d
            where d.company_id = p_company
              and d.user_id = auth.uid()
              and d.alert_key = a.id
              and d.fingerprint = coalesce(a.amount::text, '-'))
   order by case a.severity when 'danger' then 0 when 'warn' then 1 else 2 end,
            a.amount desc nulls last;
$$;

revoke all on function public.export_company_snapshot(uuid) from public, anon;
revoke all on function public.record_backup(uuid, text, int, text, text) from public, anon;
revoke all on function public.check_backup(uuid, jsonb) from public, anon;
revoke all on function public.backup_alert(uuid) from public, anon;
revoke all on function public.live_alerts(uuid, uuid) from public, anon;

grant execute on function public.export_company_snapshot(uuid) to authenticated;
grant execute on function public.record_backup(uuid, text, int, text, text) to authenticated;
grant execute on function public.check_backup(uuid, jsonb) to authenticated;
grant execute on function public.live_alerts(uuid, uuid) to authenticated;
