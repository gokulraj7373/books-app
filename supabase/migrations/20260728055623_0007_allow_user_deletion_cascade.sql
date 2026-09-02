-- BUG: prevent_last_owner_change() blocked ANY delete of the last owner row —
-- including the cascade fired by deleting the auth.users row itself. Net effect:
-- a user who is the sole owner of an organization could never delete their
-- account. Under the DPDP Act 2023 that is a right-to-erasure problem, not just
-- an inconvenience.
--
-- The guard should stop an ADMIN from demoting/removing the last owner while
-- the user still exists. It should not stand in the way of the user's own
-- account being deleted: if the auth.users row is already gone, the membership
-- row is orphaned and must go with it.
create or replace function public.prevent_last_owner_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare owner_count int; target_org uuid;
begin
  -- cascade from auth.users deletion: the user no longer exists, let it through
  if tg_op = 'DELETE'
     and not exists (select 1 from auth.users u where u.id = old.user_id) then
    return old;
  end if;

  target_org := coalesce(old.org_id, new.org_id);
  select count(*) into owner_count from organization_members
   where org_id = target_org and role = 'owner';

  if owner_count <= 1 and old.role = 'owner'
     and (tg_op = 'DELETE' or new.role <> 'owner') then
    raise exception 'cannot remove the last owner of an organization';
  end if;
  return coalesce(new, old);
end; $$;

revoke all on function public.prevent_last_owner_change() from public, anon, authenticated;
