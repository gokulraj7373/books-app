-- ============================================================================
-- 0023 — Dismissible alerts, with one deliberate exception.
--
-- Alerts are COMPUTED from the ledger, not stored. So "dismiss" cannot mean
-- delete — the underlying fact is still true. It means "I have seen this".
--
-- Two safety rules, both deliberate:
--
--  1. A `danger` alert can NEVER be dismissed. "Your books do not add up" and
--     "the audit trail is broken" mean the accounts are wrong. Letting someone
--     tap that away would turn a safety feature into a way to hide a problem —
--     it disappears when it is FIXED, and only then.
--
--  2. Dismissal is fingerprinted by amount. Dismiss "5,00,000 unclassified" and
--     it stays hidden — but if another 2,00,000 arrives the figure changes, the
--     fingerprint changes, and it comes back. Otherwise dismissing once would
--     silence that alert forever, however much the number grew.
--
-- Dismissals are per user: one person clearing their view must not blind
-- everyone else in the company.
-- ============================================================================

create table if not exists alert_dismissals (
  company_id  uuid not null references companies(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  alert_key   text not null,
  fingerprint text not null,
  dismissed_at timestamptz not null default now(),
  primary key (company_id, user_id, alert_key)
);

grant select, insert, update, delete on alert_dismissals to authenticated;
alter table alert_dismissals enable row level security;

drop policy if exists ad_own on alert_dismissals;
create policy ad_own on alert_dismissals for all to authenticated
  using (user_id = auth.uid() and public.company_is_member(company_id))
  with check (user_id = auth.uid() and public.company_is_member(company_id));

create or replace function public.dismiss_alert(
  p_company uuid, p_alert_key text, p_fingerprint text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if not public.company_is_member(p_company) then raise exception 'not a member'; end if;

  insert into alert_dismissals (company_id, user_id, alert_key, fingerprint)
  values (p_company, auth.uid(), p_alert_key, coalesce(p_fingerprint,'-'))
  on conflict (company_id, user_id, alert_key)
    do update set fingerprint = excluded.fingerprint, dismissed_at = now();
end; $$;

create or replace function public.restore_alerts(p_company uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  delete from alert_dismissals where company_id = p_company and user_id = auth.uid();
end; $$;

-- ---------------------------------------------------------------------------
-- live_alerts — company_alerts with the caller's dismissals applied.
-- ---------------------------------------------------------------------------
create or replace function public.live_alerts(p_company uuid, p_book uuid)
returns table (
  id text, severity text, title text, body text, href text,
  amount numeric(18,2), dismissible boolean, fingerprint text)
language sql stable security definer set search_path = public as $$
  select a.id, a.severity, a.title, a.body, a.href, a.amount,
         (a.severity <> 'danger') as dismissible,
         coalesce(a.amount::text, '-') as fingerprint
    from public.company_alerts(p_company, p_book) a
   where a.severity = 'danger'                       -- never hideable
      or not exists (
           select 1 from alert_dismissals d
            where d.company_id = p_company
              and d.user_id = auth.uid()
              and d.alert_key = a.id
              -- the same alert with a DIFFERENT amount is a new fact
              and d.fingerprint = coalesce(a.amount::text, '-'))
   order by case a.severity when 'danger' then 0 when 'warn' then 1 else 2 end,
            a.amount desc nulls last;
$$;

-- how many the user has hidden, so they can always bring them back
create or replace function public.dismissed_alert_count(p_company uuid)
returns int language sql stable security definer set search_path = public as $$
  select count(*)::int from alert_dismissals
   where company_id = p_company and user_id = auth.uid();
$$;

revoke all on function public.dismiss_alert(uuid,text,text)    from public, anon;
revoke all on function public.restore_alerts(uuid)             from public, anon;
revoke all on function public.live_alerts(uuid,uuid)           from public, anon;
revoke all on function public.dismissed_alert_count(uuid)      from public, anon;
grant execute on function public.dismiss_alert(uuid,text,text),
                         public.restore_alerts(uuid),
                         public.live_alerts(uuid,uuid),
                         public.dismissed_alert_count(uuid) to authenticated;
