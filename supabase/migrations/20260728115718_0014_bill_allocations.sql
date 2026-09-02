-- ============================================================================
-- 0014 — Bill-wise allocation (Tally's "bill-wise details", Zoho's bill payments)
--
-- Until now, payables were tracked per PARTY. That is exact on totals but cannot
-- answer "which bill is still open?" — so part-payments and advances could not
-- be matched to the bill they settle. Every serious system models this:
--   Tally  : New Ref / Agst Ref / Advance / On Account
--   Zoho/QB: a bill is an open item; payments and credits allocate against it
--
-- Model here: a BILL creates an open item. Any entry that reduces it (an advance
-- adjustment, a part payment, a final payment) is allocated to it by amount.
--   outstanding(bill) = bill total - sum(allocations)
-- ============================================================================

alter table journal_entries
  add column if not exists payment_terms text;

comment on column journal_entries.payment_terms is
  'Net 15 / Net 30 / Due on receipt / Custom — drives due_date on a bill.';

create table if not exists bill_allocations (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references companies(id) on delete cascade,
  -- the entry that CREATED the payable
  bill_entry_id     uuid not null references journal_entries(id) on delete restrict,
  -- the entry that REDUCES it (advance adjustment, part payment, final payment)
  settling_entry_id uuid not null references journal_entries(id) on delete restrict,
  amount            numeric(18,2) not null check (amount > 0),
  created_at        timestamptz not null default now(),
  created_by        uuid references auth.users(id) on delete set null,
  unique (bill_entry_id, settling_entry_id)
);
create index if not exists ba_bill_idx on bill_allocations (bill_entry_id);
create index if not exists ba_company_idx on bill_allocations (company_id);

grant select on bill_allocations to authenticated;
alter table bill_allocations enable row level security;

drop policy if exists ba_select on bill_allocations;
create policy ba_select on bill_allocations for select to authenticated
  using (public.company_is_member(company_id)
         and public.company_has_right(company_id,'view_ledger'));

-- ---------------------------------------------------------------------------
-- open_bills — every bill and what is still owed on it.
-- ---------------------------------------------------------------------------
create or replace function public.open_bills(p_company uuid, p_book uuid)
returns table (
  entry_id uuid, voucher_no text, supplier_bill_no text,
  party_id uuid, party_name text,
  bill_date date, due_date date, payment_terms text,
  total numeric(18,2), settled numeric(18,2), outstanding numeric(18,2),
  days_overdue int, narration text)
language sql stable security definer set search_path = public as $$
  with scope as (select unnest(public.book_scope(p_book)) as book_id),
  bills as (
    select e.id, e.voucher_no, e.reference_no, e.entry_date, e.due_date,
           e.payment_terms, e.narration, l.party_id,
           sum(l.base_credit) as total
      from journal_entries e
      join journal_lines l on l.entry_id = e.id
      join accounts a on a.id = l.account_id
     where e.company_id = p_company
       and e.book_id in (select book_id from scope)
       and e.status = 'posted'
       and e.voucher_type = 'purchase'
       and a.sub_group = 'Trade Payables'
       and l.base_credit > 0
     group by e.id, e.voucher_no, e.reference_no, e.entry_date, e.due_date,
              e.payment_terms, e.narration, l.party_id)
  select b.id, b.voucher_no, b.reference_no, b.party_id, p.name,
         b.entry_date, b.due_date, b.payment_terms,
         round(b.total,2),
         round(coalesce(al.settled,0),2),
         round(b.total - coalesce(al.settled,0),2),
         case when b.due_date is null then 0
              else greatest(0, (current_date - b.due_date))::int end,
         b.narration
    from bills b
    left join parties p on p.id = b.party_id
    left join (select bill_entry_id, sum(amount) as settled
                 from bill_allocations group by bill_entry_id) al
           on al.bill_entry_id = b.id
   where public.company_is_member(p_company)
     and public.company_has_right(p_company,'view_ledger')
   order by (b.total - coalesce(al.settled,0)) > 0 desc, b.due_date nulls last, b.entry_date;
$$;

-- ============================================================================
-- record_bill — one atomic action for the whole real-world sequence.
--
-- A bill, an advance adjustment and a payment are three separate journal
-- entries, and a half-recorded bill (liability created but advance not applied)
-- would be worse than none. Doing it in one function means all three commit
-- together or none do.
-- ============================================================================
create or replace function public.record_bill(p_payload jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_company   uuid := (p_payload->>'company_id')::uuid;
  v_book      uuid := (p_payload->>'book_id')::uuid;
  v_party     uuid;
  v_payables  uuid;
  v_bill      uuid;
  v_adjust    uuid;
  v_payment   uuid;
  v_total     numeric(18,2) := 0;
  v_line      jsonb;
  v_lines     jsonb := '[]'::jsonb;
  v_adv_amt   numeric(18,2) := round(coalesce((p_payload#>>'{apply_advance,amount}')::numeric,0),2);
  v_adv_acct  uuid := nullif(p_payload#>>'{apply_advance,account_id}','')::uuid;
  v_pay_amt   numeric(18,2) := round(coalesce((p_payload#>>'{payment,amount}')::numeric,0),2);
  v_pay_acct  uuid := nullif(p_payload#>>'{payment,money_account_id}','')::uuid;
  v_reason    text := nullif(trim(p_payload->>'adjustment_reason'),'');
  v_date      date := (p_payload->>'bill_date')::date;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;

  -- resolve or create the supplier
  v_party := nullif(p_payload->>'party_id','')::uuid;
  if v_party is null then
    v_party := public.find_or_create_party(v_company, p_payload->>'party_name', 'vendor');
  end if;

  select id into v_payables from accounts
   where company_id = v_company and sub_group = 'Trade Payables' and not is_group
   order by code limit 1;
  if v_payables is null then
    raise exception 'no Trade Payables account exists in the chart of accounts';
  end if;

  -- ---- build the bill lines: one debit per item, one credit to payables ----
  for v_line in select * from jsonb_array_elements(p_payload->'lines') loop
    declare a numeric(18,2) := round(coalesce((v_line->>'amount')::numeric,0),2);
    begin
      if a <= 0 then raise exception 'every bill line needs an amount greater than zero'; end if;
      v_total := v_total + a;
      v_lines := v_lines || jsonb_build_object(
        'account_id', v_line->>'account_id',
        'debit', a,
        'party_id', v_party,
        'line_narration', nullif(v_line->>'description',''),
        'qty', nullif(v_line->>'qty',''),
        'unit', nullif(v_line->>'unit',''),
        'hsn_sac', nullif(v_line->>'hsn_sac',''),
        'capital_project_line_id', nullif(v_line->>'capital_project_line_id',''));
    end;
  end loop;

  if v_total <= 0 then raise exception 'a bill needs at least one line'; end if;
  if v_adv_amt > v_total then
    raise exception 'the advance applied (%) is more than the bill total (%)', v_adv_amt, v_total;
  end if;
  if v_adv_amt + v_pay_amt > v_total then
    raise exception 'advance plus payment (%) is more than the bill total (%)',
      v_adv_amt + v_pay_amt, v_total;
  end if;

  -- the payables credit closes the entry
  v_lines := v_lines || jsonb_build_object(
    'account_id', v_payables, 'credit', v_total, 'party_id', v_party);

  v_bill := public.save_journal_entry(jsonb_build_object(
    'company_id', v_company, 'book_id', v_book,
    'voucher_type','purchase', 'entry_date', v_date,
    'narration', coalesce(nullif(trim(p_payload->>'narration'),''),
                          'Bill from ' || (select name from parties where id = v_party)),
    'party_id', v_party,
    'reference_no', nullif(p_payload->>'bill_no',''),
    'due_date', nullif(p_payload->>'due_date',''),
    'payment_terms', nullif(p_payload->>'payment_terms',''),
    'proof_url', nullif(p_payload->>'proof_url',''),
    'adjustment_reason', v_reason,
    'status','posted', 'lines', v_lines));

  -- ---- set an existing advance against this bill ----
  if v_adv_amt > 0 and v_adv_acct is not null then
    v_adjust := public.save_journal_entry(jsonb_build_object(
      'company_id', v_company, 'book_id', v_book,
      'voucher_type','journal', 'entry_date', v_date,
      'narration','Advance set against bill ' ||
                  coalesce(nullif(p_payload->>'bill_no',''), 'from ' ||
                           (select name from parties where id = v_party)),
      'party_id', v_party, 'adjustment_reason', v_reason, 'status','posted',
      'lines', jsonb_build_array(
        jsonb_build_object('account_id', v_payables, 'debit', v_adv_amt, 'party_id', v_party),
        jsonb_build_object('account_id', v_adv_acct,  'credit', v_adv_amt, 'party_id', v_party))));

    insert into bill_allocations (company_id, bill_entry_id, settling_entry_id, amount, created_by)
    values (v_company, v_bill, v_adjust, v_adv_amt, auth.uid());
  end if;

  -- ---- pay some or all of the balance straight away ----
  if v_pay_amt > 0 and v_pay_acct is not null then
    v_payment := public.save_journal_entry(jsonb_build_object(
      'company_id', v_company, 'book_id', v_book,
      'voucher_type','payment',
      'entry_date', coalesce(nullif(p_payload#>>'{payment,date}','')::date, v_date),
      'narration','Paid ' || (select name from parties where id = v_party) ||
                  coalesce(' against bill ' || nullif(p_payload->>'bill_no',''), ''),
      'party_id', v_party,
      'payment_mode', nullif(p_payload#>>'{payment,mode}',''),
      'reference_no', nullif(p_payload#>>'{payment,reference}',''),
      'adjustment_reason', v_reason, 'status','posted',
      'lines', jsonb_build_array(
        jsonb_build_object('account_id', v_payables, 'debit', v_pay_amt, 'party_id', v_party),
        jsonb_build_object('account_id', v_pay_acct, 'credit', v_pay_amt))));

    insert into bill_allocations (company_id, bill_entry_id, settling_entry_id, amount, created_by)
    values (v_company, v_bill, v_payment, v_pay_amt, auth.uid());
  end if;

  return jsonb_build_object(
    'bill_entry_id', v_bill,
    'adjust_entry_id', v_adjust,
    'payment_entry_id', v_payment,
    'total', v_total,
    'outstanding', v_total - v_adv_amt - v_pay_amt,
    'party_id', v_party);
end; $$;

-- ---------------------------------------------------------------------------
-- pay_bill — settle an existing open bill, in full or in part.
-- ---------------------------------------------------------------------------
create or replace function public.pay_bill(p_payload jsonb)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_company uuid := (p_payload->>'company_id')::uuid;
  v_bill    uuid := (p_payload->>'bill_entry_id')::uuid;
  v_amt     numeric(18,2) := round((p_payload->>'amount')::numeric, 2);
  v_src     uuid := (p_payload->>'source_account_id')::uuid;
  v_book    uuid;
  v_party   uuid;
  v_payables uuid;
  v_out     numeric(18,2);
  v_entry   uuid;
  v_is_adv  boolean := coalesce((p_payload->>'from_advance')::boolean, false);
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if v_amt <= 0 then raise exception 'amount must be greater than zero'; end if;

  select book_id, party_id into v_book, v_party
    from journal_entries where id = v_bill and company_id = v_company;
  if v_book is null then raise exception 'bill not found'; end if;

  select outstanding into v_out
    from public.open_bills(v_company, v_book) where entry_id = v_bill;
  if v_out is null then raise exception 'bill not found'; end if;
  if v_amt > v_out then
    raise exception 'that is more than the % still outstanding on this bill', v_out;
  end if;

  select id into v_payables from accounts
   where company_id = v_company and sub_group = 'Trade Payables' and not is_group
   order by code limit 1;

  v_entry := public.save_journal_entry(jsonb_build_object(
    'company_id', v_company, 'book_id', v_book,
    'voucher_type', case when v_is_adv then 'journal' else 'payment' end,
    'entry_date', coalesce(nullif(p_payload->>'date','')::date, current_date),
    'narration', coalesce(nullif(trim(p_payload->>'narration'),''),
                          case when v_is_adv then 'Advance set against bill'
                               else 'Payment against bill' end),
    'party_id', v_party,
    'payment_mode', nullif(p_payload->>'mode',''),
    'reference_no', nullif(p_payload->>'reference',''),
    'status','posted',
    'lines', jsonb_build_array(
      jsonb_build_object('account_id', v_payables, 'debit', v_amt, 'party_id', v_party),
      jsonb_build_object('account_id', v_src, 'credit', v_amt,
                         'party_id', case when v_is_adv then v_party else null end))));

  insert into bill_allocations (company_id, bill_entry_id, settling_entry_id, amount, created_by)
  values (v_company, v_bill, v_entry, v_amt, auth.uid());

  return v_entry;
end; $$;

revoke all on function public.open_bills(uuid,uuid)  from public, anon;
revoke all on function public.record_bill(jsonb)     from public, anon;
revoke all on function public.pay_bill(jsonb)        from public, anon;
grant execute on function public.open_bills(uuid,uuid),
                         public.record_bill(jsonb),
                         public.pay_bill(jsonb) to authenticated;
