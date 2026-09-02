-- ============================================================================
-- 0011 — Party sub-ledgers and capital projects.
--
-- WHY PARTIES ARE NOT ACCOUNTS
-- Tally gives every supplier its own ledger under a group. That works, but the
-- chart of accounts becomes unbounded and every report has to cope with hundreds
-- of leaf accounts. The modern approach (Zoho, QuickBooks, Xero, NetSuite) posts
-- to a small control account and carries the party as a DIMENSION on the line.
-- party_statement() below then reproduces exactly what a Tally party ledger
-- shows, without the chart of accounts growing without limit.
-- ============================================================================

-- ---- link journal lines to a capital project budget line -------------------
alter table journal_lines
  add column if not exists capital_project_line_id uuid;

-- ---- capital projects ------------------------------------------------------
create table if not exists capital_projects (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies(id) on delete cascade,
  name         text not null,
  description  text,
  status       text not null default 'in_progress'
                 check (status in ('planning','in_progress','capitalized','on_hold','abandoned')),
  -- where spend accumulates until the work is finished
  cwip_account_id uuid references accounts(id) on delete restrict,
  budget_amount   numeric(18,2) not null default 0 check (budget_amount >= 0),
  start_date      date,
  target_date     date,
  capitalized_on  date,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  unique (company_id, name)
);
create index if not exists capital_projects_company_idx on capital_projects (company_id);

create table if not exists capital_project_lines (
  id                  uuid primary key default gen_random_uuid(),
  capital_project_id  uuid not null references capital_projects(id) on delete cascade,
  company_id          uuid not null references companies(id) on delete cascade,
  name                text not null,
  category            text,
  planned_amount      numeric(18,2) not null default 0 check (planned_amount >= 0),
  -- where this lands on the balance sheet once the work is done
  target_ppe_account_id uuid references accounts(id) on delete restrict,
  status              text not null default 'planned'
                        check (status in ('planned','quoting','ordered','received','done','dropped')),
  sort_order          int not null default 0,
  created_at          timestamptz not null default now()
);
create index if not exists cpl_project_idx on capital_project_lines (capital_project_id);

alter table journal_lines drop constraint if exists jl_capital_project_line_fk;
alter table journal_lines add constraint jl_capital_project_line_fk
  foreign key (capital_project_line_id) references capital_project_lines(id) on delete restrict;

-- ---- capitalization: CWIP becomes a real fixed asset -----------------------
create table if not exists capitalization_events (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references companies(id) on delete cascade,
  capital_project_id uuid not null references capital_projects(id) on delete restrict,
  event_date         date not null,
  from_account_id    uuid not null references accounts(id) on delete restrict,
  to_account_id      uuid not null references accounts(id) on delete restrict,
  amount             numeric(18,2) not null check (amount > 0),
  journal_entry_id   uuid not null references journal_entries(id) on delete restrict,
  useful_life_months int,
  created_at         timestamptz not null default now()
);

grant select, insert, update, delete on capital_projects, capital_project_lines to authenticated;
grant select on capitalization_events to authenticated;

alter table capital_projects      enable row level security;
alter table capital_project_lines enable row level security;
alter table capitalization_events enable row level security;

drop policy if exists cp_select on capital_projects;
create policy cp_select on capital_projects for select to authenticated
  using (public.company_is_member(company_id) and public.company_has_right(company_id,'view_capex'));
drop policy if exists cp_write on capital_projects;
create policy cp_write on capital_projects for all to authenticated
  using (public.company_has_right(company_id,'manage_capital_project'))
  with check (public.company_has_right(company_id,'manage_capital_project'));

drop policy if exists cpl_select on capital_project_lines;
create policy cpl_select on capital_project_lines for select to authenticated
  using (public.company_is_member(company_id) and public.company_has_right(company_id,'view_capex'));
drop policy if exists cpl_write on capital_project_lines;
create policy cpl_write on capital_project_lines for all to authenticated
  using (public.company_has_right(company_id,'manage_capital_project'))
  with check (public.company_has_right(company_id,'manage_capital_project'));

drop policy if exists ce_select on capitalization_events;
create policy ce_select on capitalization_events for select to authenticated
  using (public.company_is_member(company_id) and public.company_has_right(company_id,'view_capex'));

-- ============================================================================
-- find_or_create_party — the "where do I create the ledger?" answer.
-- Typing a new name during entry creates the party. Anyone who may draft an
-- entry may do this; requiring edit_coa would block the cashier and the site
-- coordinator, who are exactly the people entering supplier payments.
-- ============================================================================
create or replace function public.find_or_create_party(
  p_company uuid, p_name text, p_type text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_clean text;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if not (public.company_has_right(p_company,'draft_entry')
          or public.company_has_right(p_company,'post_entry')) then
    raise exception 'you do not have permission to add a party';
  end if;

  v_clean := nullif(trim(regexp_replace(p_name, '\s+', ' ', 'g')), '');
  if v_clean is null then raise exception 'a name is required'; end if;

  select id into v_id from parties
   where company_id = p_company and lower(trim(name)) = lower(v_clean);
  if v_id is not null then return v_id; end if;

  insert into parties (company_id, name, party_type)
  values (p_company, v_clean, nullif(p_type,''))
  returning id into v_id;
  return v_id;
end; $$;

-- ============================================================================
-- party_statement — a Tally-style party ledger: every line touching this party,
-- with a running balance. Positive = they owe us; negative = we owe them.
-- ============================================================================
create or replace function public.party_statement(
  p_company uuid, p_party uuid, p_book uuid,
  p_from date default null, p_to date default null)
returns table (
  entry_date date, voucher_no text, narration text, account_name text,
  debit numeric(18,2), credit numeric(18,2), running numeric(18,2), entry_id uuid)
language sql stable security definer set search_path = public as $$
  with scope as (select unnest(public.book_scope(p_book)) as book_id),
  opening as (
    select coalesce(sum(l.base_debit - l.base_credit),0) as bal
      from journal_lines l join journal_entries e on e.id = l.entry_id
     where e.company_id = p_company and e.book_id in (select book_id from scope)
       and e.status='posted' and l.party_id = p_party
       and p_from is not null and e.entry_date < p_from),
  rows as (
    select e.entry_date, e.voucher_no, e.narration, a.name as account_name,
           l.base_debit as debit, l.base_credit as credit,
           e.seq, l.line_no, e.id as entry_id
      from journal_lines l
      join journal_entries e on e.id = l.entry_id
      join accounts a on a.id = l.account_id
     where e.company_id = p_company and e.book_id in (select book_id from scope)
       and e.status='posted' and l.party_id = p_party
       and (p_from is null or e.entry_date >= p_from)
       and (p_to   is null or e.entry_date <= p_to))
  select r.entry_date, r.voucher_no, r.narration, r.account_name, r.debit, r.credit,
         round((select bal from opening)
               + sum(r.debit - r.credit) over (order by r.entry_date, r.seq, r.line_no
                                               rows between unbounded preceding and current row), 2),
         r.entry_id
    from rows r
   where public.company_is_member(p_company)
     and public.company_has_right(p_company,'view_ledger')
   order by r.entry_date, r.seq, r.line_no;
$$;

-- ---- every party with an outstanding balance -------------------------------
create or replace function public.party_balances(p_company uuid, p_book uuid)
returns table (
  party_id uuid, name text, party_type text, is_related_party boolean,
  balance numeric(18,2), last_activity date, entry_count bigint)
language sql stable security definer set search_path = public as $$
  with scope as (select unnest(public.book_scope(p_book)) as book_id)
  select p.id, p.name, p.party_type, p.is_related_party,
         round(coalesce(sum(l.base_debit - l.base_credit),0),2),
         max(e.entry_date),
         count(distinct e.id)
    from parties p
    left join journal_lines l on l.party_id = p.id
    left join journal_entries e on e.id = l.entry_id
         and e.status='posted' and e.book_id in (select book_id from scope)
   where p.company_id = p_company
     and public.company_is_member(p_company)
     and public.company_has_right(p_company,'view_ledger')
   group by p.id, p.name, p.party_type, p.is_related_party
   order by abs(round(coalesce(sum(l.base_debit - l.base_credit),0),2)) desc, p.name;
$$;

-- ============================================================================
-- capex_summary — planned vs spent per project, computed from the ledger.
-- Actuals are NEVER stored on the project; they come from journal lines, so the
-- project view and the balance sheet can never disagree.
-- ============================================================================
create or replace function public.capex_summary(p_company uuid, p_book uuid)
returns table (
  project_id uuid, name text, status text, budget_amount numeric(18,2),
  planned_amount numeric(18,2), spent numeric(18,2),
  cwip_balance numeric(18,2), line_count bigint, capitalized_on date)
language sql stable security definer set search_path = public as $$
  with scope as (select unnest(public.book_scope(p_book)) as book_id),
  spend as (
    select cpl.capital_project_id as pid,
           sum(l.base_debit - l.base_credit) as spent
      from journal_lines l
      join capital_project_lines cpl on cpl.id = l.capital_project_line_id
      join journal_entries e on e.id = l.entry_id
     where e.status='posted' and e.book_id in (select book_id from scope)
     group by cpl.capital_project_id),
  cwip as (
    select cp.id as pid, sum(l.base_debit - l.base_credit) as bal
      from capital_projects cp
      join journal_lines l on l.account_id = cp.cwip_account_id
      join journal_entries e on e.id = l.entry_id
     where e.status='posted' and e.book_id in (select book_id from scope)
       and cp.company_id = p_company
     group by cp.id)
  select cp.id, cp.name, cp.status, cp.budget_amount,
         round(coalesce((select sum(planned_amount) from capital_project_lines
                          where capital_project_id = cp.id),0),2),
         round(coalesce(s.spent,0),2),
         round(coalesce(w.bal,0),2),
         (select count(*) from capital_project_lines where capital_project_id = cp.id),
         cp.capitalized_on
    from capital_projects cp
    left join spend s on s.pid = cp.id
    left join cwip  w on w.pid = cp.id
   where cp.company_id = p_company
     and public.company_is_member(p_company)
     and public.company_has_right(p_company,'view_capex')
   order by cp.created_at;
$$;

revoke all on function public.find_or_create_party(uuid,text,text)          from public, anon;
revoke all on function public.party_statement(uuid,uuid,uuid,date,date)     from public, anon;
revoke all on function public.party_balances(uuid,uuid)                     from public, anon;
revoke all on function public.capex_summary(uuid,uuid)                      from public, anon;
grant execute on function public.find_or_create_party(uuid,text,text),
                         public.party_statement(uuid,uuid,uuid,date,date),
                         public.party_balances(uuid,uuid),
                         public.capex_summary(uuid,uuid) to authenticated;
