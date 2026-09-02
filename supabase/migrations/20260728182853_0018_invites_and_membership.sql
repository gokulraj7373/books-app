-- ============================================================================
-- 0018 — Inviting people, without a service-role key anywhere.
--
-- The obvious way to invite someone is supabase.auth.admin.inviteUserByEmail,
-- which needs the SERVICE ROLE key. That key bypasses every RLS policy, so it
-- must never reach the browser, and routing it through an Edge Function adds a
-- privileged surface for something as ordinary as adding a colleague.
--
-- Instead: the owner records an invitation against an email address. The person
-- signs up normally, and on first login claim_invites() matches their verified
-- email and grants the membership. No elevated key, and no way to grant yourself
-- access to a company that did not invite you.
-- ============================================================================

create table if not exists company_invites (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies(id) on delete cascade,
  email        text not null,
  role_key     text not null check (role_key in
                 ('owner','accountant','project_coordinator','cashier','investor','auditor')),
  -- for an investor invite: which investor record this login represents
  investor_id  uuid references investors(id) on delete cascade,
  invited_by   uuid references auth.users(id) on delete set null,
  invited_at   timestamptz not null default now(),
  claimed_at   timestamptz,
  claimed_by   uuid references auth.users(id) on delete set null,
  revoked_at   timestamptz,
  unique (company_id, email)
);
create index if not exists invites_email_idx on company_invites (lower(email));

grant select, insert, update, delete on company_invites to authenticated;
alter table company_invites enable row level security;

drop policy if exists invites_select on company_invites;
create policy invites_select on company_invites for select to authenticated
  using (public.company_has_right(company_id,'manage_members')
         or lower(email) = lower(coalesce((auth.jwt() ->> 'email'), '')));
drop policy if exists invites_write on company_invites;
create policy invites_write on company_invites for all to authenticated
  using (public.company_has_right(company_id,'manage_members'))
  with check (public.company_has_right(company_id,'manage_members'));

-- ---------------------------------------------------------------------------
-- claim_invites — called on login. Grants membership for any open invite that
-- matches the caller's own verified email, and nothing else.
-- ---------------------------------------------------------------------------
create or replace function public.claim_invites()
returns int language plpgsql security definer set search_path = public as $$
declare r record; n int := 0; v_email text;
begin
  if auth.uid() is null then return 0; end if;
  select email into v_email from auth.users where id = auth.uid();
  if v_email is null then return 0; end if;

  for r in
    select * from company_invites
     where lower(email) = lower(v_email)
       and claimed_at is null and revoked_at is null
  loop
    insert into company_members (company_id, user_id, role_key)
    values (r.company_id, auth.uid(), r.role_key)
    on conflict (company_id, user_id) do nothing;

    -- an investor login is tied to their own investor record, which is what
    -- makes "show me only my money" possible
    if r.investor_id is not null then
      update investors set linked_user_id = auth.uid()
       where id = r.investor_id and company_id = r.company_id;
    end if;

    update company_invites
       set claimed_at = now(), claimed_by = auth.uid()
     where id = r.id;
    n := n + 1;
  end loop;
  return n;
end; $$;

-- ---------------------------------------------------------------------------
-- company_people — the members list, with who each investor login belongs to.
-- ---------------------------------------------------------------------------
create or replace function public.company_people(p_company uuid)
returns table (
  user_id uuid, email text, full_name text, role_key text,
  investor_name text, is_you boolean, joined timestamptz)
language sql stable security definer set search_path = public as $$
  select m.user_id, p.email, p.full_name, m.role_key,
         i.display_name, m.user_id = auth.uid(), m.created_at
    from company_members m
    left join profiles p on p.id = m.user_id
    left join investors i on i.linked_user_id = m.user_id and i.company_id = m.company_id
   where m.company_id = p_company
     and public.company_is_member(p_company)
   order by m.created_at;
$$;

-- ---------------------------------------------------------------------------
-- can_see_internal_book — one place that answers it, so no screen invents its
-- own rule. Staff always may; an investor only when the owner flips the switch.
-- ---------------------------------------------------------------------------
create or replace function public.can_see_internal_book(p_company uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select case
    when public.company_has_right(p_company,'view_management_book') then true
    when public.company_role(p_company) = 'investor'
      then coalesce((select show_internal_to_investors from companies where id = p_company), false)
    else false
  end;
$$;

revoke all on function public.claim_invites()                from public, anon;
revoke all on function public.company_people(uuid)           from public, anon;
revoke all on function public.can_see_internal_book(uuid)    from public, anon;
grant execute on function public.claim_invites(),
                         public.company_people(uuid),
                         public.can_see_internal_book(uuid) to authenticated;
