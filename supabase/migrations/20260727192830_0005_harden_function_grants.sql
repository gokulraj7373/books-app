-- Postgres grants EXECUTE on new functions to PUBLIC by default, which on
-- Supabase means the unauthenticated `anon` role can invoke every one of them
-- via /rest/v1/rpc/*. Our functions do check auth.uid(), but relying on an
-- in-body check to protect an endpoint that should not be reachable at all is
-- defence in the wrong place. Revoke from PUBLIC/anon; grant only what is needed.

-- ---- trigger functions: callable by NOBODY over the API ----
-- (triggers execute as the table owner regardless of these grants)
revoke all on function public.handle_new_user()            from public, anon, authenticated;
revoke all on function public.prevent_last_owner_change()  from public, anon, authenticated;
revoke all on function public.assert_entry_balanced()      from public, anon, authenticated;
revoke all on function public.block_if_posted()            from public, anon, authenticated;
revoke all on function public.block_lines_if_posted()      from public, anon, authenticated;

-- ---- RLS helpers: used inside policies, never needed as REST endpoints ----
revoke all on function public.is_org_member(uuid)                from public, anon;
revoke all on function public.org_role(uuid)                     from public, anon;
revoke all on function public.shares_org_with(uuid)              from public, anon;
revoke all on function public.company_is_member(uuid)            from public, anon;
revoke all on function public.company_role(uuid)                 from public, anon;
revoke all on function public.company_has_right(uuid, text)      from public, anon;

-- ---- business RPCs: signed-in users only ----
revoke all on function public.create_organization(text)          from public, anon;
revoke all on function public.save_journal_entry(jsonb)          from public, anon;
revoke all on function public.verify_chain(uuid, uuid)           from public, anon;
revoke all on function public.reverse_entry(uuid, text)          from public, anon;

grant execute on function
  public.is_org_member(uuid), public.org_role(uuid), public.shares_org_with(uuid),
  public.company_is_member(uuid), public.company_role(uuid),
  public.company_has_right(uuid, text), public.create_organization(text),
  public.save_journal_entry(jsonb), public.verify_chain(uuid, uuid),
  public.reverse_entry(uuid, text)
  to authenticated;

-- ---- btree_gist out of the public schema ----
drop extension if exists btree_gist cascade;
create extension if not exists btree_gist with schema extensions;

-- cascade dropped the fiscal-year overlap guard; put it back
alter table fiscal_years drop constraint if exists fiscal_years_no_overlap;
alter table fiscal_years add constraint fiscal_years_no_overlap
  exclude using gist (company_id with =, period with &&);
