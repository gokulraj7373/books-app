create or replace function public.default_rights(p_role text)
returns jsonb language sql immutable as $$
  select case p_role
    when 'owner' then jsonb_build_object(
      'manage_company',true,'manage_members',true,'manage_books',true,
      'edit_coa',true,'draft_entry',true,'post_entry',true,'reverse_entry',true,
      'view_ledger',true,'view_reports',true,'view_cash_bank',true,'view_capex',true,
      'view_management_book',true,'promote_entries',true,'close_period',true,
      'unlock_period',true,'import_data',true,'view_audit_trail',true,
      'manage_capital_project',true,'upload_document',true)
    when 'accountant' then jsonb_build_object(
      'edit_coa',true,'draft_entry',true,'post_entry',true,'reverse_entry',true,
      'view_ledger',true,'view_reports',true,'view_cash_bank',true,'view_capex',true,
      'view_management_book',true,'close_period',true,'import_data',true,
      'view_audit_trail',true,'upload_document',true)
    when 'project_coordinator' then jsonb_build_object(
      'draft_entry',true,'view_ledger',true,'view_reports',true,'view_capex',true,
      'manage_capital_project',true,'upload_document',true)
    when 'cashier' then jsonb_build_object(
      'draft_entry',true,'view_cash_bank',true,'upload_document',true)
    when 'investor' then jsonb_build_object(
      'view_own_capital',true,'view_published_reports',true)
    when 'auditor' then jsonb_build_object(
      'view_ledger',true,'view_reports',true,'view_cash_bank',true,'view_capex',true,
      'view_audit_trail',true)
    else '{}'::jsonb
  end;
$$;

create or replace function public.apply_default_rights()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.rights is null or new.rights = '{}'::jsonb then
    new.rights := public.default_rights(new.role_key);
  end if;
  return new;
end; $$;

drop trigger if exists company_members_default_rights on company_members;
create trigger company_members_default_rights
  before insert on company_members
  for each row execute function public.apply_default_rights();

create or replace function public.seed_chart_of_accounts(p_company uuid)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into accounts (company_id, code, name, account_type, account_group, sub_group,
                        normal_balance, capex_role, is_bank_or_cash, is_system)
  select p_company, t.code, t.name, t.atype, t.grp, t.sub, t.nb, t.capex,
         (t.sub = 'Cash & Bank'), t.sys
  from (values
    ('1010','Bank - Current A/c','asset','Current Assets','Cash & Bank','D',null,false),
    ('1020','Cash in Hand','asset','Current Assets','Cash & Bank','D',null,false),
    ('1030','Bank - Secondary A/c','asset','Current Assets','Cash & Bank','D',null,false),
    ('1110','Inventory - Food & Beverage','asset','Current Assets','Inventory','D',null,false),
    ('1120','Inventory - Consumables & Packing','asset','Current Assets','Inventory','D',null,false),
    ('1210','Trade Receivables (Customers)','asset','Current Assets','Trade Receivables','D',null,false),
    ('1220','Advance to Related Party (Returnable)','asset','Current Assets','Loans & Advances (Current)','D',null,false),
    ('1230','Advance to Suppliers (Revenue)','asset','Current Assets','Loans & Advances (Current)','D',null,false),
    ('1240','Staff Advances','asset','Current Assets','Loans & Advances (Current)','D',null,false),
    ('1250','Other Advances Recoverable','asset','Current Assets','Loans & Advances (Current)','D',null,false),
    ('1310','GST Input Credit (ITC)','asset','Current Assets','Other Current Assets','D',null,false),
    ('1320','TDS / Income Tax Receivable','asset','Current Assets','Other Current Assets','D',null,false),
    ('1330','Prepaid Expenses','asset','Current Assets','Other Current Assets','D',null,false),
    ('1410','Land & Building','asset','Non-Current Assets','Property Plant & Equipment','D','ppe',false),
    ('1420','Leasehold Improvements','asset','Non-Current Assets','Property Plant & Equipment','D','ppe',false),
    ('1430','Kitchen / Plant Equipment','asset','Non-Current Assets','Property Plant & Equipment','D','ppe',false),
    ('1440','Furniture & Fixtures','asset','Non-Current Assets','Property Plant & Equipment','D','ppe',false),
    ('1450','Electrical & Plumbing Installations','asset','Non-Current Assets','Property Plant & Equipment','D','ppe',false),
    ('1460','Air Conditioning & HVAC','asset','Non-Current Assets','Property Plant & Equipment','D','ppe',false),
    ('1470','Computers, POS & Software','asset','Non-Current Assets','Property Plant & Equipment','D','ppe',false),
    ('1480','Vehicles','asset','Non-Current Assets','Property Plant & Equipment','D','ppe',false),
    ('1490','Accumulated Depreciation','asset','Non-Current Assets','Accumulated Depreciation','C','accum_dep',false),
    ('1510','Capital Work in Progress - Building','asset','Non-Current Assets','Capital Work in Progress','D','cwip',false),
    ('1520','Capital Work in Progress - Fit-out','asset','Non-Current Assets','Capital Work in Progress','D','cwip',false),
    ('1610','Capital Advance - Furniture','asset','Non-Current Assets','Capital Advances','D','capital_advance',false),
    ('1620','Capital Advance - Equipment','asset','Non-Current Assets','Capital Advances','D','capital_advance',false),
    ('1630','Capital Advance - Civil / Interiors','asset','Non-Current Assets','Capital Advances','D','capital_advance',false),
    ('1710','Advance for Premises Lease','asset','Non-Current Assets','Deposits','D','deposit',false),
    ('1720','Rent / Security Deposit','asset','Non-Current Assets','Deposits','D','deposit',false),
    ('1730','Electricity Board Deposit','asset','Non-Current Assets','Deposits','D','deposit',false),
    ('1740','Gas / LPG Deposit','asset','Non-Current Assets','Deposits','D','deposit',false),
    ('2010','Trade Payables - Suppliers','liability','Current Liabilities','Trade Payables','C',null,false),
    ('2020','Expenses Payable / Accruals','liability','Current Liabilities','Other Current Liabilities','C',null,false),
    ('2030','Salary & Wages Payable','liability','Current Liabilities','Other Current Liabilities','C',null,false),
    ('2040','Advance from Customers','liability','Current Liabilities','Other Current Liabilities','C',null,false),
    ('2110','GST Payable (Output)','liability','Current Liabilities','Statutory Dues','C',null,false),
    ('2120','TDS Payable','liability','Current Liabilities','Statutory Dues','C',null,false),
    ('2130','PF / ESI Payable','liability','Current Liabilities','Statutory Dues','C',null,false),
    ('2140','Professional Tax Payable','liability','Current Liabilities','Statutory Dues','C',null,false),
    ('2210','Bank Overdraft / CC Limit','liability','Current Liabilities','Short Term Borrowings','C',null,false),
    ('2220','Unsecured Loan - Investor / Director','liability','Current Liabilities','Short Term Borrowings','C',null,false),
    ('2310','Term Loan - Bank','liability','Non-Current Liabilities','Long Term Borrowings','C',null,false),
    ('2320','Equipment / Vehicle Loan','liability','Non-Current Liabilities','Long Term Borrowings','C',null,false),
    ('3200','Drawings / Capital Withdrawal','equity','Owners Funds','Drawings','D',null,false),
    ('3300','Reserves & Surplus (Opening)','equity','Owners Funds','Reserves & Surplus','C',null,false),
    ('4010','Sales - Food (Dine-in)','income','Revenue','Revenue from Operations','C',null,false),
    ('4020','Sales - Beverages','income','Revenue','Revenue from Operations','C',null,false),
    ('4030','Sales - Takeaway / Parcel','income','Revenue','Revenue from Operations','C',null,false),
    ('4040','Sales - Delivery Aggregators','income','Revenue','Revenue from Operations','C',null,false),
    ('4050','Sales - Catering / Bulk Orders','income','Revenue','Revenue from Operations','C',null,false),
    ('4110','Discounts & Sales Returns','income','Revenue','Revenue from Operations','D',null,false),
    ('4210','Interest Income','income','Other Income','Other Income','C',null,false),
    ('4220','Scrap / Miscellaneous Income','income','Other Income','Other Income','C',null,false),
    ('5010','Raw Material - Food Purchases','expense','Cost of Sales','Cost of Goods Sold','D',null,false),
    ('5020','Raw Material - Beverage Purchases','expense','Cost of Sales','Cost of Goods Sold','D',null,false),
    ('5030','Packing & Consumables','expense','Cost of Sales','Cost of Goods Sold','D',null,false),
    ('5040','Closing Stock Adjustment','expense','Cost of Sales','Cost of Goods Sold','D',null,false),
    ('5110','Salaries & Wages','expense','Operating','Employee Cost','D',null,false),
    ('5120','Staff Welfare & Food','expense','Operating','Employee Cost','D',null,false),
    ('5130','PF / ESI Employer Contribution','expense','Operating','Employee Cost','D',null,false),
    ('5140','Staff Recruitment & Training','expense','Operating','Employee Cost','D',null,false),
    ('5210','Rent - Premises','expense','Operating','Occupancy Cost','D',null,false),
    ('5220','Property Tax & Municipal Charges','expense','Operating','Occupancy Cost','D',null,false),
    ('5230','Common Area Maintenance','expense','Operating','Occupancy Cost','D',null,false),
    ('5310','Electricity Charges','expense','Operating','Utilities','D',null,false),
    ('5320','Water Charges','expense','Operating','Utilities','D',null,false),
    ('5330','Gas / LPG / Fuel','expense','Operating','Utilities','D',null,false),
    ('5340','Telephone & Internet','expense','Operating','Utilities','D',null,false),
    ('5410','Marketing & Advertising','expense','Operating','Selling & Marketing','D',null,false),
    ('5420','Delivery Aggregator Commission','expense','Operating','Selling & Marketing','D',null,false),
    ('5430','Printing, Menu & Branding','expense','Operating','Selling & Marketing','D',null,false),
    ('5510','Repairs & Maintenance','expense','Operating','Administrative','D',null,false),
    ('5520','Housekeeping & Pest Control','expense','Operating','Administrative','D',null,false),
    ('5530','Professional & Legal Fees','expense','Operating','Administrative','D',null,false),
    ('5540','Audit Fees','expense','Operating','Administrative','D',null,false),
    ('5550','Licences, Permits & Statutory Fees','expense','Operating','Administrative','D',null,false),
    ('5560','Insurance','expense','Operating','Administrative','D',null,false),
    ('5570','Travel & Conveyance','expense','Operating','Administrative','D',null,false),
    ('5580','Printing & Stationery','expense','Operating','Administrative','D',null,false),
    ('5590','Software & Subscriptions','expense','Operating','Administrative','D',null,false),
    ('5600','Miscellaneous Expenses','expense','Operating','Administrative','D',null,false),
    ('5710','Bank Charges & Commission','expense','Finance','Finance Cost','D',null,false),
    ('5720','Interest on Loans','expense','Finance','Finance Cost','D',null,false),
    ('5810','Depreciation','expense','Non-Cash','Depreciation & Amortisation','D',null,false),
    ('5910','Incorporation & Registration Fees','expense','Pre-operative','Preliminary & Pre-operative','D',null,false),
    ('5920','Pre-operative Expenses','expense','Pre-operative','Preliminary & Pre-operative','D',null,false),
    ('5930','Preliminary Expenses Written Off','expense','Pre-operative','Preliminary & Pre-operative','D',null,false),
    ('9900','Opening Balance Equalisation','equity','Owners Funds','Reserves & Surplus','C',null,true),
    ('9910','Exchange Rate Difference','expense','Finance','Finance Cost','D',null,true),
    ('9920','Suspense / To Be Classified','asset','Current Assets','Other Current Assets','D',null,true)
  ) as t(code,name,atype,grp,sub,nb,capex,sys)
  on conflict (company_id, code) do nothing;

  get diagnostics n = row_count;
  return n;
end; $$;

create or replace function public.create_company(p_payload jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_org    uuid := (p_payload->>'org_id')::uuid;
  v_start  date := (p_payload->>'books_start_date')::date;
  v_fy_from date;
  v_fy_to   date;
  v_co     uuid;
  v_stat   uuid;
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
  values (v_co,
          'FY ' || to_char(v_fy_from,'YYYY') || '-' || to_char(v_fy_to - 1,'YY'),
          daterange(v_fy_from, v_fy_to, '[)'));

  insert into books (company_id, code, name, kind, is_statutory)
  values (v_co, 'STAT', 'Statutory Book', 'primary', true) returning id into v_stat;

  insert into books (company_id, code, name, kind, base_book_id)
  values (v_co, 'MGMT', 'Management Book', 'adjustment', v_stat);

  perform public.seed_chart_of_accounts(v_co);
  return v_co;
end; $$;

revoke all on function public.default_rights(text)          from public, anon;
revoke all on function public.apply_default_rights()        from public, anon, authenticated;
revoke all on function public.seed_chart_of_accounts(uuid)  from public, anon;
revoke all on function public.create_company(jsonb)         from public, anon;
grant execute on function public.default_rights(text),
                         public.seed_chart_of_accounts(uuid),
                         public.create_company(jsonb) to authenticated;
