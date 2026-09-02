-- CREATE OR REPLACE does not replace a function when the parameter list grows —
-- Postgres treats a new arity as a distinct overload, so 0038/0039 left the
-- old versions sitting alongside the new ones, which made every call from
-- PostgREST (2 args) ambiguous between them. Removing the old arities leaves
-- exactly one version of each, with p_solo trailing and defaulted, so nothing
-- that calls these without knowing about p_solo breaks.
drop function if exists public.account_balances(uuid, uuid, date, date);
drop function if exists public.capex_summary(uuid, uuid);
drop function if exists public.cash_book(uuid, uuid, date, date);
drop function if exists public.company_alerts(uuid, uuid);
drop function if exists public.general_ledger(uuid, uuid, uuid, date, date);
drop function if exists public.live_alerts(uuid, uuid);
drop function if exists public.open_bills(uuid, uuid);
drop function if exists public.party_balances(uuid, uuid);
drop function if exists public.party_statement(uuid, uuid, uuid, date, date);
drop function if exists public.supplier_advances(uuid, uuid);
drop function if exists public.unapplied_credits(uuid, uuid);
