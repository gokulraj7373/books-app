-- "No bill attached" nagged on every payment and every bill. Only a bill
-- entered through the Bills tab (voucher_type = 'purchase') is actually a bill
-- that needs paperwork behind it — an ordinary payment (rent, an advance,
-- lending money out) was never asked for proof anywhere in the app, so warning
-- about it was pure noise, and untrue: most entries genuinely have no bill.
create or replace function public.company_alerts(p_company uuid, p_book uuid)
returns table (id text, severity text, title text, body text, href text, amount numeric)
language plpgsql
stable security definer
set search_path = 'public'
as $function$
declare
  v_stat uuid; v_mgmt uuid;
  v_dr numeric; v_cr numeric; v_cash numeric; v_broken bigint;
  v_pending numeric; v_unapplied numeric; v_noproof int;
  v_auth numeric; v_paid numeric;
  r record;
begin
  if not public.company_is_member(p_company) then return; end if;

  select b.id into v_stat from books b where b.company_id = p_company and b.kind = 'primary';
  select b.id into v_mgmt from books b where b.company_id = p_company and b.kind = 'adjustment';
  select c.authorised_capital into v_auth from companies c where c.id = p_company;

  select coalesce(sum(ab.closing_debit),0), coalesce(sum(ab.closing_credit),0)
    into v_dr, v_cr from public.account_balances(p_company, p_book) ab;
  if round(v_dr - v_cr, 2) <> 0 then
    return query select 'tb'::text, 'danger'::text,
      'The books do not add up'::text,
      ('Debits and credits differ by ' || to_char(abs(v_dr - v_cr), 'FM99,99,99,990.00') ||
       '. Do not file or share anything until this is explained.')::text,
      '/reports/trial-balance'::text, round(abs(v_dr - v_cr),2);
  end if;

  v_broken := public.verify_chain(p_company, v_stat);
  if v_broken is not null then
    return query select 'chain'::text, 'danger'::text,
      'The audit trail is broken'::text,
      ('Entry number ' || v_broken || ' no longer matches its record. This should be impossible in normal use.')::text,
      '/health'::text, null::numeric;
  end if;

  select coalesce(sum(ab.net),0) into v_cash
    from public.account_balances(p_company, p_book) ab where ab.is_bank_or_cash;
  if v_cash < 0 then
    return query select 'cash'::text, 'danger'::text,
      'Cash and bank are negative'::text,
      ('You have paid out ' || to_char(abs(v_cash),'FM99,99,99,990.00') ||
       ' more than came in. Something has not been recorded.')::text,
      '/reports/cash-book'::text, round(abs(v_cash),2);
  end if;

  for r in
    select count(*) n, coalesce(sum(ob.outstanding),0) amt
      from public.open_bills(p_company, p_book) ob
     where ob.outstanding > 0 and ob.days_overdue > 0
  loop
    if r.n > 0 then
      return query select 'overdue'::text, 'warn'::text,
        (r.n || (case when r.n = 1 then ' bill is overdue' else ' bills are overdue' end))::text,
        (to_char(r.amt,'FM99,99,99,990.00') || ' is past the date you agreed to pay.')::text,
        '/bills'::text, r.amt;
    end if;
  end loop;

  for r in
    select count(*) n, coalesce(sum(ob.outstanding),0) amt
      from public.open_bills(p_company, p_book) ob
     where ob.outstanding > 0 and ob.days_overdue = 0
       and ob.due_date is not null and ob.due_date <= current_date + 7
  loop
    if r.n > 0 then
      return query select 'duesoon'::text, 'info'::text,
        (r.n || (case when r.n = 1 then ' bill falls due this week' else ' bills fall due this week' end))::text,
        (to_char(r.amt,'FM99,99,99,990.00') || ' to pay in the next seven days.')::text,
        '/bills'::text, r.amt;
    end if;
  end loop;

  select coalesce(sum(uc.amount),0) into v_unapplied
    from public.unapplied_credits(p_company, p_book) uc;
  if v_unapplied > 0 then
    return query select 'unapplied'::text, 'warn'::text,
      'Some payments are not linked to a bill'::text,
      (to_char(v_unapplied,'FM99,99,99,990.00') ||
       ' was paid without saying which bill it settles, so what you owe looks higher than it is.')::text,
      '/bills'::text, v_unapplied;
  end if;

  v_pending := public.unclassified_investor_funds(p_company);
  if v_pending > 0 then
    return query select 'pending'::text, 'warn'::text,
      'Investor money is waiting to be classified'::text,
      (to_char(v_pending,'FM99,99,99,990.00') ||
       ' has come in without anyone deciding whether it is share capital or repayable funding.')::text,
      '/investors'::text, v_pending;
  end if;

  if coalesce(v_auth,0) > 0 then
    select coalesce(sum(im.share_capital),0) into v_paid from public.investor_master(p_company) im;
    if v_paid > v_auth then
      return query select 'authcap'::text, 'warn'::text,
        'Share capital is above your authorised limit'::text,
        (to_char(v_paid,'FM99,99,99,990.00') || ' is recorded as share capital, but your authorised limit is ' ||
         to_char(v_auth,'FM99,99,99,990.00') || '. Either raise the authorised capital with your CA, or record the excess as repayable funding.')::text,
        '/investors'::text, round(v_paid - v_auth, 2);
    end if;
  end if;

  for r in
    select im.name, im.still_to_bring, im.pct_funded
      from public.investor_master(p_company) im
     where im.committed > 0 and im.pct_funded < 50 and im.still_to_bring > 0
     order by im.still_to_bring desc limit 3
  loop
    return query select ('behind:' || r.name)::text, 'info'::text,
      (r.name || ' has brought in ' || round(r.pct_funded)::text || '% so far')::text,
      (to_char(r.still_to_bring,'FM99,99,99,990.00') || ' of their commitment is still to come.')::text,
      '/investors'::text, r.still_to_bring;
  end loop;

  for r in
    select cs.name, cs.budget_amount, cs.cwip_balance
      from public.capex_summary(p_company, p_book) cs
     where cs.budget_amount > 0 and cs.cwip_balance > cs.budget_amount
  loop
    return query select ('overbudget:' || r.name)::text, 'warn'::text,
      (r.name || ' is over budget')::text,
      ('Spent ' || to_char(r.cwip_balance,'FM99,99,99,990.00') || ' against a budget of ' ||
       to_char(r.budget_amount,'FM99,99,99,990.00') || '.')::text,
      '/capex'::text, round(r.cwip_balance - r.budget_amount, 2);
  end loop;

  for r in
    select p.name, round(sum(l.base_debit - l.base_credit),2) amt, max(e.entry_date) last_date
      from journal_lines l
      join journal_entries e on e.id = l.entry_id
      join accounts a on a.id = l.account_id
      join parties p on p.id = l.party_id
     where e.company_id = p_company and e.status='posted'
       and a.capex_role in ('capital_advance','deposit')
     group by p.name
    having round(sum(l.base_debit - l.base_credit),2) > 0
       and max(e.entry_date) < current_date - 60
  loop
    return query select ('stale:' || r.name)::text, 'info'::text,
      ('Advance with ' || r.name || ' is over 60 days old')::text,
      (to_char(r.amt,'FM99,99,99,990.00') || ' paid up front with nothing delivered against it since ' ||
       to_char(r.last_date,'DD Mon YYYY') || '.')::text,
      '/parties'::text, r.amt;
  end loop;

  -- was: voucher_type in ('payment','purchase') — a payment for rent, an
  -- advance, or lending money is never expected to have a bill attached.
  -- Only an actual BILL (recorded via the Bills tab, voucher_type='purchase')
  -- should be nagged about missing paperwork.
  select count(*) into v_noproof from journal_entries je
   where je.company_id = p_company and je.status = 'posted'
     and coalesce(je.proof_url,'') = '' and je.voucher_type = 'purchase';
  if v_noproof > 0 then
    return query select 'noproof'::text, 'info'::text,
      (v_noproof || (case when v_noproof = 1 then ' bill has' else ' bills have' end) || ' no copy attached')::text,
      'Not urgent, but an investor or your CA will ask for the paperwork behind these.'::text,
      '/bills'::text, null::numeric;
  end if;
end;
$function$;

revoke all on function public.company_alerts(uuid, uuid) from public, anon;
grant execute on function public.company_alerts(uuid, uuid) to authenticated;
