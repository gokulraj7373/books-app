-- FIX: save_journal_entry inserted the row already marked 'posted', then did a
-- second UPDATE to stamp voucher_no/seq/hash — which the immutability trigger
-- (correctly) refused. The row must be born as 'draft' and be promoted to
-- 'posted' by the SAME update that stamps it.
--
-- The deferred balance trigger still validates correctly: it runs at COMMIT, by
-- which time status is 'posted', so a posted entry can never commit unbalanced.
create or replace function public.save_journal_entry(p_payload jsonb)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_company    uuid := (p_payload->>'company_id')::uuid;
  v_book       uuid := (p_payload->>'book_id')::uuid;
  v_type       text := p_payload->>'voucher_type';
  v_date       date := (p_payload->>'entry_date')::date;
  v_status     text := coalesce(p_payload->>'status', 'posted');
  v_idem       text := nullif(p_payload->>'idempotency_key','');
  v_book_kind  text;
  v_fy         uuid;
  v_fy_status  text;
  v_locked     date;
  v_role       text;
  v_entry      uuid;
  v_line       jsonb;
  v_no         text;
  v_seq        bigint;
  v_prev       bytea;
  v_canon      text;
  v_debit      numeric(18,2) := 0;
  v_credit     numeric(18,2) := 0;
  v_n          int := 0;
  v_existing   uuid;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if v_company is null or v_book is null then raise exception 'company_id and book_id are required'; end if;
  if v_status not in ('draft','posted') then raise exception 'status must be draft or posted'; end if;

  if v_idem is not null then
    select id into v_existing from journal_entries
      where company_id = v_company and idempotency_key = v_idem;
    if v_existing is not null then return v_existing; end if;
  end if;

  if not public.company_is_member(v_company) then
    raise exception 'not a member of this company';
  end if;
  if v_status = 'posted' and not public.company_has_right(v_company, 'post_entry') then
    raise exception 'you do not have permission to post entries';
  end if;
  if v_status = 'draft' and not (public.company_has_right(v_company, 'draft_entry')
                                 or public.company_has_right(v_company, 'post_entry')) then
    raise exception 'you do not have permission to create entries';
  end if;

  v_role := public.company_role(v_company);
  if v_role = 'cashier' and v_type not in ('receipt','payment','contra') then
    raise exception 'cashiers may only create receipt, payment or contra vouchers';
  end if;

  select kind into v_book_kind from books where id = v_book and company_id = v_company;
  if v_book_kind is null then raise exception 'book does not belong to this company'; end if;

  select id, status into v_fy, v_fy_status from fiscal_years
    where company_id = v_company and period @> v_date;
  if v_fy is null then
    raise exception 'no fiscal year covers %; create one first', v_date;
  end if;
  if v_fy_status = 'closed' then
    raise exception 'fiscal year is closed; entries dated % are not allowed', v_date;
  end if;

  select locked_through into v_locked from period_locks
    where company_id = v_company and book_id = v_book;
  if v_locked is not null and v_date <= v_locked
     and not public.company_has_right(v_company, 'unlock_period') then
    raise exception 'period is locked through %; entries on or before that date are not allowed', v_locked;
  end if;

  if v_book_kind = 'adjustment'
     and coalesce(trim(p_payload->>'adjustment_reason'),'') = '' then
    raise exception 'a management-book entry requires an adjustment reason';
  end if;

  -- Always born as a draft so the finalizing stamp below is a legal transition.
  insert into journal_entries (
    company_id, book_id, fiscal_year_id, voucher_no, voucher_type, entry_date,
    narration, party_id, payment_mode, reference_no, proof_url, status,
    adjustment_reason, source, idempotency_key, created_by)
  values (
    v_company, v_book, v_fy, 'PENDING-' || gen_random_uuid()::text, v_type, v_date,
    p_payload->>'narration',
    nullif(p_payload->>'party_id','')::uuid,
    nullif(p_payload->>'payment_mode',''),
    nullif(p_payload->>'reference_no',''),
    nullif(p_payload->>'proof_url',''),
    'draft',
    nullif(trim(p_payload->>'adjustment_reason'),''),
    coalesce(p_payload->>'source','manual'),
    v_idem, auth.uid())
  returning id into v_entry;

  for v_line in select * from jsonb_array_elements(p_payload->'lines') loop
    v_n := v_n + 1;
    declare
      v_acct     uuid := (v_line->>'account_id')::uuid;
      v_d        numeric(18,2) := round(coalesce((v_line->>'debit')::numeric, 0), 2);
      v_c        numeric(18,2) := round(coalesce((v_line->>'credit')::numeric, 0), 2);
      v_fx       numeric(18,8) := coalesce((v_line->>'fx_rate')::numeric, 1);
      v_is_group boolean;
      v_is_cash  boolean;
      v_acct_co  uuid;
      v_active   boolean;
    begin
      select company_id, is_group, is_bank_or_cash, is_active
        into v_acct_co, v_is_group, v_is_cash, v_active
        from accounts where id = v_acct;

      if v_acct_co is null or v_acct_co <> v_company then
        raise exception 'account on line % does not belong to this company', v_n;
      end if;
      if v_is_group then
        raise exception 'account on line % is a group heading and cannot be posted to', v_n;
      end if;
      if not v_active then
        raise exception 'account on line % is inactive', v_n;
      end if;

      -- ===== THE TWO-BOOK RULE =====
      if v_book_kind = 'adjustment' and v_is_cash then
        raise exception
          'a management-book entry cannot touch a bank or cash account (line %). Money that moved through the company bank belongs in the statutory book.', v_n;
      end if;

      insert into journal_lines (
        entry_id, line_no, account_id, debit, credit, currency, fx_rate,
        base_debit, base_credit, party_id, line_narration)
      values (
        v_entry, v_n, v_acct, v_d, v_c,
        coalesce(v_line->>'currency','INR'), v_fx,
        round(v_d * v_fx, 2), round(v_c * v_fx, 2),
        nullif(v_line->>'party_id','')::uuid,
        nullif(v_line->>'line_narration',''));

      v_debit  := v_debit  + round(v_d * v_fx, 2);
      v_credit := v_credit + round(v_c * v_fx, 2);
    end;
  end loop;

  if v_status = 'posted' then
    if v_n < 2 then raise exception 'an entry needs at least 2 lines'; end if;
    if v_debit <> v_credit then
      raise exception 'entry is out of balance: debit % <> credit %', v_debit, v_credit;
    end if;

    perform pg_advisory_xact_lock(hashtext(v_company::text || v_book::text)::bigint);

    insert into voucher_series (company_id, book_id, voucher_type, prefix, next_number)
      values (v_company, v_book, v_type, upper(substr(v_type,1,2)), 1)
      on conflict (company_id, book_id, voucher_type) do nothing;

    update voucher_series
       set next_number = next_number + 1
     where company_id = v_company and book_id = v_book and voucher_type = v_type
    returning prefix || '-' || lpad((next_number - 1)::text, width, '0') into v_no;

    select coalesce(max(seq), 0) + 1 into v_seq
      from journal_entries where company_id = v_company and book_id = v_book;
    select hash into v_prev
      from journal_entries
     where company_id = v_company and book_id = v_book and seq = v_seq - 1;
    v_prev := coalesce(v_prev, decode(repeat('00', 32), 'hex'));

    select string_agg(
             l.line_no || ':' || l.account_id || ':' || l.base_debit || ':' || l.base_credit,
             '|' order by l.line_no)
      into v_canon
      from journal_lines l where l.entry_id = v_entry;

    -- single statement: stamp AND promote draft -> posted
    update journal_entries
       set voucher_no = v_no,
           status     = 'posted',
           seq        = v_seq,
           prev_hash  = v_prev,
           hash       = extensions.digest(v_prev ||
                          convert_to(v_company::text || v_book::text || v_no ||
                                     v_date::text || coalesce(v_canon,''), 'UTF8'),
                          'sha256'),
           posted_by  = auth.uid(),
           posted_at  = now()
     where id = v_entry;
  else
    update journal_entries
       set voucher_no = 'DRAFT-' || substr(v_entry::text, 1, 8)
     where id = v_entry;
  end if;

  return v_entry;
end; $$;

grant execute on function public.save_journal_entry(jsonb) to authenticated;
