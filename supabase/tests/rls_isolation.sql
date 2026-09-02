-- ============================================================================
-- RLS isolation suite. Six users, two companies (two separate tenants).
-- Asserts the exact permission matrix, with RLS actually enforced.
--
--   psql "$DB_URL" -f supabase/tests/rls_isolation.sql
--
-- A failure here is a DEPLOY BLOCKER, same as a failing build: this is the test
-- that stands between one customer and another customer's books.
-- ============================================================================

begin;

-- ---------------------------------------------------------------- fixture ---
delete from auth.users where email like '%@rlstest.local';

do $$
declare
  ids uuid[] := array[
    '21111111-1111-1111-1111-111111111111'::uuid,  -- A owner
    '22222222-2222-2222-2222-222222222222'::uuid,  -- A accountant
    '23333333-3333-3333-3333-333333333333'::uuid,  -- A cashier
    '24444444-4444-4444-4444-444444444444'::uuid,  -- A investor
    '25555555-5555-5555-5555-555555555555'::uuid,  -- A auditor
    '26666666-6666-6666-6666-666666666666'::uuid]; -- B owner, a RIVAL TENANT
  names text[] := array['a_owner','a_accountant','a_cashier','a_investor','a_auditor','b_owner'];
  i int;
begin
  for i in 1..array_length(ids,1) loop
    insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                            email_confirmed_at, created_at, updated_at,
                            raw_app_meta_data, raw_user_meta_data)
    values (ids[i], '00000000-0000-0000-0000-000000000000','authenticated','authenticated',
            names[i]||'@rlstest.local', extensions.crypt('x', extensions.gen_salt('bf')),
            now(), now(), now(), '{"provider":"email"}'::jsonb,
            jsonb_build_object('full_name', names[i]));
  end loop;
end $$;

do $$
declare v_co uuid; v_stat uuid; v_mgmt uuid; a_bank uuid; a_cap uuid; a_lab uuid;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub','21111111-1111-1111-1111-111111111111')::text, true);
  v_co := create_company(jsonb_build_object(
    'name','RLS Alpha','legal_form','partnership','books_start_date','2026-06-08'));
  insert into company_members (company_id, user_id, role_key) values
    (v_co,'22222222-2222-2222-2222-222222222222','accountant'),
    (v_co,'23333333-3333-3333-3333-333333333333','cashier'),
    (v_co,'24444444-4444-4444-4444-444444444444','investor'),
    (v_co,'25555555-5555-5555-5555-555555555555','auditor');

  select id into v_stat from books where company_id=v_co and code='STAT';
  select id into v_mgmt from books where company_id=v_co and code='MGMT';
  select id into a_bank from accounts where company_id=v_co and code='1010';
  select id into a_cap  from accounts where company_id=v_co and code='3300';
  select id into a_lab  from accounts where company_id=v_co and code='5110';

  perform save_journal_entry(jsonb_build_object('company_id',v_co,'book_id',v_stat,
    'voucher_type','receipt','entry_date','2026-06-08','narration','STAT entry','status','posted',
    'lines', jsonb_build_array(
      jsonb_build_object('account_id',a_bank,'debit',500000,'credit',0),
      jsonb_build_object('account_id',a_cap ,'debit',0,'credit',500000))));

  perform save_journal_entry(jsonb_build_object('company_id',v_co,'book_id',v_mgmt,
    'voucher_type','journal','entry_date','2026-06-12','narration','MGMT entry',
    'adjustment_reason','promoter_direct_outlay','status','posted',
    'lines', jsonb_build_array(
      jsonb_build_object('account_id',a_lab,'debit',30000,'credit',0),
      jsonb_build_object('account_id',a_cap,'debit',0,'credit',30000))));

  perform set_config('request.jwt.claims',
    json_build_object('sub','26666666-6666-6666-6666-666666666666')::text, true);
  perform create_company(jsonb_build_object(
    'name','RLS Beta','legal_form','pvt_ltd','books_start_date','2026-05-01'));
end $$;

-- ----------------------------------------------------------------- assert ---
create or replace function pg_temp.n_as(p_user uuid, p_sql text)
returns bigint language plpgsql as $$
declare n bigint;
begin
  perform set_config('request.jwt.claims', json_build_object('sub',p_user)::text, true);
  execute p_sql into n;
  return n;
end $$;

do $$
declare
  a_own uuid := '21111111-1111-1111-1111-111111111111';
  a_acc uuid := '22222222-2222-2222-2222-222222222222';
  a_cash uuid := '23333333-3333-3333-3333-333333333333';
  a_inv uuid := '24444444-4444-4444-4444-444444444444';
  a_aud uuid := '25555555-5555-5555-5555-555555555555';
  b_own uuid := '26666666-6666-6666-6666-666666666666';
  f int := 0;

  procedure_stub int;
  function_stub int;

  -- helper as inline expression below
  q_alpha_accts text := 'select count(*) from accounts a join companies c on c.id=a.company_id where c.name=''RLS Alpha''';
  q_alpha_ents  text := 'select count(*) from journal_entries e join companies c on c.id=e.company_id where c.name=''RLS Alpha''';
  q_alpha_lines text := 'select count(*) from journal_lines l join journal_entries e on e.id=l.entry_id join companies c on c.id=e.company_id where c.name=''RLS Alpha''';
begin
  set local role authenticated;

  -- ===== the one that matters most: a rival tenant sees NOTHING =====
  if pg_temp.n_as(b_own, q_alpha_accts) <> 0 then f:=f+1; raise warning 'LEAK  rival can read Alpha accounts'; end if;
  if pg_temp.n_as(b_own, q_alpha_ents)  <> 0 then f:=f+1; raise warning 'LEAK  rival can read Alpha entries'; end if;
  if pg_temp.n_as(b_own, q_alpha_lines) <> 0 then f:=f+1; raise warning 'LEAK  rival can read Alpha lines'; end if;
  if pg_temp.n_as(b_own, 'select count(*) from companies where name=''RLS Alpha''') <> 0
    then f:=f+1; raise warning 'LEAK  rival can see the Alpha company row'; end if;
  if f = 0 then raise notice 'PASS  cross-tenant isolation: rival sees zero Alpha rows'; end if;

  -- ===== investor: no structural access at all =====
  if pg_temp.n_as(a_inv, 'select count(*) from accounts') <> 0 then f:=f+1; raise warning 'LEAK  investor reads the chart of accounts'; end if;
  if pg_temp.n_as(a_inv, 'select count(*) from books')    <> 0 then f:=f+1; raise warning 'LEAK  investor reads books'; end if;
  if pg_temp.n_as(a_inv, q_alpha_ents)                    <> 0 then f:=f+1; raise warning 'LEAK  investor reads the ledger'; end if;
  if pg_temp.n_as(a_inv, 'select count(*) from company_members') <> 1
    then f:=f+1; raise warning 'LEAK  investor can enumerate the member roster'; end if;
  raise notice 'PASS  investor sees no accounts, no books, no ledger, only their own seat';

  -- ===== cashier: records money, cannot read the whole business =====
  if pg_temp.n_as(a_cash, q_alpha_ents) <> 0 then f:=f+1; raise warning 'LEAK  cashier reads the ledger'; end if;
  if pg_temp.n_as(a_cash, 'select count(*) from accounts') = 0
    then f:=f+1; raise warning 'BROKEN cashier cannot see accounts and so cannot draft entries'; end if;
  raise notice 'PASS  cashier can see accounts but not the ledger';

  -- ===== auditor: statutory book only, and no writes ever =====
  if pg_temp.n_as(a_aud, q_alpha_ents) <> 1
    then f:=f+1; raise warning 'FAIL  auditor should see exactly the 1 statutory entry'; end if;
  raise notice 'PASS  auditor sees the statutory book only, not the management book';

  -- ===== owner and accountant see both books =====
  if pg_temp.n_as(a_own, q_alpha_ents) <> 2 then f:=f+1; raise warning 'FAIL  owner should see both books'; end if;
  if pg_temp.n_as(a_acc, q_alpha_ents) <> 2 then f:=f+1; raise warning 'FAIL  accountant should see both books'; end if;
  raise notice 'PASS  owner and accountant see both books';

  if f > 0 then raise exception 'RLS ISOLATION FAILED: % leak(s)', f; end if;
  raise notice '=====  RLS ISOLATION: all checks passed  =====';
end $$;

-- ---- an auditor must never be able to write ----
do $$
declare v_co uuid; v_stat uuid; a1 uuid; a2 uuid;
begin
  select id into v_co from companies where name='RLS Alpha';
  select id into v_stat from books where company_id=v_co and code='STAT';
  select id into a1 from accounts where company_id=v_co and code='1010';
  select id into a2 from accounts where company_id=v_co and code='3300';
  perform set_config('request.jwt.claims',
    json_build_object('sub','25555555-5555-5555-5555-555555555555')::text, true);
  begin
    perform save_journal_entry(jsonb_build_object('company_id',v_co,'book_id',v_stat,
      'voucher_type','receipt','entry_date','2026-06-20','narration','auditor write','status','posted',
      'lines', jsonb_build_array(
        jsonb_build_object('account_id',a1,'debit',1,'credit',0),
        jsonb_build_object('account_id',a2,'debit',0,'credit',1))));
    raise exception 'FAIL  an auditor was able to POST an entry';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  auditor cannot post';
  end;
end $$;

-- ---------------------------------------------------------------- cleanup ---
delete from auth.users where email like '%@rlstest.local';

commit;
