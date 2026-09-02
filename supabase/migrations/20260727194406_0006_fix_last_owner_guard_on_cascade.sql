-- The last-owner guard was firing on CASCADE deletes, which meant a user who was
-- the sole owner of an organization could never be deleted at all — blocking
-- account closure and any DPDP Act erasure request. The guard should stop a
-- deliberate demotion or removal, not the teardown of the parent row.
--
-- During a cascade the parent (auth.users or organizations) row is already gone,
-- so its absence is the signal that this is a teardown rather than a demotion.
create or replace function public.prevent_last_owner_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare owner_count int; target_org uuid;
begin
  target_org := coalesce(old.org_id, new.org_id);

  if tg_op = 'DELETE' then
    -- cascade from the organization being deleted
    if not exists (select 1 from organizations where id = target_org) then
      return old;
    end if;
    -- cascade from the user being deleted
    if not exists (select 1 from auth.users where id = old.user_id) then
      return old;
    end if;
  end if;

  select count(*) into owner_count from organization_members
    where org_id = target_org and role = 'owner';

  if owner_count <= 1 and old.role = 'owner'
     and (tg_op = 'DELETE' or new.role <> 'owner') then
    raise exception 'cannot remove the last owner of an organization';
  end if;
  return coalesce(new, old);
end; $$;

revoke all on function public.prevent_last_owner_change() from public, anon, authenticated;
