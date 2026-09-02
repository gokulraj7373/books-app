-- ============================================================================
-- Ledger guarantee suite. Run against a database with migrations 0001-0004.
-- Raises (and therefore fails) on the first broken guarantee.
--
--   psql "$DB_URL" -f supabase/tests/ledger_guarantees.sql
--
-- Safe to re-run: it rebuilds its own fixture and cleans up at the end.
-- ============================================================================

begin;

-- ---------------------------------------------------------------- fixture ---
do $$
declare u uuid := '11111111-1111-1111-1111-111111111111'; v_org uuid; v_co uuid; v_stat uuid;
begin
  delete from auth.users where id = u;
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at,
                          raw_app_meta_data, raw_user_meta_data)
  values (u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'ledgertest@test.local', extensions.crypt('x', extensions.gen_salt('bf')),
          now(), now(), now(), '{"provider":"email"}'::jsonb, '{"full_name":"Ledger Test"}'::jsonb);

  select org_id into v_org from organization_members where user_id = u limit 1;

  insert into companies (org_id, name, legal_form, books_start_date, created_by)
  values (v_org, 'Ledger Test Co', 'partnership', date '2026-04-01', u) returning id into v_co;
  insert into company_members (company_id, user_id, role_key) values (v_co, u, 'owner');
  insert into fiscal_years (company_id, name, period)
  values (v_co, 'FY 2026-27', daterange(date '2026-04-01', date '2027-04-01', '[)'));
  insert into books (company_id, code, name, kind, is_statutory)
  values (v_co, 'STAT', 'Statutory Book', 'primary', true) returning id into v_stat;
  insert into books (company_id, code, name, kind, base_book_id)
  values (v_co, 'MGMT', 'Management Book', 'adjustment', v_stat);
  insert into accounts (company_id, code, name, account_type, normal_balance, is_bank_or_cash) values
    (v_co, '1010', 'Bank - Current A/c', 'asset',   'D', true),
    (v_co, '3010', 'Capital - Anand',  'equity',  'C', false),
    (v_co, '5110', 'Labour Expense',     'expense', 'D', false),
    (v_co, '9999', 'Assets (group)',     'asset',   'D', false);
  update accounts set is_group = true where company_id = v_co and code = '9999';
end $$;

-- ------------------------------------------------------------------ tests ---
do $$
declare
  u uuid := '11111111-1111-1111-1111-111111111111';
  v_co uuid; v_stat uuid; v_mgmt uuid;
  a_bank uuid; a_cap uuid; a_lab uuid; a_grp uuid;
  e1 uuid; e2 uuid; v_seq bigint; p int := 0; f int := 0;
  v1 text; v2 text; v3 text; n_bad int;
begin
  select id into v_co   from companies where name='Ledger Test Co';
  select id into v_stat from books where company_id=v_co and code='STAT';
  select id into v_mgmt from books where company_id=v_co and code='MGMT';
  select id into a_bank from accounts where company_id=v_co and code='1010';
  select id into a_cap  from accounts where company_id=v_co and code='3010';
  select id into a_lab  from accounts where company_id=v_co and code='5110';
  select id into a_grp  from accounts where company_id=v_co and code='9999';
  perform set_config('request.jwt.claims', json_build_object('sub', u)::text, true);

  -- 1  a balanced entry posts
  e1 := save_journal_entry(jsonb_build_object('company_id',v_co,'book_id',v_stat,
    'voucher_type','receipt','entry_date','2026-06-08','narration','Capital from Anand','status','posted',
    'lines', jsonb_build_array(
      jsonb_build_object('account_id',a_bank,'debit',70000,'credit',0),
      jsonb_build_object('account_id',a_cap ,'debit',0,'credit',70000))));
  if e1 is not null then p:=p+1; raise notice 'PASS  1  balanced entry posts';
  else f:=f+1; raise warning 'FAIL  1'; end if;

  -- 2  unbalanced is rejected
  begin
    perform save_journal_entry(jsonb_build_object('company_id',v_co,'book_id',v_stat,
      'voucher_type','journal','entry_date','2026-06-09','narration','bad','status','posted',
      'lines', jsonb_build_array(
        jsonb_build_object('account_id',a_bank,'debit',100,'credit',0),
        jsonb_build_object('account_id',a_cap ,'debit',0,'credit',90))));
    f:=f+1; raise warning 'FAIL  2  unbalanced ACCEPTED';
  exception when others then p:=p+1; raise notice 'PASS  2  unbalanced rejected'; end;

  -- 3  a single-line entry is rejected
  begin
    perform save_journal_entry(jsonb_build_object('company_id',v_co,'book_id',v_stat,
      'voucher_type','journal','entry_date','2026-06-09','narration','one','status','posted',
      'lines', jsonb_build_array(jsonb_build_object('account_id',a_bank,'debit',100,'credit',0))));
    f:=f+1; raise warning 'FAIL  3  single-line ACCEPTED';
  exception when others then p:=p+1; raise notice 'PASS  3  single-line rejected'; end;

  -- 4  a group heading cannot be posted to
  begin
    perform save_journal_entry(jsonb_build_object('company_id',v_co,'book_id',v_stat,
      'voucher_type','journal','entry_date','2026-06-09','narration','grp','status','posted',
      'lines', jsonb_build_array(
        jsonb_build_object('account_id',a_grp,'debit',100,'credit',0),
        jsonb_build_object('account_id',a_cap,'debit',0,'credit',100))));
    f:=f+1; raise warning 'FAIL  4  group account ACCEPTED';
  exception when others then p:=p+1; raise notice 'PASS  4  group account rejected'; end;

  -- 5  THE TWO-BOOK RULE: a management entry may never touch bank/cash
  begin
    perform save_journal_entry(jsonb_build_object('company_id',v_co,'book_id',v_mgmt,
      'voucher_type','payment','entry_date','2026-06-10','narration','mgmt bank',
      'adjustment_reason','promoter_direct_outlay','status','posted',
      'lines', jsonb_build_array(
        jsonb_build_object('account_id',a_lab ,'debit',30000,'credit',0),
        jsonb_build_object('account_id',a_bank,'debit',0,'credit',30000))));
    f:=f+1; raise warning 'FAIL  5  MANAGEMENT ENTRY TOUCHED BANK AND WAS ACCEPTED';
  exception when others then p:=p+1; raise notice 'PASS  5  mgmt-touches-bank rejected'; end;

  -- 6  a management entry requires a reason
  begin
    perform save_journal_entry(jsonb_build_object('company_id',v_co,'book_id',v_mgmt,
      'voucher_type','journal','entry_date','2026-06-10','narration','no reason','status','posted',
      'lines', jsonb_build_array(
        jsonb_build_object('account_id',a_lab,'debit',100,'credit',0),
        jsonb_build_object('account_id',a_cap,'debit',0,'credit',100))));
    f:=f+1; raise warning 'FAIL  6  no-reason ACCEPTED';
  exception when others then p:=p+1; raise notice 'PASS  6  adjustment reason required'; end;

  -- 7  the owner's worked example: ₹30k labour paid directly by the investor
  e2 := save_journal_entry(jsonb_build_object('company_id',v_co,'book_id',v_mgmt,
    'voucher_type','journal','entry_date','2026-06-10','narration','Labour paid directly by Anand',
    'adjustment_reason','promoter_direct_outlay','status','posted',
    'lines', jsonb_build_array(
      jsonb_build_object('account_id',a_lab,'debit',30000,'credit',0),
      jsonb_build_object('account_id',a_cap,'debit',0,'credit',30000))));
  if e2 is not null then p:=p+1; raise notice 'PASS  7  legitimate management entry posts';
  else f:=f+1; raise warning 'FAIL  7'; end if;

  -- 8  posted entries are immutable
  begin update journal_entries set narration='hacked' where id=e1;
    f:=f+1; raise warning 'FAIL  8a posted entry MUTATED';
  exception when others then p:=p+1; raise notice 'PASS  8a update blocked'; end;
  begin delete from journal_entries where id=e1;
    f:=f+1; raise warning 'FAIL  8b posted entry DELETED';
  exception when others then p:=p+1; raise notice 'PASS  8b delete blocked'; end;
  begin update journal_lines set debit=999999 where entry_id=e1;
    f:=f+1; raise warning 'FAIL  8c posted LINE MUTATED';
  exception when others then p:=p+1; raise notice 'PASS  8c line update blocked'; end;

  -- 9  the hash chain verifies when intact
  if verify_chain(v_co, v_stat) is null then p:=p+1; raise notice 'PASS  9  chain intact';
  else f:=f+1; raise warning 'FAIL  9  chain broken'; end if;

  -- 10 voucher numbering is gapless, per book and per voucher type
  perform save_journal_entry(jsonb_build_object('company_id',v_co,'book_id',v_stat,
    'voucher_type','receipt','entry_date','2026-06-11','narration','second','status','posted',
    'lines', jsonb_build_array(
      jsonb_build_object('account_id',a_bank,'debit',5000,'credit',0),
      jsonb_build_object('account_id',a_cap ,'debit',0,'credit',5000))));
  perform save_journal_entry(jsonb_build_object('company_id',v_co,'book_id',v_stat,
    'voucher_type','receipt','entry_date','2026-06-12','narration','third','status','posted',
    'lines', jsonb_build_array(
      jsonb_build_object('account_id',a_bank,'debit',6000,'credit',0),
      jsonb_build_object('account_id',a_cap ,'debit',0,'credit',6000))));
  select string_agg(voucher_no, ',' order by seq) into v1
    from journal_entries where company_id=v_co and book_id=v_stat and voucher_type='receipt';
  if v1 = 'RE-001,RE-002,RE-003' then p:=p+1; raise notice 'PASS 10  gapless numbering (%)', v1;
  else f:=f+1; raise warning 'FAIL 10  numbering was %', v1; end if;

  -- 11 a locked period refuses entries
  insert into period_locks (company_id, book_id, locked_through, locked_by)
    values (v_co, v_stat, date '2026-06-30', u)
    on conflict (company_id, book_id) do update set locked_through=excluded.locked_through;
  update company_members set rights='{"post_entry":true,"unlock_period":false}'::jsonb
    where company_id=v_co and user_id=u;
  begin
    perform save_journal_entry(jsonb_build_object('company_id',v_co,'book_id',v_stat,
      'voucher_type','receipt','entry_date','2026-06-15','narration','locked','status','posted',
      'lines', jsonb_build_array(
        jsonb_build_object('account_id',a_bank,'debit',1,'credit',0),
        jsonb_build_object('account_id',a_cap ,'debit',0,'credit',1))));
    f:=f+1; raise warning 'FAIL 11  locked-period entry ACCEPTED';
  exception when others then p:=p+1; raise notice 'PASS 11  period lock enforced'; end;
  update company_members set rights='{}'::jsonb where company_id=v_co and user_id=u;
  delete from period_locks where company_id=v_co;

  -- 12 idempotency: replaying a key returns the SAME entry, never a duplicate
  select save_journal_entry(jsonb_build_object('company_id',v_co,'book_id',v_stat,
    'voucher_type','receipt','entry_date','2026-07-01','narration','idem','status','posted',
    'idempotency_key','test-idem-1',
    'lines', jsonb_build_array(
      jsonb_build_object('account_id',a_bank,'debit',77,'credit',0),
      jsonb_build_object('account_id',a_cap ,'debit',0,'credit',77))))::text into v2;
  select save_journal_entry(jsonb_build_object('company_id',v_co,'book_id',v_stat,
    'voucher_type','receipt','entry_date','2026-07-01','narration','idem','status','posted',
    'idempotency_key','test-idem-1',
    'lines', jsonb_build_array(
      jsonb_build_object('account_id',a_bank,'debit',77,'credit',0),
      jsonb_build_object('account_id',a_cap ,'debit',0,'credit',77))))::text into v3;
  if v2 = v3 then p:=p+1; raise notice 'PASS 12  idempotent replay';
  else f:=f+1; raise warning 'FAIL 12  idempotency created a duplicate'; end if;

  -- 13 property: EVERY posted entry balances
  select count(*) into n_bad from (
    select e.id from journal_entries e join journal_lines l on l.entry_id=e.id
     where e.company_id=v_co and e.status='posted'
     group by e.id having sum(l.base_debit) <> sum(l.base_credit)) x;
  if n_bad = 0 then p:=p+1; raise notice 'PASS 13  all posted entries balance';
  else f:=f+1; raise warning 'FAIL 13  % unbalanced posted entries', n_bad; end if;

  -- 14 tamper detection: simulate an attacker with database-level access
  declare v_target uuid;
  begin
    select id into v_target from journal_entries where company_id=v_co and book_id=v_stat and seq=2;
    alter table journal_lines disable trigger jl_immutable;
    alter table journal_lines disable trigger jl_balanced;
    update journal_lines set debit=debit+50000, base_debit=base_debit+50000
      where entry_id=v_target and debit>0;
    alter table journal_lines enable trigger jl_immutable;
    alter table journal_lines enable trigger jl_balanced;

    v_seq := verify_chain(v_co, v_stat);
    if v_seq = 2 then p:=p+1; raise notice 'PASS 14  tamper detected at the exact altered entry';
    else f:=f+1; raise warning 'FAIL 14  tamper NOT detected (got %)', coalesce(v_seq::text,'null'); end if;

    alter table journal_lines disable trigger jl_immutable;
    alter table journal_lines disable trigger jl_balanced;
    update journal_lines set debit=debit-50000, base_debit=base_debit-50000
      where entry_id=v_target and debit>0;
    alter table journal_lines enable trigger jl_immutable;
    alter table journal_lines enable trigger jl_balanced;
  end;

  raise notice '=====  LEDGER: % passed, % failed  =====', p, f;
  if f > 0 then raise exception 'LEDGER GUARANTEES FAILED: % failure(s)', f; end if;
end $$;

-- --------------------------------------------------------------- security ---
do $$
declare n int; f int := 0;
begin
  select count(*) into n from pg_proc pr join pg_namespace ns on ns.oid=pr.pronamespace
   where ns.nspname='public' and has_function_privilege('anon', pr.oid, 'EXECUTE');
  if n=0 then raise notice 'PASS  no function is executable by anon';
  else f:=f+1; raise warning 'FAIL  % functions executable by anon', n; end if;

  select count(*) into n from pg_tables where schemaname='public' and rowsecurity=false;
  if n=0 then raise notice 'PASS  every public table has RLS enabled';
  else f:=f+1; raise warning 'FAIL  % tables without RLS', n; end if;

  select count(*) into n from pg_policies p
   where p.schemaname='public' and coalesce(p.qual,'')='true'
     and exists (select 1 from information_schema.columns c
                 where c.table_schema='public' and c.table_name=p.tablename
                   and c.column_name='company_id');
  if n=0 then raise notice 'PASS  no blanket USING(true) on a company-scoped table';
  else f:=f+1; raise warning 'FAIL  % blanket policies', n; end if;

  select count(*) into n from pg_policies where schemaname='public'
     and tablename in ('journal_entries','journal_lines') and cmd<>'SELECT';
  if n=0 then raise notice 'PASS  ledger has no direct write policies';
  else f:=f+1; raise warning 'FAIL  % ledger write policies', n; end if;

  -- ---------------------------------------------------------------------
  -- Functions the code calls "internal" must actually be internal.
  --
  -- `revoke ... from public, anon` is NOT enough on Supabase: default
  -- privileges grant EXECUTE to `authenticated` explicitly, and revoking from
  -- PUBLIC never touches that. Three functions were reachable at
  -- /rest/v1/rpc/* for months while their comments said otherwise, including
  -- check_pin -- the PIN oracle its own comment warned about. Closing a
  -- function means revoking from public, anon AND authenticated.
  -- ---------------------------------------------------------------------
  select count(*) into n from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public'
     and p.proname in ('check_pin','snapshot_entry','company_alerts','backup_alert',
                       'log_master_change','seed_chart_of_accounts','ensure_internal_cash',
                       'ensure_funding_accounts','seed_capital_account','apply_default_rights',
                       'block_if_posted','block_lines_if_posted','assert_entry_balanced',
                       'handle_new_user','prevent_last_owner_change','stamp_actor_name')
     and (has_function_privilege('authenticated', p.oid, 'execute')
       or has_function_privilege('anon', p.oid, 'execute'));
  if n=0 then raise notice 'PASS  every internal-only function is unreachable over the API';
  else f:=f+1; raise warning 'FAIL  % internal function(s) are callable by anon/authenticated', n; end if;

  if f>0 then raise exception 'SECURITY GATES FAILED: % failure(s)', f; end if;
end $$;

-- ---------------------------------------------------------------- cleanup ---
delete from auth.users where id = '11111111-1111-1111-1111-111111111111';

commit;
