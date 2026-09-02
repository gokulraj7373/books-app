-- FIX: 0019 replaced create_company with a wrapper calling create_company_base,
-- which does not exist — signup would have failed at the company step. Restored
-- in full, with the internal cash box added at the end.
create or replace function public.create_company(p_payload jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_org     uuid := (p_payload->>'org_id')::uuid;
  v_start   date := (p_payload->>'books_start_date')::date;
  v_fy_from date;
  v_fy_to   date;
  v_co      uuid;
  v_stat    uuid;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if v_org is null then
    select org_id into v_org from organization_members
     where user_id = auth.uid() order by created_at limit 1;
  end if;
  if v_org is null then raise exception 'no organization for this user'; end if;
  if public.org_role(v_org) not in ('owner','admin') then
    raise exception 'only an organization owner or admin can create a company';
  end if;
  if coalesce(trim(p_payload->>'name'),'') = '' then
    raise exception 'company name is required';
  end if;
  if v_start is null then raise exception 'books_start_date is required'; end if;

  insert into companies (org_id, name, legal_name, legal_form, pan, gstin, state_code,
                         base_currency, books_start_date, lifecycle_phase, created_by)
  values (v_org, trim(p_payload->>'name'),
          nullif(trim(p_payload->>'legal_name'),''),
          nullif(p_payload->>'legal_form',''),
          nullif(upper(trim(p_payload->>'pan')),''),
          nullif(upper(trim(p_payload->>'gstin')),''),
          nullif(p_payload->>'state_code',''),
          coalesce(nullif(p_payload->>'base_currency',''),'INR'),
          v_start,
          coalesce(nullif(p_payload->>'lifecycle_phase',''),'capex'),
          auth.uid())
  returning id into v_co;

  insert into company_members (company_id, user_id, role_key)
  values (v_co, auth.uid(), 'owner');

  if extract(month from v_start) >= 4 then
    v_fy_from := make_date(extract(year from v_start)::int, 4, 1);
  else
    v_fy_from := make_date(extract(year from v_start)::int - 1, 4, 1);
  end if;
  v_fy_to := (v_fy_from + interval '1 year')::date;

  insert into fiscal_years (company_id, name, period)
  values (v_co, 'FY ' || to_char(v_fy_from,'YYYY') || '-' || to_char(v_fy_to - 1,'YY'),
          daterange(v_fy_from, v_fy_to, '[)'));

  insert into books (company_id, code, name, kind, is_statutory)
  values (v_co, 'STAT', 'Statutory Book', 'primary', true) returning id into v_stat;

  insert into books (company_id, code, name, kind, base_book_id)
  values (v_co, 'MGMT', 'Management Book', 'adjustment', v_stat);

  perform public.seed_chart_of_accounts(v_co);
  perform public.seed_capital_account(v_co);
  perform public.ensure_funding_accounts(v_co);
  perform public.ensure_internal_cash(v_co);
  return v_co;
end; $$;

revoke all on function public.create_company(jsonb) from public, anon;
grant execute on function public.create_company(jsonb) to authenticated;
