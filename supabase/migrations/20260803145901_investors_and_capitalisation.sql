create or replace function public.update_investor(p_investor uuid, p_payload jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  i         investors%rowtype;
  v_before  jsonb;
  v_name    text := nullif(trim(regexp_replace(coalesce(p_payload->>'display_name',''), '\s+', ' ', 'g')), '');
  v_pct     numeric(9,6);
  v_amt     numeric(18,2);
  v_changes text[] := '{}';
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;

  select * into i from investors where id = p_investor;
  if i.id is null then raise exception 'Investor not found.'; end if;
  if not public.company_has_right(i.company_id, 'manage_members') then
    raise exception 'Your role cannot change investor details.';
  end if;

  v_before := to_jsonb(i);

  if v_name is not null and v_name <> i.display_name then
    v_changes := v_changes || format('renamed from "%s" to "%s"', i.display_name, v_name);
    update investors set display_name = v_name where id = p_investor;
    update parties  set name = v_name where id = i.party_id;
    if i.capital_account_id is not null then
      update accounts set name = 'Capital - ' || v_name where id = i.capital_account_id;
    end if;
  end if;

  if p_payload ? 'agreed_share_pct' then
    v_pct := nullif(p_payload->>'agreed_share_pct','')::numeric;
    if v_pct is null or v_pct < 0 or v_pct > 100 then
      raise exception 'A share has to be between 0 and 100 percent.';
    end if;
    if v_pct is distinct from i.agreed_share_pct then
      v_changes := v_changes || format('share %s%% -> %s%%', i.agreed_share_pct, v_pct);
      update investors set agreed_share_pct = v_pct where id = p_investor;
    end if;
  end if;

  if p_payload ? 'committed_amount' then
    v_amt := nullif(p_payload->>'committed_amount','')::numeric;
    if v_amt is null or v_amt < 0 then raise exception 'A commitment cannot be negative.'; end if;
    if v_amt is distinct from i.committed_amount then
      v_changes := v_changes || format('commitment %s -> %s',
                                       to_char(i.committed_amount,'FM99,99,99,990.00'),
                                       to_char(v_amt,'FM99,99,99,990.00'));
      update investors set committed_amount = v_amt where id = p_investor;
    end if;
  end if;

  if p_payload ? 'is_active' then
    update investors set is_active = coalesce((p_payload->>'is_active')::boolean, true)
     where id = p_investor;
  end if;
  if p_payload ? 'notes' then
    update investors set notes = nullif(trim(p_payload->>'notes'),'') where id = p_investor;
  end if;

  if (select to_jsonb(x) from investors x where x.id = p_investor) = v_before then return; end if;

  perform public.log_master_change(
    i.company_id, 'investor', p_investor, 'update',
    format('%s: %s', coalesce(v_name, i.display_name),
           case when array_length(v_changes,1) is not null
                then array_to_string(v_changes, ', ') else 'details updated' end),
    v_before,
    (select to_jsonb(x) from investors x where x.id = p_investor));
end;
$$;

create or replace function public.investor_share_check(p_company uuid)
returns table (total_pct numeric, investor_count int, status text, message text)
language sql
stable
security definer
set search_path = public
as $$
  with s as (
    select round(coalesce(sum(agreed_share_pct), 0), 4) as pct,
           count(*)::int as n
      from investors
     where company_id = p_company and is_active
       and public.company_is_member(p_company))
  select s.pct, s.n,
         case when s.n = 0 then 'none'
              when s.pct = 100 then 'ok'
              when s.pct > 100 then 'over'
              else 'under' end,
         case when s.n = 0 then 'No investors recorded yet.'
              when s.pct = 100 then 'The agreed shares add up to 100%.'
              when s.pct > 100 then
                'The agreed shares add up to ' || s.pct ||
                '%, which is more than the whole business. One of them is too high.'
              else
                'The agreed shares add up to ' || s.pct || '%. The remaining ' ||
                round(100 - s.pct, 4) ||
                '% is unallocated — fine if you are still bringing partners in.'
         end
    from s;
$$;

create or replace function public.update_capital_project(p_project uuid, p_payload jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  c         capital_projects%rowtype;
  v_before  jsonb;
  v_name    text := nullif(trim(regexp_replace(coalesce(p_payload->>'name',''), '\s+', ' ', 'g')), '');
  v_budget  numeric(18,2);
  v_changes text[] := '{}';
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;

  select * into c from capital_projects where id = p_project;
  if c.id is null then raise exception 'Project not found.'; end if;
  if not public.company_has_right(c.company_id, 'manage_capital_project') then
    raise exception 'Your role cannot change capital projects.';
  end if;

  v_before := to_jsonb(c);

  if v_name is not null and v_name <> c.name then
    if exists (select 1 from capital_projects
                where company_id = c.company_id and id <> c.id
                  and lower(trim(name)) = lower(v_name)) then
      raise exception 'A project called "%" already exists.', v_name;
    end if;
    v_changes := v_changes || format('renamed from "%s" to "%s"', c.name, v_name);
    update capital_projects set name = v_name where id = p_project;
  end if;

  if p_payload ? 'budget_amount' then
    v_budget := nullif(p_payload->>'budget_amount','')::numeric;
    if v_budget is null or v_budget < 0 then raise exception 'A budget cannot be negative.'; end if;
    if v_budget is distinct from c.budget_amount then
      v_changes := v_changes || format('budget %s -> %s',
                                       to_char(c.budget_amount,'FM99,99,99,990.00'),
                                       to_char(v_budget,'FM99,99,99,990.00'));
      update capital_projects set budget_amount = v_budget where id = p_project;
    end if;
  end if;

  if p_payload ? 'description' then
    update capital_projects set description = nullif(trim(p_payload->>'description'),'')
     where id = p_project;
  end if;
  if p_payload ? 'target_date' then
    update capital_projects set target_date = nullif(p_payload->>'target_date','')::date
     where id = p_project;
  end if;

  if (select to_jsonb(x) from capital_projects x where x.id = p_project) = v_before then return; end if;

  perform public.log_master_change(
    c.company_id, 'capital_project', p_project, 'update',
    format('%s: %s', coalesce(v_name, c.name),
           case when array_length(v_changes,1) is not null
                then array_to_string(v_changes, ', ') else 'details updated' end),
    v_before,
    (select to_jsonb(x) from capital_projects x where x.id = p_project));
end;
$$;

create or replace function public.capitalize_project(p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project uuid := (p_payload->>'capital_project_id')::uuid;
  v_to      uuid := (p_payload->>'to_account_id')::uuid;
  v_date    date := coalesce(nullif(p_payload->>'event_date','')::date, current_date);
  v_amt     numeric(18,2) := round(coalesce((p_payload->>'amount')::numeric, 0), 2);
  v_life    int  := nullif(p_payload->>'useful_life_months','')::int;
  v_book    uuid := nullif(p_payload->>'book_id','')::uuid;
  c         capital_projects%rowtype;
  v_cwip    numeric(18,2);
  v_entry   uuid;
  v_to_nm   text;
  v_to_role text;
  v_left    numeric(18,2);
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;

  select * into c from capital_projects where id = v_project;
  if c.id is null then raise exception 'Project not found.'; end if;
  if not public.company_has_right(c.company_id, 'manage_capital_project') then
    raise exception 'Your role cannot capitalise a project.';
  end if;
  if not public.company_has_right(c.company_id, 'post_entry') then
    raise exception 'Your role cannot post the entry this creates.';
  end if;
  if c.cwip_account_id is null then
    raise exception '"%" has no work-in-progress account, so there is nothing to capitalise from.', c.name;
  end if;

  if v_book is null then
    select id into v_book from books where company_id = c.company_id and kind = 'primary';
  end if;

  select round(coalesce(sum(l.base_debit - l.base_credit), 0), 2) into v_cwip
    from journal_lines l
    join journal_entries e on e.id = l.entry_id
   where l.account_id = c.cwip_account_id
     and e.company_id = c.company_id
     and e.book_id = v_book
     and e.status = 'posted';

  if v_cwip <= 0 then
    raise exception 'There is nothing in work-in-progress for "%" to capitalise.', c.name;
  end if;

  if v_amt <= 0 then v_amt := v_cwip; end if;
  if v_amt > v_cwip then
    raise exception 'Only % is sitting in work-in-progress. You cannot capitalise more than that.',
      to_char(v_cwip, 'FM99,99,99,990.00');
  end if;

  select name, capex_role into v_to_nm, v_to_role from accounts
   where id = v_to and company_id = c.company_id and not is_group and is_active;
  if v_to_nm is null then raise exception 'Choose the asset account this becomes.'; end if;
  if v_to = c.cwip_account_id then
    raise exception 'That is the work-in-progress account itself. Choose the asset it becomes.';
  end if;
  if v_to_role is distinct from 'ppe' then
    raise exception
      '"%" is not a fixed-asset account. Finished work becomes something you own — pick one of your equipment, furniture or building accounts.',
      v_to_nm;
  end if;

  v_entry := public.save_journal_entry(jsonb_build_object(
    'company_id', c.company_id,
    'book_id',    v_book,
    'voucher_type','capitalization',
    'entry_date', v_date,
    'narration',  coalesce(nullif(trim(p_payload->>'narration'),''),
                           format('%s completed and brought into use', c.name)),
    'adjustment_reason', nullif(trim(p_payload->>'adjustment_reason'),''),
    'status','posted',
    'source','system',
    'lines', jsonb_build_array(
      jsonb_build_object('account_id', v_to, 'debit',  v_amt,
                         'line_narration', 'Capitalised from ' || c.name),
      jsonb_build_object('account_id', c.cwip_account_id, 'credit', v_amt,
                         'line_narration', 'Work completed'))));

  insert into capitalization_events (company_id, capital_project_id, event_date,
                                     from_account_id, to_account_id, amount,
                                     journal_entry_id, useful_life_months)
  values (c.company_id, v_project, v_date, c.cwip_account_id, v_to, v_amt,
          v_entry, v_life);

  v_left := round(v_cwip - v_amt, 2);
  if v_left = 0 then
    update capital_projects
       set status = 'capitalized', capitalized_on = v_date
     where id = v_project;
  end if;

  perform public.log_master_change(
    c.company_id, 'capital_project', v_project, 'capitalize',
    format('%s capitalised into %s on %s — %s.%s',
           c.name, v_to_nm, to_char(v_date,'DD Mon YYYY'),
           to_char(v_amt,'FM99,99,99,990.00'),
           case when v_left > 0
                then ' ' || to_char(v_left,'FM99,99,99,990.00') || ' still under way.'
                else ' Project closed.' end),
    jsonb_build_object('cwip_before', v_cwip),
    jsonb_build_object('entry_id', v_entry, 'amount', v_amt, 'cwip_left', v_left));

  return v_entry;
end;
$$;

revoke all on function public.update_investor(uuid, jsonb)          from public, anon;
revoke all on function public.investor_share_check(uuid)            from public, anon;
revoke all on function public.update_capital_project(uuid, jsonb)   from public, anon;
revoke all on function public.capitalize_project(jsonb)             from public, anon;

grant execute on function public.update_investor(uuid, jsonb)        to authenticated;
grant execute on function public.investor_share_check(uuid)          to authenticated;
grant execute on function public.update_capital_project(uuid, jsonb) to authenticated;
grant execute on function public.capitalize_project(jsonb)           to authenticated;
