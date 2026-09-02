create or replace function public.set_opening_balances(p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid := (p_payload->>'company_id')::uuid;
  v_book    uuid := (p_payload->>'book_id')::uuid;
  v_date    date := (p_payload->>'as_on')::date;
  v_line    jsonb;
  v_lines   jsonb := '[]'::jsonb;
  v_dr      numeric(18,2) := 0;
  v_cr      numeric(18,2) := 0;
  v_diff    numeric(18,2);
  v_eq      uuid;
  v_n       int := 0;
  v_entry   uuid;
  v_start   date;
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  if not public.company_has_right(v_company, 'post_entry') then
    raise exception 'Your role cannot record opening balances.';
  end if;
  if v_book is null then raise exception 'Which book are these opening balances for?'; end if;
  if v_date is null then raise exception 'Give the date these balances are as at.'; end if;

  select books_start_date into v_start from companies where id = v_company;
  if v_start is not null and v_date > v_start then
    raise exception
      'Opening balances must be dated on or before %, the day your books start. Anything after that is an ordinary entry.',
      to_char(v_start, 'DD Mon YYYY');
  end if;

  if exists (select 1 from journal_entries
              where company_id = v_company and book_id = v_book
                and voucher_type = 'opening' and status = 'posted'
                and reversed_by_entry_id is null) then
    raise exception
      'This book already has opening balances. Correct the existing opening entry instead of adding a second one.';
  end if;

  select id into v_eq from accounts
   where company_id = v_company and code = '9900' and not is_group;
  if v_eq is null then
    raise exception 'The Opening Balance Equalisation account (9900) is missing from your chart.';
  end if;

  for v_line in select * from jsonb_array_elements(p_payload->'lines') loop
    declare
      v_acct uuid := (v_line->>'account_id')::uuid;
      v_d numeric(18,2) := round(coalesce((v_line->>'debit')::numeric, 0), 2);
      v_c numeric(18,2) := round(coalesce((v_line->>'credit')::numeric, 0), 2);
      v_nm text;
    begin
      if v_d = 0 and v_c = 0 then continue; end if;
      if v_d < 0 or v_c < 0 then
        raise exception 'Opening balances are entered as positive amounts on the correct side.';
      end if;
      if v_d > 0 and v_c > 0 then
        raise exception 'Put each opening balance on one side only.';
      end if;

      select name into v_nm from accounts
       where id = v_acct and company_id = v_company and not is_group and is_active;
      if v_nm is null then
        raise exception 'One of the accounts in the opening balances is not usable.';
      end if;
      if v_acct = v_eq then
        raise exception 'The equalisation account is worked out for you — leave it out.';
      end if;

      v_n := v_n + 1;
      v_dr := v_dr + v_d;
      v_cr := v_cr + v_c;
      v_lines := v_lines || jsonb_build_object(
        'account_id', v_acct,
        'debit',  case when v_d > 0 then v_d else 0 end,
        'credit', case when v_c > 0 then v_c else 0 end,
        'party_id', nullif(v_line->>'party_id','')::uuid,
        'line_narration', nullif(v_line->>'note',''));
    end;
  end loop;

  if v_n = 0 then raise exception 'Enter at least one opening balance.'; end if;

  v_diff := round(v_dr - v_cr, 2);
  if v_diff <> 0 then
    v_lines := v_lines || jsonb_build_object(
      'account_id', v_eq,
      'debit',  case when v_diff < 0 then -v_diff else 0 end,
      'credit', case when v_diff > 0 then  v_diff else 0 end,
      'line_narration', 'Accumulated position brought forward');
  end if;

  v_entry := public.save_journal_entry(jsonb_build_object(
    'company_id', v_company,
    'book_id',    v_book,
    'voucher_type', 'opening',
    'entry_date', v_date,
    'narration',  coalesce(nullif(trim(p_payload->>'narration'),''),
                           'Opening balances as at ' || to_char(v_date, 'DD Mon YYYY')),
    'adjustment_reason', nullif(trim(p_payload->>'adjustment_reason'),''),
    'status', 'posted',
    'source', 'system',
    'lines', v_lines));

  perform public.log_master_change(
    v_company, 'opening_balance', v_entry, 'create',
    format('Opening balances recorded as at %s — %s accounts, %s total.',
           to_char(v_date, 'DD Mon YYYY'), v_n,
           to_char(greatest(v_dr, v_cr), 'FM99,99,99,990.00')),
    null, jsonb_build_object('entry_id', v_entry, 'as_on', v_date,
                             'debit_total', v_dr, 'credit_total', v_cr,
                             'equalisation', v_diff));

  return v_entry;
end;
$$;

create or replace function public.opening_balance_status(p_company uuid, p_book uuid)
returns table (entry_id uuid, voucher_no text, entry_date date, line_count bigint, total numeric)
language sql
stable
security definer
set search_path = public
as $$
  select e.id, e.voucher_no, e.entry_date,
         (select count(*) from journal_lines l where l.entry_id = e.id),
         (select round(coalesce(sum(l.base_debit),0),2) from journal_lines l where l.entry_id = e.id)
    from journal_entries e
   where e.company_id = p_company
     and e.book_id = p_book
     and e.voucher_type = 'opening'
     and e.status = 'posted'
     and e.reversed_by_entry_id is null
     and public.company_is_member(p_company)
   order by e.entry_date desc
   limit 1;
$$;

revoke all on function public.set_opening_balances(jsonb)             from public, anon;
revoke all on function public.opening_balance_status(uuid, uuid)      from public, anon;
grant execute on function public.set_opening_balances(jsonb)          to authenticated;
grant execute on function public.opening_balance_status(uuid, uuid)   to authenticated;
