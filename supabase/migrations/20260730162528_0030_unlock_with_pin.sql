-- The lock screen needs a way to ask "is this the right PIN?". check_pin stays
-- internal; this is the deliberate, throttled front door for it. Five wrong
-- tries lock the PIN for fifteen minutes, which is what keeps a four-digit
-- secret meaningful against a script.
create or replace function public.unlock_with_pin(p_pin text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  return public.check_pin(p_pin);
end;
$$;

revoke all on function public.unlock_with_pin(text) from public, anon;
grant execute on function public.unlock_with_pin(text) to authenticated;
