-- ============================================================================
-- Workbook parity. The gate that decides whether this app can replace the
-- owner's Excel file.
--
-- Loads an illustrative set of 16 opening transactions
--   (08-Jun-2026 -> 25-Jul-2026)
-- and asserts the reporting engine reproduces the workbook's figures exactly:
--
--   Trial Balance  10,00,000 Dr = 10,00,000 Cr
--   Total assets    9,70,000
--   Capital        10,00,000
--   Net loss          -30,000   (only the incorporation fee is an expense)
--   Cash & bank     1,60,000
--   CWIP            5,10,000    (routed via an associated company)
--   Cap. advances     60,000    (furniture supplier)
--   Deposits        1,50,000    (building lease)
--
-- These figures are examples. The books this was built against are not here.
--
--   psql "$DB_URL" -f supabase/tests/workbook_parity.sql
-- ============================================================================

begin;

do $$
declare
  u uuid := '31111111-1111-1111-1111-111111111111';
  v_org uuid; co uuid; stat uuid;
  bank uuid; cap uuid; lease uuid; rp uuid; cwip uuid; furn uuid; inc uuid;
  t record;
  tb_dr numeric; tb_cr numeric; assets numeric; capital numeric;
  profit numeric; cash numeric; v_cwip numeric; v_adv numeric; v_dep numeric;
  el numeric; p int := 0; f int := 0;
begin
  -- ---- fixture ----
  delete from auth.users where id = u;
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at,
                          raw_app_meta_data, raw_user_meta_data)
  values (u, '00000000-0000-0000-0000-000000000000','authenticated','authenticated',
          'parity@test.invalid', extensions.crypt('x', extensions.gen_salt('bf')),
          now(), now(), now(), '{"provider":"email"}'::jsonb,
          '{"full_name":"Parity Test"}'::jsonb);

  perform set_config('request.jwt.claims', json_build_object('sub',u)::text, true);
  co := create_company(jsonb_build_object(
          'name','Workbook Parity Co','legal_form','partnership',
          'books_start_date','2026-06-08'));
  select id into stat from books where company_id=co and kind='primary';

  select id into bank  from accounts where company_id=co and code='1010';
  select id into cap   from accounts where company_id=co and code='3010';
  select id into lease from accounts where company_id=co and code='1710';
  select id into rp    from accounts where company_id=co and code='1220';
  select id into cwip  from accounts where company_id=co and code='1510';
  select id into furn  from accounts where company_id=co and code='1610';
  select id into inc   from accounts where company_id=co and code='5910';

  -- ---- 16 example opening transactions ----
  for t in
    select * from (values
      ('2026-06-08','receipt','Capital from Partner A',         bank, cap,   50000),
      ('2026-06-08','receipt','Capital from Partner B',         bank, cap,   50000),
      ('2026-06-29','payment','Lease deposit to landlord',      lease,bank, 150000),
      ('2026-07-01','receipt','Capital from Partner C',         bank, cap,  150000),
      ('2026-07-01','receipt','Capital from Partner B',         bank, cap,  150000),
      ('2026-07-02','receipt','Capital from Partner D',         bank, cap,  250000),
      ('2026-07-03','payment','Returnable advance to associate', rp,  bank,  90000),
      ('2026-07-09','payment','Building work via associate',    cwip, bank,  40000),
      ('2026-07-13','receipt','Capital from Partner E',         bank, cap,  120000),
      ('2026-07-14','payment','Building work via associate',    cwip, bank, 120000),
      ('2026-07-22','receipt','Capital from Partner B',         bank, cap,   80000),
      ('2026-07-23','receipt','Capital from Partner E',         bank, cap,  130000),
      ('2026-07-23','payment','Building work via associate',    cwip, bank, 350000),
      ('2026-07-24','payment','Advance to furniture supplier',  furn, bank,  60000),
      ('2026-07-25','receipt','Capital from Partner E',         bank, cap,   20000),
      ('2026-07-25','payment','Incorporation fees to auditor',   inc, bank,  30000)
    ) as v(d, vtype, narr, dr_acct, cr_acct, amt)
  loop
    perform save_journal_entry(jsonb_build_object(
      'company_id',co,'book_id',stat,'voucher_type',t.vtype,'entry_date',t.d,
      'narration',t.narr,'status','posted','lines',
      jsonb_build_array(jsonb_build_object('account_id',t.dr_acct,'debit',t.amt),
                        jsonb_build_object('account_id',t.cr_acct,'credit',t.amt))));
  end loop;

  -- ---- assertions ----
  select sum(closing_debit), sum(closing_credit),
         coalesce(sum(net) filter (where account_type='asset'),0),
        -coalesce(sum(net) filter (where account_type='equity'),0),
        -coalesce(sum(net) filter (where account_type='income'),0)
        -coalesce(sum(net) filter (where account_type='expense'),0),
         coalesce(sum(net) filter (where is_bank_or_cash),0),
         coalesce(sum(net) filter (where capex_role='cwip'),0),
         coalesce(sum(net) filter (where capex_role='capital_advance'),0),
         coalesce(sum(net) filter (where capex_role='deposit'),0)
    into tb_dr, tb_cr, assets, capital, profit, cash, v_cwip, v_adv, v_dep
    from account_balances(co, stat, date '2027-03-31');

  if tb_dr = tb_cr and tb_dr = 1000000 then p:=p+1; raise notice 'PASS  trial balance tallies at 10,00,000';
  else f:=f+1; raise warning 'FAIL  trial balance % / %', tb_dr, tb_cr; end if;

  if assets = 970000 then p:=p+1; raise notice 'PASS  total assets 9,70,000';
  else f:=f+1; raise warning 'FAIL  assets %', assets; end if;

  if capital = 1000000 then p:=p+1; raise notice 'PASS  capital 10,00,000';
  else f:=f+1; raise warning 'FAIL  capital %', capital; end if;

  if profit = -30000 then p:=p+1; raise notice 'PASS  net loss 30,000';
  else f:=f+1; raise warning 'FAIL  profit %', profit; end if;

  if cash = 160000 then p:=p+1; raise notice 'PASS  cash and bank 1,60,000';
  else f:=f+1; raise warning 'FAIL  cash %', cash; end if;

  if v_cwip = 510000 then p:=p+1; raise notice 'PASS  CWIP 5,10,000';
  else f:=f+1; raise warning 'FAIL  cwip %', v_cwip; end if;

  if v_adv = 60000 then p:=p+1; raise notice 'PASS  capital advances 60,000';
  else f:=f+1; raise warning 'FAIL  advances %', v_adv; end if;

  if v_dep = 150000 then p:=p+1; raise notice 'PASS  deposits 1,50,000';
  else f:=f+1; raise warning 'FAIL  deposits %', v_dep; end if;

  -- the balance sheet identity: assets = capital + profit (no liabilities here)
  el := capital + profit;
  if round(el,2) = round(assets,2) then p:=p+1; raise notice 'PASS  balance sheet tallies (% = %)', el, assets;
  else f:=f+1; raise warning 'FAIL  BS: E+L % vs assets %', el, assets; end if;

  raise notice '=====  WORKBOOK PARITY: % passed, % failed  =====', p, f;
  if f > 0 then raise exception 'WORKBOOK PARITY FAILED: % failure(s)', f; end if;

  delete from auth.users where id = u;
end $$;

rollback;
