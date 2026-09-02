-- ============================================================================
-- A forgotten PIN was a dead end, while the lock screen promised it was not.
--
-- PinGate offers "Forgotten it? Sign out and use your email and password
-- instead". Signing back in did nothing: `clear_user_pin` requires the current
-- PIN, so the only way out of the loop was direct database access. The owner
-- hit this for real. The app stated something the software could not do, which
-- is the one rule this project has refused to break everywhere else.
--
-- WHY THIS IS NOT A WEAKENING
-- The PIN is a screen lock in front of an already signed-in session, not the
-- thing protecting the data — RLS and the guarded RPCs do that, server-side,
-- regardless of this screen. Someone who can sign in with the account password
-- has already cleared a higher bar than a four-digit PIN. Making the password
-- a valid way past the PIN matches what the lock screen already claims.
--
-- WHY `auth.mfa_amr_claims` AND NOT THE TOKEN TIME
-- The obvious implementation — "was this token issued recently?" — is wrong.
-- `iat` and `auth.sessions.refreshed_at` both move on every silent token
-- refresh, so a session left open for a day looks freshly authenticated.
-- Measured on this database before writing this:
--
--     session created   2026-08-11 15:03:34
--     session refreshed 2026-08-12 08:08:08   <- moved 17 hours
--     password recorded 2026-08-11 15:03:34   <- did NOT move
--
-- `auth.mfa_amr_claims.created_at` records the actual authentication event and
-- survives refresh unchanged, so it is the only honest source for "did this
-- person just prove they know the password?".
--
-- THE RESIDUAL RISK, STATED
-- The check is per USER, not per session, because `session_id` is a JWT claim
-- whose presence cannot be verified from here without shipping it first. So an
-- attacker holding an already-signed-in session could clear the PIN if the real
-- owner happens to sign in elsewhere within the same five minutes. That window
-- is narrow, requires the attacker to already be inside an authenticated
-- session, and costs them only a screen lock — never data, which RLS still
-- governs. Tightening this to the caller's own session is a one-line change if
-- the claim is later confirmed present.
-- ============================================================================

create or replace function public.clear_user_pin_after_password()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_recent boolean;
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;

  select exists (
    select 1
      from auth.sessions s
      join auth.mfa_amr_claims a on a.session_id = s.id
     where s.user_id = auth.uid()
       and a.authentication_method = 'password'
       and a.created_at > now() - interval '5 minutes'
  ) into v_recent;

  -- Fail CLOSED. No recent password sign-in means the PIN stays, and the app
  -- tells the user to sign out and back in rather than pretending it worked.
  if not v_recent then return false; end if;

  delete from user_pins where user_id = auth.uid();
  return true;
end;
$$;

comment on function public.clear_user_pin_after_password() is
  'Clears the caller''s PIN, but only within five minutes of a real password '
  'sign-in. Makes the recovery route the lock screen already advertises '
  'actually work. Returns false rather than raising when the sign-in is too '
  'old, so the UI can say what to do next.';

-- Supabase grants EXECUTE to `authenticated` by default, and revoking from
-- PUBLIC never touches that — so `authenticated` is named explicitly before
-- being granted back deliberately.
revoke all on function public.clear_user_pin_after_password() from public, anon, authenticated;
grant execute on function public.clear_user_pin_after_password() to authenticated;