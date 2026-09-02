-- Phase 3b — the chart of accounts stops being one restaurant's chart.
--
-- Until now every company created by this app got the same 90 accounts, with
-- "Sales - Food (Dine-in)" and "Kitchen / Plant Equipment" baked in. A retail
-- shop or a consultant signing up got a chart that was wrong on its face.
--
-- Three things happen here.
--
-- 1. sub_group becomes a real key, not a piece of English.
--    The recipe engine picks accounts by sub_group ('Cash & Bank', 'Trade
--    Payables', ...). Those strings were free text: create_account accepted
--    anything, so a user could type "Kitchen Costs" and quietly create an
--    account no picker would ever offer and no report section owned. They are
--    now rows in account_sub_groups, referenced by a foreign key, with the
--    report section (account_group) derived from them by a trigger rather than
--    copied from a sibling account — which returned NULL whenever the company
--    had no account in that sub_group yet.
--
-- 2. The chart becomes data: a universal core plus one overlay per industry.
--    Seeding a company is core UNION its industry, industry winning on a shared
--    code. That is what lets 1430 be "Kitchen / Plant Equipment" for a
--    restaurant and "Plant & Machinery" for a factory while staying the same
--    code in the same report section — so reports, recipes and the two-book
--    logic are untouched by the choice of industry.
--
-- 3. An existing company can adopt a template later (apply_chart_template).
--    It only ADDS what is missing. It never renames an account that is already
--    in use, because a renamed account silently changes the meaning of every
--    entry already posted to it.
--
-- Nothing here touches an existing company's accounts. The four companies that
-- exist today were all seeded from the restaurant list, so they are labelled
-- 'restaurant' — a description of what they already have, not a change to it.

-- ---------------------------------------------------------------------------
-- 1. The report sections, as keys
-- ---------------------------------------------------------------------------

create table if not exists public.account_sub_groups (
  key           text primary key,
  account_group text not null,
  account_type  text not null
                  check (account_type in ('asset','liability','equity','income','expense')),
  label         text not null,
  hint          text,
  sort          int  not null default 0
);

comment on table public.account_sub_groups is
  'The report sections an account can belong to. accounts.sub_group is a key '
  'into this table, not free text — the recipe engine selects accounts by it.';

insert into public.account_sub_groups (key, account_group, account_type, label, hint, sort) values
  ('Cash & Bank','Current Assets','asset','Cash & Bank','Bank accounts and cash boxes.',100),
  ('Trade Receivables','Current Assets','asset','Trade Receivables','Money customers owe you.',110),
  ('Inventory','Current Assets','asset','Inventory','Goods and materials you are holding.',120),
  ('Loans & Advances (Current)','Current Assets','asset','Loans & Advances','Money paid out that is expected back within a year.',130),
  ('Other Current Assets','Current Assets','asset','Other Current Assets','Prepaid costs, tax refunds due, anything else short-term.',140),
  ('Property Plant & Equipment','Non-Current Assets','asset','Property, Plant & Equipment','Things you own and use for years.',200),
  ('Accumulated Depreciation','Non-Current Assets','asset','Accumulated Depreciation','The wear written off against fixed assets so far.',210),
  ('Capital Work in Progress','Non-Current Assets','asset','Capital Work in Progress','Cost of something being built, until it is ready to use.',220),
  ('Capital Advances','Non-Current Assets','asset','Capital Advances','Advances paid for assets not yet received.',230),
  ('Deposits','Non-Current Assets','asset','Deposits','Refundable deposits — rent, electricity, gas.',240),
  ('Trade Payables','Current Liabilities','liability','Trade Payables','Money you owe suppliers.',300),
  ('Other Current Liabilities','Current Liabilities','liability','Other Current Liabilities','Accruals, salaries due, customer advances.',310),
  ('Statutory Dues','Current Liabilities','liability','Statutory Dues','GST, TDS, PF, ESI and other government dues.',320),
  ('Short Term Borrowings','Current Liabilities','liability','Short Term Borrowings','Overdrafts and loans repayable within a year.',330),
  ('Long Term Borrowings','Non-Current Liabilities','liability','Long Term Borrowings','Term loans repayable over more than a year.',340),
  ('Partners Capital','Owners Funds','equity','Capital','What the owners have put in.',400),
  ('Reserves & Surplus','Owners Funds','equity','Reserves & Surplus','Profits kept in the business.',410),
  ('Drawings','Owners Funds','equity','Drawings','What the owners have taken out.',420),
  ('Revenue from Operations','Revenue','income','Revenue','What the business earns from what it does.',500),
  ('Other Income','Other Income','income','Other Income','Interest, scrap, anything outside the main trade.',510),
  ('Cost of Goods Sold','Cost of Sales','expense','Cost of Sales','What the sales themselves cost you.',600),
  ('Employee Cost','Operating','expense','Employee Cost','Salaries, wages, welfare, PF and ESI.',610),
  ('Occupancy Cost','Operating','expense','Occupancy Cost','Rent, property tax, maintenance of premises.',620),
  ('Utilities','Operating','expense','Utilities','Electricity, water, fuel, telephone, internet.',630),
  ('Selling & Marketing','Operating','expense','Selling & Marketing','Getting customers and getting goods to them.',640),
  ('Administrative','Operating','expense','Administrative','Running costs that are not any of the above.',650),
  ('Finance Cost','Finance','expense','Finance Cost','Bank charges and interest.',660),
  ('Depreciation & Amortisation','Non-Cash','expense','Depreciation','Wear on fixed assets — a cost with no money moving.',670),
  ('Preliminary & Pre-operative','Pre-operative','expense','Pre-operative','Costs incurred before the business opened.',680)
on conflict (key) do update
  set account_group = excluded.account_group,
      account_type  = excluded.account_type,
      label         = excluded.label,
      hint          = excluded.hint,
      sort          = excluded.sort;

alter table public.account_sub_groups enable row level security;
grant select on public.account_sub_groups to authenticated;
drop policy if exists asg_read on public.account_sub_groups;
create policy asg_read on public.account_sub_groups for select to authenticated using (true);

-- Every sub_group in use today is in the list above; this fails loudly if that
-- ever stops being true rather than silently dropping the constraint.
do $$
declare v_missing text;
begin
  select string_agg(distinct a.sub_group, ', ') into v_missing
    from public.accounts a
    left join public.account_sub_groups g on g.key = a.sub_group
   where g.key is null;
  if v_missing is not null then
    raise exception 'These report sections are in use but not in the list: %', v_missing;
  end if;
end $$;

alter table public.accounts
  drop constraint if exists accounts_sub_group_fkey;
alter table public.accounts
  add constraint accounts_sub_group_fkey
  foreign key (sub_group) references public.account_sub_groups(key);

-- account_group is now derived, never typed. One source of truth means the
-- trial balance and the balance sheet cannot disagree about where an account
-- sits, whatever route created it.
create or replace function public.account_group_follows_sub_group()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  select g.account_group into new.account_group
    from account_sub_groups g where g.key = new.sub_group;
  if new.account_group is null then
    raise exception 'There is no report section called "%".', new.sub_group;
  end if;
  return new;
end;
$$;

drop trigger if exists accounts_group_follows_sub_group on public.accounts;
create trigger accounts_group_follows_sub_group
  before insert or update of sub_group on public.accounts
  for each row execute function public.account_group_follows_sub_group();

alter table public.accounts alter column sub_group set not null;
alter table public.accounts alter column account_group set not null;

-- ---------------------------------------------------------------------------
-- 2. The templates
-- ---------------------------------------------------------------------------

create table if not exists public.chart_templates (
  key              text primary key,
  name             text not null,
  blurb            text not null,
  is_base          boolean not null default false,
  default_features jsonb   not null default '{}'::jsonb,
  sort             int     not null default 0,
  is_active        boolean not null default true
);

create table if not exists public.chart_template_accounts (
  template_key   text not null references public.chart_templates(key) on delete cascade,
  code           text not null,
  name           text not null,
  account_type   text not null
                   check (account_type in ('asset','liability','equity','income','expense')),
  sub_group      text not null references public.account_sub_groups(key),
  normal_balance char(1) not null check (normal_balance in ('D','C')),
  capex_role     text,
  is_system      boolean not null default false,
  primary key (template_key, code)
);

comment on table public.chart_template_accounts is
  'A company gets core UNION its industry, industry winning where both define '
  'the same code. Report section comes from account_sub_groups, so an overlay '
  'can rename an account but cannot move it somewhere reports do not expect.';

alter table public.chart_templates enable row level security;
alter table public.chart_template_accounts enable row level security;
grant select on public.chart_templates to authenticated;
grant select on public.chart_template_accounts to authenticated;
drop policy if exists ct_read on public.chart_templates;
create policy ct_read on public.chart_templates for select to authenticated using (true);
drop policy if exists cta_read on public.chart_template_accounts;
create policy cta_read on public.chart_template_accounts for select to authenticated using (true);

insert into public.chart_templates (key, name, blurb, is_base, default_features, sort) values
  ('core','General business',
   'A plain chart that suits most businesses. Start here if none of the others fit.',
   true,  '{"sales": true}'::jsonb, 10),
  ('restaurant','Restaurant, café or cloud kitchen',
   'Food and beverage sales, kitchen equipment, packing material, aggregator commission.',
   false, '{"sales": true, "inventory": true, "aggregators": true}'::jsonb, 20),
  ('retail','Retail shop',
   'Counter and online sales, stock in trade, shop fittings, gateway commission.',
   false, '{"sales": true, "inventory": true}'::jsonb, 30),
  ('trading','Trading, wholesale or distribution',
   'Goods bought and sold as they are, with freight in and freight out kept apart.',
   false, '{"sales": true, "inventory": true}'::jsonb, 40),
  ('services','Services',
   'Salon, repairs, maintenance, agency — service income, subcontractors, consumables.',
   false, '{"sales": true}'::jsonb, 50),
  ('professional','Professional practice',
   'Consultant, CA, doctor, architect — fees, retainers, associates, unbilled work.',
   false, '{"sales": true}'::jsonb, 60),
  ('manufacturing','Manufacturing or job work',
   'Raw material, work in progress and finished goods kept separate; factory wages and power.',
   false, '{"sales": true, "inventory": true, "payroll": true}'::jsonb, 70)
on conflict (key) do update
  set name = excluded.name, blurb = excluded.blurb, is_base = excluded.is_base,
      default_features = excluded.default_features, sort = excluded.sort;

delete from public.chart_template_accounts;

-- The universal core. Names here are deliberately industry-neutral; an overlay
-- below re-states a code when its trade calls it something else.
insert into public.chart_template_accounts
  (template_key, code, name, account_type, sub_group, normal_balance, capex_role, is_system) values
  ('core','1010','Bank - Current A/c','asset','Cash & Bank','D',null,false),
  ('core','1020','Cash in Hand','asset','Cash & Bank','D',null,false),
  ('core','1030','Bank - Secondary A/c','asset','Cash & Bank','D',null,false),
  ('core','1210','Trade Receivables (Customers)','asset','Trade Receivables','D',null,false),
  ('core','1220','Advance to Related Party (Returnable)','asset','Loans & Advances (Current)','D',null,false),
  ('core','1230','Advance to Suppliers (Revenue)','asset','Loans & Advances (Current)','D',null,false),
  ('core','1240','Staff Advances','asset','Loans & Advances (Current)','D',null,false),
  ('core','1250','Other Advances Recoverable','asset','Loans & Advances (Current)','D',null,false),
  ('core','1310','GST Input Credit (ITC)','asset','Other Current Assets','D',null,false),
  ('core','1320','TDS / Income Tax Receivable','asset','Other Current Assets','D',null,false),
  ('core','1330','Prepaid Expenses','asset','Other Current Assets','D',null,false),
  ('core','1410','Land & Building','asset','Property Plant & Equipment','D','ppe',false),
  ('core','1420','Leasehold Improvements','asset','Property Plant & Equipment','D','ppe',false),
  ('core','1430','Plant & Equipment','asset','Property Plant & Equipment','D','ppe',false),
  ('core','1440','Furniture & Fixtures','asset','Property Plant & Equipment','D','ppe',false),
  ('core','1450','Electrical & Plumbing Installations','asset','Property Plant & Equipment','D','ppe',false),
  ('core','1460','Air Conditioning & HVAC','asset','Property Plant & Equipment','D','ppe',false),
  ('core','1470','Computers & Software','asset','Property Plant & Equipment','D','ppe',false),
  ('core','1480','Vehicles','asset','Property Plant & Equipment','D','ppe',false),
  ('core','1490','Accumulated Depreciation','asset','Accumulated Depreciation','C','accum_dep',false),
  ('core','1510','Capital Work in Progress - Building','asset','Capital Work in Progress','D','cwip',false),
  ('core','1520','Capital Work in Progress - Fit-out','asset','Capital Work in Progress','D','cwip',false),
  ('core','1610','Capital Advance - Furniture','asset','Capital Advances','D','capital_advance',false),
  ('core','1620','Capital Advance - Equipment','asset','Capital Advances','D','capital_advance',false),
  ('core','1630','Capital Advance - Civil / Interiors','asset','Capital Advances','D','capital_advance',false),
  ('core','1710','Advance for Premises Lease','asset','Deposits','D','deposit',false),
  ('core','1720','Rent / Security Deposit','asset','Deposits','D','deposit',false),
  ('core','1730','Electricity Board Deposit','asset','Deposits','D','deposit',false),
  ('core','2010','Trade Payables - Suppliers','liability','Trade Payables','C',null,false),
  ('core','2020','Expenses Payable / Accruals','liability','Other Current Liabilities','C',null,false),
  ('core','2030','Salary & Wages Payable','liability','Other Current Liabilities','C',null,false),
  ('core','2040','Advance from Customers','liability','Other Current Liabilities','C',null,false),
  ('core','2110','GST Payable (Output)','liability','Statutory Dues','C',null,false),
  ('core','2120','TDS Payable','liability','Statutory Dues','C',null,false),
  ('core','2130','PF / ESI Payable','liability','Statutory Dues','C',null,false),
  ('core','2140','Professional Tax Payable','liability','Statutory Dues','C',null,false),
  ('core','2210','Bank Overdraft / CC Limit','liability','Short Term Borrowings','C',null,false),
  ('core','2220','Unsecured Loan - Investor / Director','liability','Short Term Borrowings','C',null,false),
  ('core','2310','Term Loan - Bank','liability','Long Term Borrowings','C',null,false),
  ('core','2320','Equipment / Vehicle Loan','liability','Long Term Borrowings','C',null,false),
  ('core','3200','Drawings / Capital Withdrawal','equity','Drawings','D',null,false),
  ('core','3300','Reserves & Surplus (Opening)','equity','Reserves & Surplus','C',null,false),
  ('core','4010','Sales','income','Revenue from Operations','C',null,false),
  ('core','4110','Discounts & Sales Returns','income','Revenue from Operations','D',null,false),
  ('core','4210','Interest Income','income','Other Income','C',null,false),
  ('core','4220','Scrap / Miscellaneous Income','income','Other Income','C',null,false),
  ('core','5010','Purchases','expense','Cost of Goods Sold','D',null,false),
  ('core','5110','Salaries & Wages','expense','Employee Cost','D',null,false),
  ('core','5120','Staff Welfare','expense','Employee Cost','D',null,false),
  ('core','5130','PF / ESI Employer Contribution','expense','Employee Cost','D',null,false),
  ('core','5140','Staff Recruitment & Training','expense','Employee Cost','D',null,false),
  ('core','5210','Rent - Premises','expense','Occupancy Cost','D',null,false),
  ('core','5220','Property Tax & Municipal Charges','expense','Occupancy Cost','D',null,false),
  ('core','5230','Common Area Maintenance','expense','Occupancy Cost','D',null,false),
  ('core','5310','Electricity Charges','expense','Utilities','D',null,false),
  ('core','5320','Water Charges','expense','Utilities','D',null,false),
  ('core','5330','Fuel & Gas','expense','Utilities','D',null,false),
  ('core','5340','Telephone & Internet','expense','Utilities','D',null,false),
  ('core','5410','Marketing & Advertising','expense','Selling & Marketing','D',null,false),
  ('core','5430','Printing & Branding','expense','Selling & Marketing','D',null,false),
  ('core','5510','Repairs & Maintenance','expense','Administrative','D',null,false),
  ('core','5520','Housekeeping & Pest Control','expense','Administrative','D',null,false),
  ('core','5530','Professional & Legal Fees','expense','Administrative','D',null,false),
  ('core','5540','Audit Fees','expense','Administrative','D',null,false),
  ('core','5550','Licences, Permits & Statutory Fees','expense','Administrative','D',null,false),
  ('core','5560','Insurance','expense','Administrative','D',null,false),
  ('core','5570','Travel & Conveyance','expense','Administrative','D',null,false),
  ('core','5580','Printing & Stationery','expense','Administrative','D',null,false),
  ('core','5590','Software & Subscriptions','expense','Administrative','D',null,false),
  ('core','5600','Miscellaneous Expenses','expense','Administrative','D',null,false),
  ('core','5710','Bank Charges & Commission','expense','Finance Cost','D',null,false),
  ('core','5720','Interest on Loans','expense','Finance Cost','D',null,false),
  ('core','5810','Depreciation','expense','Depreciation & Amortisation','D',null,false),
  ('core','5910','Incorporation & Registration Fees','expense','Preliminary & Pre-operative','D',null,false),
  ('core','5920','Pre-operative Expenses','expense','Preliminary & Pre-operative','D',null,false),
  ('core','5930','Preliminary Expenses Written Off','expense','Preliminary & Pre-operative','D',null,false),
  ('core','9900','Opening Balance Equalisation','equity','Reserves & Surplus','C',null,true),
  ('core','9910','Exchange Rate Difference','expense','Finance Cost','D',null,true),
  ('core','9920','Suspense / To Be Classified','asset','Other Current Assets','D',null,true);

insert into public.chart_template_accounts
  (template_key, code, name, account_type, sub_group, normal_balance, capex_role, is_system) values
  ('restaurant','1110','Inventory - Food & Beverage','asset','Inventory','D',null,false),
  ('restaurant','1120','Inventory - Consumables & Packing','asset','Inventory','D',null,false),
  ('restaurant','1430','Kitchen / Plant Equipment','asset','Property Plant & Equipment','D','ppe',false),
  ('restaurant','1470','Computers, POS & Software','asset','Property Plant & Equipment','D','ppe',false),
  ('restaurant','1740','Gas / LPG Deposit','asset','Deposits','D','deposit',false),
  ('restaurant','4010','Sales - Food (Dine-in)','income','Revenue from Operations','C',null,false),
  ('restaurant','4020','Sales - Beverages','income','Revenue from Operations','C',null,false),
  ('restaurant','4030','Sales - Takeaway / Parcel','income','Revenue from Operations','C',null,false),
  ('restaurant','4040','Sales - Delivery Aggregators','income','Revenue from Operations','C',null,false),
  ('restaurant','4050','Sales - Catering / Bulk Orders','income','Revenue from Operations','C',null,false),
  ('restaurant','5010','Raw Material - Food Purchases','expense','Cost of Goods Sold','D',null,false),
  ('restaurant','5020','Raw Material - Beverage Purchases','expense','Cost of Goods Sold','D',null,false),
  ('restaurant','5030','Packing & Consumables','expense','Cost of Goods Sold','D',null,false),
  ('restaurant','5040','Closing Stock Adjustment','expense','Cost of Goods Sold','D',null,false),
  ('restaurant','5120','Staff Welfare & Food','expense','Employee Cost','D',null,false),
  ('restaurant','5330','Gas / LPG / Fuel','expense','Utilities','D',null,false),
  ('restaurant','5420','Delivery Aggregator Commission','expense','Selling & Marketing','D',null,false),
  ('restaurant','5430','Printing, Menu & Branding','expense','Selling & Marketing','D',null,false),

  ('retail','1110','Inventory - Stock in Trade','asset','Inventory','D',null,false),
  ('retail','1120','Inventory - Packing Material','asset','Inventory','D',null,false),
  ('retail','1430','Shop Fittings & Equipment','asset','Property Plant & Equipment','D','ppe',false),
  ('retail','1470','Computers, POS & Software','asset','Property Plant & Equipment','D','ppe',false),
  ('retail','4010','Sales - Counter','income','Revenue from Operations','C',null,false),
  ('retail','4020','Sales - Online / Marketplace','income','Revenue from Operations','C',null,false),
  ('retail','4030','Sales - Wholesale / Bulk','income','Revenue from Operations','C',null,false),
  ('retail','5010','Purchases - Goods for Resale','expense','Cost of Goods Sold','D',null,false),
  ('retail','5040','Closing Stock Adjustment','expense','Cost of Goods Sold','D',null,false),
  ('retail','5420','Marketplace & Payment Gateway Commission','expense','Selling & Marketing','D',null,false),

  ('trading','1110','Inventory - Stock in Trade','asset','Inventory','D',null,false),
  ('trading','1430','Warehouse Equipment','asset','Property Plant & Equipment','D','ppe',false),
  ('trading','4010','Sales - Goods','income','Revenue from Operations','C',null,false),
  ('trading','4020','Sales - Exports','income','Revenue from Operations','C',null,false),
  ('trading','5010','Purchases - Goods for Resale','expense','Cost of Goods Sold','D',null,false),
  ('trading','5040','Closing Stock Adjustment','expense','Cost of Goods Sold','D',null,false),
  ('trading','5050','Freight Inward & Clearing','expense','Cost of Goods Sold','D',null,false),
  ('trading','5440','Freight Outward & Delivery','expense','Selling & Marketing','D',null,false),

  ('services','1110','Inventory - Consumables','asset','Inventory','D',null,false),
  ('services','1340','Unbilled Revenue','asset','Other Current Assets','D',null,false),
  ('services','4010','Service Income','income','Revenue from Operations','C',null,false),
  ('services','4020','Annual Maintenance Contract Income','income','Revenue from Operations','C',null,false),
  ('services','5010','Direct Service Costs','expense','Cost of Goods Sold','D',null,false),
  ('services','5020','Subcontractor & Freelancer Charges','expense','Cost of Goods Sold','D',null,false),
  ('services','5030','Consumables Used','expense','Cost of Goods Sold','D',null,false),

  ('professional','1340','Unbilled Fees / Work in Progress','asset','Other Current Assets','D',null,false),
  ('professional','4010','Professional Fees Received','income','Revenue from Operations','C',null,false),
  ('professional','4020','Retainer Income','income','Revenue from Operations','C',null,false),
  ('professional','5010','Direct Assignment Costs','expense','Cost of Goods Sold','D',null,false),
  ('professional','5020','Associate & Sub-consultant Fees','expense','Cost of Goods Sold','D',null,false),
  ('professional','5591','Membership & Professional Subscriptions','expense','Administrative','D',null,false),

  ('manufacturing','1110','Inventory - Raw Materials','asset','Inventory','D',null,false),
  ('manufacturing','1120','Inventory - Stores & Spares','asset','Inventory','D',null,false),
  ('manufacturing','1130','Inventory - Work in Progress','asset','Inventory','D',null,false),
  ('manufacturing','1140','Inventory - Finished Goods','asset','Inventory','D',null,false),
  ('manufacturing','1430','Plant & Machinery','asset','Property Plant & Equipment','D','ppe',false),
  ('manufacturing','1740','Gas / Fuel Deposit','asset','Deposits','D','deposit',false),
  ('manufacturing','4010','Sales - Manufactured Goods','income','Revenue from Operations','C',null,false),
  ('manufacturing','4020','Job Work Income','income','Revenue from Operations','C',null,false),
  ('manufacturing','5010','Raw Material Purchases','expense','Cost of Goods Sold','D',null,false),
  ('manufacturing','5020','Stores, Spares & Consumables','expense','Cost of Goods Sold','D',null,false),
  ('manufacturing','5030','Job Work & Processing Charges','expense','Cost of Goods Sold','D',null,false),
  ('manufacturing','5040','Closing Stock Adjustment','expense','Cost of Goods Sold','D',null,false),
  ('manufacturing','5050','Freight Inward & Clearing','expense','Cost of Goods Sold','D',null,false),
  ('manufacturing','5150','Factory Wages','expense','Employee Cost','D',null,false),
  ('manufacturing','5350','Power & Fuel - Factory','expense','Utilities','D',null,false);

-- An overlay must agree with the core about what kind of account a code is.
-- Re-stating 4010 as an expense would put revenue in the P&L's cost half for
-- one industry only, which no test would notice until a year-end.
do $$
declare v_bad text;
begin
  select string_agg(o.template_key || ' ' || o.code, ', ') into v_bad
    from public.chart_template_accounts o
    join public.chart_template_accounts c
      on c.template_key = 'core' and c.code = o.code
   where o.template_key <> 'core'
     and (o.account_type, o.sub_group, o.normal_balance)
         is distinct from (c.account_type, c.sub_group, c.normal_balance);
  if v_bad is not null then
    raise exception 'These overlay accounts disagree with the core about type or section: %', v_bad;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Which template a company was built from
-- ---------------------------------------------------------------------------

alter table public.companies add column if not exists industry text;
update public.companies set industry = 'restaurant' where industry is null;
alter table public.companies
  drop constraint if exists companies_industry_fkey;
alter table public.companies
  add constraint companies_industry_fkey
  foreign key (industry) references public.chart_templates(key);

-- ---------------------------------------------------------------------------
-- 4. Seeding
-- ---------------------------------------------------------------------------

-- The old single-argument form is dropped, not left beside the new one:
-- `create or replace` with an extra parameter creates an overload, and
-- PostgREST then rejects every call as ambiguous.
drop function if exists public.seed_chart_of_accounts(uuid);

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
                        normal_balance, capex_role, is_bank_or_cash, is_system)
  select p_company, t.code, t.name, t.account_type, t.sub_group,
         t.normal_balance, t.capex_role, (t.sub_group = 'Cash & Bank'), t.is_system
    from (
      select distinct on (code)
             code, name, account_type, sub_group, normal_balance, capex_role, is_system
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

-- Adopting a template after the fact. Adds what is missing and nothing else:
-- an account already carrying posted entries keeps its name, because renaming
-- it would change what every one of those entries appears to say.
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
                        normal_balance, capex_role, is_bank_or_cash, is_system)
  select v_co, t.code, t.name, t.account_type, t.sub_group,
         t.normal_balance, t.capex_role, (t.sub_group = 'Cash & Bank'), t.is_system
    from (
      select distinct on (code)
             code, name, account_type, sub_group, normal_balance, capex_role, is_system
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

-- ---------------------------------------------------------------------------
-- 5. create_company learns which trade it is for
-- ---------------------------------------------------------------------------

create or replace function public.create_company(p_payload jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_org      uuid := (p_payload->>'org_id')::uuid;
  v_start    date := (p_payload->>'books_start_date')::date;
  v_industry text := coalesce(nullif(trim(p_payload->>'industry'), ''), 'core');
  v_fy_from  date;
  v_fy_to    date;
  v_co       uuid;
  v_stat     uuid;
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
  if not exists (select 1 from chart_templates where key = v_industry and is_active) then
    raise exception 'There is no chart of accounts template called "%".', v_industry;
  end if;

  insert into companies (org_id, name, legal_name, legal_form, pan, gstin, state_code,
                         base_currency, books_start_date, lifecycle_phase, industry, created_by)
  values (v_org, trim(p_payload->>'name'),
          nullif(trim(p_payload->>'legal_name'),''),
          nullif(p_payload->>'legal_form',''),
          nullif(upper(trim(p_payload->>'pan')),''),
          nullif(upper(trim(p_payload->>'gstin')),''),
          nullif(p_payload->>'state_code',''),
          coalesce(nullif(p_payload->>'base_currency',''),'INR'),
          v_start,
          coalesce(nullif(p_payload->>'lifecycle_phase',''),'capex'),
          v_industry,
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

  perform public.seed_chart_of_accounts(v_co, v_industry);
  perform public.seed_capital_account(v_co);
  perform public.ensure_funding_accounts(v_co);
  perform public.ensure_internal_cash(v_co);

  -- A shop that sells from day one should not have to go and switch "Sales" on.
  insert into company_features (company_id, feature, enabled, changed_by)
  select v_co, f.key, f.value::boolean, auth.uid()
    from chart_templates ct, jsonb_each_text(ct.default_features) f
   where ct.key = v_industry
     and exists (select 1 from feature_keys fk where fk.key = f.key)
  on conflict (company_id, feature) do nothing;

  return v_co;
end; $$;

revoke all on function public.create_company(jsonb) from public, anon;
grant execute on function public.create_company(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. create_account uses the same list
-- ---------------------------------------------------------------------------

-- Previously account_group was copied from whichever existing account shared
-- the sub_group — and stayed NULL when there was none, so the very first
-- account in a section landed nowhere in the reports. It now comes from
-- account_sub_groups via the trigger, and the sub_group itself is checked
-- here so the user gets a sentence rather than a foreign key violation.
create or replace function public.create_account(p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid := (p_payload->>'company_id')::uuid;
  v_code    text := nullif(trim(p_payload->>'code'), '');
  v_name    text := nullif(trim(regexp_replace(coalesce(p_payload->>'name',''), '\s+', ' ', 'g')), '');
  v_type    text := nullif(p_payload->>'account_type', '');
  v_sub     text := nullif(trim(p_payload->>'sub_group'), '');
  v_nb      text := nullif(p_payload->>'normal_balance', '');
  v_capex   text := nullif(p_payload->>'capex_role', '');
  v_cash    boolean := coalesce((p_payload->>'is_bank_or_cash')::boolean, false);
  v_book    uuid := nullif(p_payload->>'restricted_to_book_id','')::uuid;
  v_expect  text;
  v_id      uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  if not public.company_has_right(v_company, 'edit_coa') then
    raise exception 'Your role cannot change the chart of accounts.';
  end if;

  if v_code is null then raise exception 'Give the account a code.'; end if;
  if v_name is null then raise exception 'Give the account a name.'; end if;
  if v_type not in ('asset','liability','equity','income','expense') then
    raise exception 'Pick what kind of account this is.';
  end if;
  if v_sub is null then raise exception 'Choose where this account belongs in the reports.'; end if;

  select account_type into v_expect from account_sub_groups where key = v_sub;
  if v_expect is null then
    raise exception 'There is no report section called "%".', v_sub;
  end if;
  if v_expect <> v_type then
    raise exception '"%" holds % accounts, so this cannot be a% % account.',
      v_sub, v_expect,
      case when left(v_type, 1) in ('a','e','i','o','u') then 'n' else '' end, v_type;
  end if;

  if exists (select 1 from accounts where company_id = v_company and code = v_code) then
    raise exception 'Code % is already used by another account.', v_code;
  end if;
  if exists (select 1 from accounts
              where company_id = v_company and lower(trim(name)) = lower(v_name)) then
    raise exception 'An account called "%" already exists.', v_name;
  end if;

  if v_nb is null then
    v_nb := case when v_type in ('asset','expense') then 'D' else 'C' end;
  end if;
  if v_nb not in ('D','C') then raise exception 'normal_balance must be D or C.'; end if;

  if v_book is not null
     and not exists (select 1 from books where id = v_book and company_id = v_company) then
    raise exception 'That book does not belong to this company.';
  end if;

  insert into accounts (company_id, code, name, account_type, sub_group,
                        normal_balance, capex_role, is_bank_or_cash, is_active,
                        is_system, restricted_to_book_id)
  values (v_company, v_code, v_name, v_type, v_sub,
          v_nb, v_capex, v_cash, true, false, v_book)
  returning id into v_id;

  perform public.log_master_change(
    v_company, 'account', v_id, 'create',
    format('Added account %s %s', v_code, v_name),
    null,
    (select to_jsonb(a) from accounts a where a.id = v_id));

  return v_id;
end;
$$;

revoke all on function public.create_account(jsonb) from public, anon;
grant execute on function public.create_account(jsonb) to authenticated;
