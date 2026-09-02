-- ============================================================================
-- RLS: evaluate auth.uid() once per query, not once per row.
--
-- Seven policies call `auth.uid()` (or `auth.jwt()`) bare in their expression.
-- Postgres treats that as a per-row call, so scanning a thousand rows calls it
-- a thousand times. Wrapping it in a scalar subquery — `(select auth.uid())` —
-- lets the planner hoist it into an InitPlan and evaluate it once.
--
-- THIS CHANGES NO PERMISSIONS. `auth.uid()` is STABLE; the value is identical
-- within a statement either way. Only the number of times it is computed
-- changes. Every USING and WITH CHECK expression below is otherwise a
-- character-for-character copy of what was already deployed, read back out of
-- pg_policy rather than retyped from memory.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS DELIBERATELY DOES NOT DO
--
-- The advisor also reports `multiple_permissive_policies` on ten tables, where
-- a `_select` policy and a `FOR ALL` `_write` policy both apply to reads. The
-- obvious tidy-up is to narrow the write policies to INSERT/UPDATE/DELETE.
--
-- That is NOT done here, because it would change who can read. Permissive
-- policies are ORed, so today a read is allowed by `_select` OR `_write`.
-- Removing `_write` from SELECT is only safe if `_select` is a superset — and
-- on `company_members` it is not:
--
--     company_members_select : user_id = auth.uid() OR company_is_staff(...)
--     company_members_write  : company_has_right(..., 'manage_members')
--     company_is_staff       : view_ledger, view_reports, view_cash_bank,
--                              draft_entry, edit_coa   -- NOT manage_members
--
-- Rights are free-form jsonb, so someone granted `manage_members` alone would
-- silently lose sight of the roster they are supposed to manage. The gain is a
-- second policy evaluation on a table holding single-digit rows; the risk is a
-- permission regression that no current test would catch. Not worth it. Revisit
-- only with a test that asserts every role's visible row count before and
-- after, per table.
-- ============================================================================

-- ---- profiles --------------------------------------------------------------
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (((id = (select auth.uid())) OR shares_org_with(id)));

drop policy if exists profiles_insert_self on public.profiles;
create policy profiles_insert_self on public.profiles for insert to authenticated
  with check ((id = (select auth.uid())));

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles for update to authenticated
  using ((id = (select auth.uid())))
  with check ((id = (select auth.uid())));

-- ---- organizations ---------------------------------------------------------
drop policy if exists orgs_insert on public.organizations;
create policy orgs_insert on public.organizations for insert to authenticated
  with check ((created_by = (select auth.uid())));

-- ---- company_members -------------------------------------------------------
drop policy if exists company_members_select on public.company_members;
create policy company_members_select on public.company_members for select to authenticated
  using (((user_id = (select auth.uid())) OR company_is_staff(company_id)));

-- ---- company_invites -------------------------------------------------------
drop policy if exists invites_select on public.company_invites;
create policy invites_select on public.company_invites for select to authenticated
  using ((company_has_right(company_id, 'manage_members'::text)
          OR (lower(email) = lower(COALESCE(((select auth.jwt()) ->> 'email'::text), ''::text)))));

-- ---- alert_dismissals ------------------------------------------------------
drop policy if exists ad_own on public.alert_dismissals;
create policy ad_own on public.alert_dismissals for all to authenticated
  using (((user_id = (select auth.uid())) AND company_is_member(company_id)))
  with check (((user_id = (select auth.uid())) AND company_is_member(company_id)));