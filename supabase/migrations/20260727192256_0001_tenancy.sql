do $$ begin
  create type org_role as enum ('owner','admin','member','viewer');
exception when duplicate_object then null; end $$;

create table if not exists profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  full_name  text,
  created_at timestamptz not null default now()
);

create table if not exists organizations (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists organization_members (
  org_id     uuid not null references organizations(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       org_role not null default 'member',
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index if not exists org_members_user_idx on organization_members (user_id);

create table if not exists companies (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  name            text not null,
  legal_name      text,
  legal_form      text check (legal_form in
                    ('proprietorship','partnership','llp','pvt_ltd','ltd','trust','society','other')),
  pan             text,
  gstin           text,
  state_code      text,
  base_currency   char(3) not null default 'INR',
  books_start_date date not null,
  lifecycle_phase text not null default 'capex'
                    check (lifecycle_phase in ('capex','transition','operations')),
  settings        jsonb not null default '{}'::jsonb,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now()
);
create index if not exists companies_org_idx on companies (org_id);

create table if not exists company_members (
  company_id uuid not null references companies(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role_key   text not null check (role_key in
               ('owner','accountant','project_coordinator','cashier','investor','auditor')),
  rights     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (company_id, user_id)
);
create index if not exists company_members_user_idx on company_members (user_id);

create table if not exists fiscal_years (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  name       text not null,
  period     daterange not null,
  status     text not null default 'open' check (status in ('open','soft_closed','closed')),
  created_at timestamptz not null default now()
);
create extension if not exists btree_gist;
alter table fiscal_years drop constraint if exists fiscal_years_no_overlap;
alter table fiscal_years add constraint fiscal_years_no_overlap
  exclude using gist (company_id with =, period with &&);

create or replace function public.is_org_member(p_org uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from organization_members
                 where org_id = p_org and user_id = auth.uid());
$$;

create or replace function public.org_role(p_org uuid)
returns text language sql security definer stable set search_path = public as $$
  select role::text from organization_members
  where org_id = p_org and user_id = auth.uid();
$$;

create or replace function public.shares_org_with(p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from organization_members m1
    join organization_members m2 on m1.org_id = m2.org_id
    where m1.user_id = auth.uid() and m2.user_id = p_user);
$$;

create or replace function public.company_is_member(p_company uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from company_members
                 where company_id = p_company and user_id = auth.uid())
      or exists (select 1 from organization_members om
                 join companies c on c.org_id = om.org_id
                 where c.id = p_company and om.user_id = auth.uid()
                   and om.role in ('owner','admin'));
$$;

create or replace function public.company_role(p_company uuid)
returns text language sql security definer stable set search_path = public as $$
  select coalesce(
    (select role_key from company_members
      where company_id = p_company and user_id = auth.uid()),
    (select case when om.role in ('owner','admin') then 'owner' end
       from organization_members om join companies c on c.org_id = om.org_id
      where c.id = p_company and om.user_id = auth.uid()));
$$;

create or replace function public.company_has_right(p_company uuid, p_right text)
returns boolean language sql security definer stable set search_path = public as $$
  select coalesce(
    (select (rights ->> p_right)::boolean from company_members
      where company_id = p_company and user_id = auth.uid()),
    (select om.role in ('owner','admin')
       from organization_members om join companies c on c.org_id = om.org_id
      where c.id = p_company and om.user_id = auth.uid()),
    false);
$$;

create or replace function public.create_organization(p_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare new_org uuid;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  insert into organizations(name, created_by)
    values (coalesce(nullif(trim(p_name),''),'Workspace'), auth.uid())
    returning id into new_org;
  insert into organization_members(org_id, user_id, role) values (new_org, auth.uid(), 'owner');
  return new_org;
end; $$;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare new_org uuid; display text;
begin
  display := coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email,'@',1), 'You');
  insert into public.profiles(id, email, full_name) values (new.id, new.email, display)
    on conflict (id) do nothing;
  insert into public.organizations(name, created_by) values (display || '''s workspace', new.id)
    returning id into new_org;
  insert into public.organization_members(org_id, user_id, role) values (new_org, new.id, 'owner');
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users for each row execute function public.handle_new_user();

create or replace function public.prevent_last_owner_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare owner_count int; target_org uuid;
begin
  target_org := coalesce(old.org_id, new.org_id);
  select count(*) into owner_count from organization_members
    where org_id = target_org and role = 'owner';
  if owner_count <= 1 and old.role = 'owner'
     and (tg_op = 'DELETE' or new.role <> 'owner') then
    raise exception 'cannot remove the last owner of an organization';
  end if;
  return coalesce(new, old);
end; $$;

drop trigger if exists org_members_last_owner on organization_members;
create trigger org_members_last_owner
  before update or delete on organization_members
  for each row execute function public.prevent_last_owner_change();

grant select, insert, update, delete on
  profiles, organizations, organization_members, companies, company_members, fiscal_years
  to authenticated;
grant execute on function
  public.is_org_member(uuid), public.org_role(uuid), public.shares_org_with(uuid),
  public.company_is_member(uuid), public.company_role(uuid),
  public.company_has_right(uuid, text), public.create_organization(text)
  to authenticated;

alter table profiles             enable row level security;
alter table organizations        enable row level security;
alter table organization_members enable row level security;
alter table companies            enable row level security;
alter table company_members      enable row level security;
alter table fiscal_years         enable row level security;

drop policy if exists profiles_select on profiles;
create policy profiles_select on profiles for select to authenticated
  using (id = auth.uid() or public.shares_org_with(id));
drop policy if exists profiles_insert_self on profiles;
create policy profiles_insert_self on profiles for insert to authenticated
  with check (id = auth.uid());
drop policy if exists profiles_update_self on profiles;
create policy profiles_update_self on profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists orgs_select on organizations;
create policy orgs_select on organizations for select to authenticated
  using (public.is_org_member(id));
drop policy if exists orgs_insert on organizations;
create policy orgs_insert on organizations for insert to authenticated
  with check (created_by = auth.uid());
drop policy if exists orgs_update on organizations;
create policy orgs_update on organizations for update to authenticated
  using (public.org_role(id) in ('owner','admin'))
  with check (public.org_role(id) in ('owner','admin'));
drop policy if exists orgs_delete on organizations;
create policy orgs_delete on organizations for delete to authenticated
  using (public.org_role(id) = 'owner');

drop policy if exists members_select on organization_members;
create policy members_select on organization_members for select to authenticated
  using (public.is_org_member(org_id));
drop policy if exists members_write on organization_members;
create policy members_write on organization_members for all to authenticated
  using (public.org_role(org_id) in ('owner','admin'))
  with check (public.org_role(org_id) in ('owner','admin'));

drop policy if exists companies_select on companies;
create policy companies_select on companies for select to authenticated
  using (public.company_is_member(id));
drop policy if exists companies_insert on companies;
create policy companies_insert on companies for insert to authenticated
  with check (public.org_role(org_id) in ('owner','admin'));
drop policy if exists companies_update on companies;
create policy companies_update on companies for update to authenticated
  using (public.company_has_right(id, 'manage_company'))
  with check (public.company_has_right(id, 'manage_company'));
drop policy if exists companies_delete on companies;
create policy companies_delete on companies for delete to authenticated
  using (public.org_role(org_id) = 'owner');

drop policy if exists company_members_select on company_members;
create policy company_members_select on company_members for select to authenticated
  using (public.company_is_member(company_id));
drop policy if exists company_members_write on company_members;
create policy company_members_write on company_members for all to authenticated
  using (public.company_has_right(company_id, 'manage_members'))
  with check (public.company_has_right(company_id, 'manage_members'));

drop policy if exists fy_select on fiscal_years;
create policy fy_select on fiscal_years for select to authenticated
  using (public.company_is_member(company_id));
drop policy if exists fy_write on fiscal_years;
create policy fy_write on fiscal_years for all to authenticated
  using (public.company_has_right(company_id, 'close_period'))
  with check (public.company_has_right(company_id, 'close_period'));
