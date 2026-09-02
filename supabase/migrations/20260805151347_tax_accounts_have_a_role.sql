-- Phase 3c — the tax accounts get a stable role.
--
-- A GST or TDS entry has to find three specific accounts: where input credit is
-- collected, where output GST is owed, and where TDS withheld from a supplier
-- sits until it is paid to the government. The app could look them up by code
-- (1310, 2110, 2120) or by name, and both are wrong: a company may renumber its
-- chart, and it may certainly rename an account — `update_account` allows it and
-- always has, because nothing was supposed to key off a name.
--
-- `capex_role` already solves this exact problem for the CapEx screen. This is
-- the same idea for tax: a small, checked column the app matches on, so the
-- account can be called anything and numbered anything.
--
-- A company may have at most ONE account of each role. Two "GST Input Credit"
-- accounts would split the claim in half and neither figure would be the real
-- one, so it is a unique index rather than a convention.

alter table public.accounts
  add column if not exists tax_role text;

alter table public.accounts
  drop constraint if exists accounts_tax_role_check;
alter table public.accounts
  add constraint accounts_tax_role_check
  check (tax_role is null or tax_role in ('gst_input','gst_output','tds_payable'));

-- Existing companies: the seeded chart put these at fixed codes, so that is a
-- fact about the data rather than an assumption about it.
update public.accounts set tax_role = 'gst_input'   where code = '1310' and tax_role is null;
update public.accounts set tax_role = 'gst_output'  where code = '2110' and tax_role is null;
update public.accounts set tax_role = 'tds_payable' where code = '2120' and tax_role is null;

drop index if exists accounts_one_account_per_tax_role;
create unique index accounts_one_account_per_tax_role
  on public.accounts (company_id, tax_role)
  where tax_role is not null;

-- New companies get it from the template.
alter table public.chart_template_accounts
  add column if not exists tax_role text;

alter table public.chart_template_accounts
  drop constraint if exists chart_template_accounts_tax_role_check;
alter table public.chart_template_accounts
  add constraint chart_template_accounts_tax_role_check
  check (tax_role is null or tax_role in ('gst_input','gst_output','tds_payable'));

update public.chart_template_accounts set tax_role = 'gst_input'   where code = '1310';
update public.chart_template_accounts set tax_role = 'gst_output'  where code = '2110';
update public.chart_template_accounts set tax_role = 'tds_payable' where code = '2120';

create or replace function public.seed_chart_of_accounts(p_company uuid, p_template text)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  n     int;
  v_tpl text := coalesce(nullif(trim(p_template), ''), 'core');
begin
  -- Defence in depth: this is revoked from every client role below, but assert
  -- membership anyway so it stays safe if a future migration re-grants it.
  if auth.uid() is not null
     and not exists (select 1 from companies c
                     join organization_members om on om.org_id = c.org_id
                     where c.id = p_company and om.user_id = auth.uid()) then
    raise exception 'not permitted to seed accounts for this company';
  end if;

  if not exists (select 1 from chart_templates where key = v_tpl and is_active) then
    raise exception 'There is no chart of accounts template called "%".', v_tpl;
  end if;

  insert into accounts (company_id, code, name, account_type, sub_group,
                        normal_balance, capex_role, tax_role, is_bank_or_cash, is_system)
  select p_company, t.code, t.name, t.account_type, t.sub_group,
         t.normal_balance, t.capex_role, t.tax_role,
         (t.sub_group = 'Cash & Bank'), t.is_system
    from (
      select distinct on (code)
             code, name, account_type, sub_group, normal_balance, capex_role,
             tax_role, is_system
        from chart_template_accounts
       where template_key in ('core', v_tpl)
       order by code, case when template_key = 'core' then 1 else 0 end
    ) t
  on conflict (company_id, code) do nothing;

  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.seed_chart_of_accounts(uuid, text) from public, anon, authenticated;

-- apply_chart_template carries the role too, but only where the company does
-- not already have an account holding it — the unique index would otherwise
-- refuse the whole call for one duplicate row.
create or replace function public.apply_chart_template(p_payload jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_co    uuid := (p_payload->>'company_id')::uuid;
  v_tpl   text := nullif(trim(p_payload->>'template'), '');
  v_name  text;
  n       int;
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  if not public.company_has_right(v_co, 'edit_coa') then
    raise exception 'Your role cannot change the chart of accounts.';
  end if;
  if v_tpl is null then raise exception 'Choose a template.'; end if;

  select name into v_name from chart_templates where key = v_tpl and is_active;
  if v_name is null then
    raise exception 'There is no chart of accounts template called "%".', v_tpl;
  end if;

  insert into accounts (company_id, code, name, account_type, sub_group,
                        normal_balance, capex_role, tax_role, is_bank_or_cash, is_system)
  select v_co, t.code, t.name, t.account_type, t.sub_group,
         t.normal_balance, t.capex_role,
         case when t.tax_role is null
               or exists (select 1 from accounts a
                           where a.company_id = v_co and a.tax_role = t.tax_role)
              then null else t.tax_role end,
         (t.sub_group = 'Cash & Bank'), t.is_system
    from (
      select distinct on (code)
             code, name, account_type, sub_group, normal_balance, capex_role,
             tax_role, is_system
        from chart_template_accounts
       where template_key = v_tpl
       order by code, template_key
    ) t
   where not exists (select 1 from accounts a
                      where a.company_id = v_co
                        and (a.code = t.code or lower(trim(a.name)) = lower(t.name)));

  get diagnostics n = row_count;

  if n > 0 then
    perform public.log_master_change(
      v_co, 'account', v_co, 'create',
      format('Added %s account%s from the "%s" template.',
             n, case when n = 1 then '' else 's' end, v_name),
      null, jsonb_build_object('template', v_tpl, 'accounts_added', n));
  end if;

  return n;
end;
$$;

revoke all on function public.apply_chart_template(jsonb) from public, anon;
grant execute on function public.apply_chart_template(jsonb) to authenticated;

-- Which account plays which tax role, and whether the company can post GST or
-- TDS at all. The screens ask this rather than guessing at codes, and it is the
-- single place that decides input credit is claimable: a composition dealer and
-- a 5%-scheme restaurant both charge GST and neither may claim it back, so for
-- them the tax on a purchase is part of its cost, not an asset.
create or replace function public.tax_posting_setup(p_company uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case when public.company_is_member(p_company) then jsonb_build_object(
    'gst_input',   (select id from accounts
                     where company_id = p_company and tax_role = 'gst_input'   and is_active),
    'gst_output',  (select id from accounts
                     where company_id = p_company and tax_role = 'gst_output'  and is_active),
    'tds_payable', (select id from accounts
                     where company_id = p_company and tax_role = 'tds_payable' and is_active),
    'itc_claimable', (
      select coalesce(t.gst_regime, 'unregistered') = 'regular'
             and not coalesce(t.itc_blocked_by_scheme, false)
        from companies c
        left join company_tax_profile t on t.company_id = c.id
       where c.id = p_company)
  ) end;
$$;

revoke all on function public.tax_posting_setup(uuid) from public, anon;
grant execute on function public.tax_posting_setup(uuid) to authenticated;
