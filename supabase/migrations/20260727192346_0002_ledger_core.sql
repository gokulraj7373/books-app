create extension if not exists pgcrypto;

create table if not exists books (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies(id) on delete cascade,
  code         text not null,
  name         text not null,
  kind         text not null check (kind in ('primary','adjustment')),
  base_book_id uuid references books(id) on delete restrict,
  is_statutory boolean not null default false,
  created_at   timestamptz not null default now(),
  unique (company_id, code),
  check ((kind = 'primary') = (base_book_id is null))
);
create unique index if not exists one_primary_book_per_company
  on books (company_id) where kind = 'primary';

create table if not exists parties (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references companies(id) on delete cascade,
  name           text not null,
  party_type     text check (party_type in ('customer','vendor','investor','staff','other')),
  gstin          text,
  pan            text,
  phone          text,
  email          text,
  is_related_party boolean not null default false,
  linked_user_id uuid references auth.users(id) on delete set null,
  notes          text,
  created_at     timestamptz not null default now()
);
create index if not exists parties_company_idx on parties (company_id);
create unique index if not exists parties_name_uniq
  on parties (company_id, lower(trim(name)));

create table if not exists accounts (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references companies(id) on delete cascade,
  code            text not null,
  name            text not null,
  account_type    text not null check (account_type in
                    ('asset','liability','equity','income','expense')),
  account_group   text,
  sub_group       text,
  normal_balance  char(1) not null check (normal_balance in ('D','C')),
  parent_id       uuid references accounts(id) on delete restrict,
  is_group        boolean not null default false,
  capex_role      text check (capex_role in
                    ('cwip','capital_advance','ppe','accum_dep','deposit','capital')),
  is_bank_or_cash boolean not null default false,
  is_active       boolean not null default true,
  is_system       boolean not null default false,
  opening_debit   numeric(18,2) not null default 0 check (opening_debit  >= 0),
  opening_credit  numeric(18,2) not null default 0 check (opening_credit >= 0),
  created_at      timestamptz not null default now(),
  unique (company_id, code)
);
create unique index if not exists accounts_name_uniq
  on accounts (company_id, lower(trim(name)));
create index if not exists accounts_company_type_idx on accounts (company_id, account_type);

create table if not exists voucher_series (
  company_id   uuid not null references companies(id) on delete cascade,
  book_id      uuid not null references books(id) on delete cascade,
  voucher_type text not null,
  prefix       text not null default 'V',
  next_number  bigint not null default 1,
  width        int not null default 3,
  primary key (company_id, book_id, voucher_type)
);

create table if not exists period_locks (
  company_id      uuid not null references companies(id) on delete cascade,
  book_id         uuid not null references books(id) on delete cascade,
  locked_through  date not null,
  locked_by       uuid references auth.users(id) on delete set null,
  locked_at       timestamptz not null default now(),
  primary key (company_id, book_id)
);

create table if not exists journal_entries (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references companies(id) on delete cascade,
  book_id        uuid not null references books(id) on delete restrict,
  fiscal_year_id uuid not null references fiscal_years(id) on delete restrict,
  voucher_no     text not null,
  voucher_type   text not null check (voucher_type in
                   ('receipt','payment','contra','journal','sales','purchase',
                    'capitalization','opening','closing')),
  entry_date     date not null,
  narration      text not null check (length(trim(narration)) > 0),
  party_id       uuid references parties(id) on delete restrict,
  payment_mode   text check (payment_mode in
                   ('cash','bank_transfer','upi','cheque','card','neft_rtgs','auto_debit','other')),
  reference_no   text,
  proof_url      text,
  status         text not null default 'draft' check (status in ('draft','posted','reversed')),
  adjustment_reason text,
  reverses_entry_id      uuid references journal_entries(id) on delete restrict,
  reversed_by_entry_id   uuid references journal_entries(id) on delete restrict,
  promoted_from_entry_id uuid references journal_entries(id) on delete restrict,
  source         text not null default 'manual'
                   check (source in ('manual','import','api','recurring','system')),
  idempotency_key text,
  seq            bigint,
  prev_hash      bytea,
  hash           bytea,
  created_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  posted_by      uuid references auth.users(id) on delete set null,
  posted_at      timestamptz,
  unique (company_id, book_id, voucher_no),
  unique (company_id, book_id, seq),
  unique (company_id, idempotency_key)
);
create index if not exists je_company_date_idx on journal_entries (company_id, entry_date);
create index if not exists je_book_status_idx  on journal_entries (book_id, status);

create table if not exists journal_lines (
  id          uuid primary key default gen_random_uuid(),
  entry_id    uuid not null references journal_entries(id) on delete cascade,
  line_no     int not null,
  account_id  uuid not null references accounts(id) on delete restrict,
  debit       numeric(18,2) not null default 0 check (debit  >= 0),
  credit      numeric(18,2) not null default 0 check (credit >= 0),
  currency    char(3) not null default 'INR',
  fx_rate     numeric(18,8) not null default 1 check (fx_rate > 0),
  base_debit  numeric(18,2) not null default 0 check (base_debit  >= 0),
  base_credit numeric(18,2) not null default 0 check (base_credit >= 0),
  party_id    uuid references parties(id) on delete restrict,
  line_narration text,
  tax_code    text,
  hsn_sac     text,
  qty         numeric(18,3),
  unit        text,
  constraint jl_one_side_only check (debit = 0 or credit = 0),
  constraint jl_not_zero      check (debit > 0 or credit > 0),
  unique (entry_id, line_no)
);
create index if not exists jl_entry_idx   on journal_lines (entry_id);
create index if not exists jl_account_idx on journal_lines (account_id);

create or replace function public.assert_entry_balanced()
returns trigger language plpgsql set search_path = public as $$
declare
  v_entry uuid;
  v_debit numeric(18,2);
  v_credit numeric(18,2);
  v_count int;
  v_status text;
begin
  v_entry := coalesce(new.entry_id, old.entry_id);
  select status into v_status from journal_entries where id = v_entry;
  if v_status is null then return null; end if;
  if v_status = 'draft' then return null; end if;

  select coalesce(sum(base_debit),0), coalesce(sum(base_credit),0), count(*)
    into v_debit, v_credit, v_count
    from journal_lines where entry_id = v_entry;

  if v_count < 2 then
    raise exception 'entry % must have at least 2 lines (has %)', v_entry, v_count;
  end if;
  if v_debit <> v_credit then
    raise exception 'entry % is out of balance: debit % <> credit %', v_entry, v_debit, v_credit;
  end if;
  return null;
end; $$;

drop trigger if exists jl_balanced on journal_lines;
create constraint trigger jl_balanced
  after insert or update or delete on journal_lines
  deferrable initially deferred
  for each row execute function public.assert_entry_balanced();

create or replace function public.block_if_posted()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if old.status in ('posted','reversed') then
      raise exception 'posted entry % cannot be deleted; reverse it instead', old.id;
    end if;
    return old;
  end if;

  if old.status in ('posted','reversed') then
    if row(new.company_id, new.book_id, new.fiscal_year_id, new.voucher_no, new.voucher_type,
           new.entry_date, new.narration, new.party_id, new.payment_mode, new.reference_no,
           new.adjustment_reason, new.seq, new.prev_hash, new.hash, new.posted_by, new.posted_at)
       is distinct from
       row(old.company_id, old.book_id, old.fiscal_year_id, old.voucher_no, old.voucher_type,
           old.entry_date, old.narration, old.party_id, old.payment_mode, old.reference_no,
           old.adjustment_reason, old.seq, old.prev_hash, old.hash, old.posted_by, old.posted_at)
    then
      raise exception 'posted entry % is immutable; reverse it and re-enter', old.id;
    end if;
  end if;
  return new;
end; $$;

drop trigger if exists je_immutable on journal_entries;
create trigger je_immutable before update or delete on journal_entries
  for each row execute function public.block_if_posted();

create or replace function public.block_lines_if_posted()
returns trigger language plpgsql set search_path = public as $$
declare v_status text;
begin
  select status into v_status from journal_entries
    where id = coalesce(new.entry_id, old.entry_id);
  if v_status in ('posted','reversed') then
    raise exception 'lines of a posted entry are immutable; reverse it and re-enter';
  end if;
  return coalesce(new, old);
end; $$;

drop trigger if exists jl_immutable on journal_lines;
create trigger jl_immutable before update or delete on journal_lines
  for each row execute function public.block_lines_if_posted();

grant select, insert, update, delete on books, parties, accounts to authenticated;
grant select on journal_entries, journal_lines, voucher_series, period_locks to authenticated;

alter table books           enable row level security;
alter table parties         enable row level security;
alter table accounts        enable row level security;
alter table voucher_series  enable row level security;
alter table period_locks    enable row level security;
alter table journal_entries enable row level security;
alter table journal_lines   enable row level security;

drop policy if exists books_select on books;
create policy books_select on books for select to authenticated
  using (public.company_is_member(company_id));
drop policy if exists books_write on books;
create policy books_write on books for all to authenticated
  using (public.company_has_right(company_id, 'manage_books'))
  with check (public.company_has_right(company_id, 'manage_books'));

drop policy if exists parties_select on parties;
create policy parties_select on parties for select to authenticated
  using (public.company_is_member(company_id));
drop policy if exists parties_write on parties;
create policy parties_write on parties for all to authenticated
  using (public.company_has_right(company_id, 'edit_coa'))
  with check (public.company_has_right(company_id, 'edit_coa'));

drop policy if exists accounts_select on accounts;
create policy accounts_select on accounts for select to authenticated
  using (public.company_is_member(company_id));
drop policy if exists accounts_write on accounts;
create policy accounts_write on accounts for all to authenticated
  using (public.company_has_right(company_id, 'edit_coa'))
  with check (public.company_has_right(company_id, 'edit_coa'));

drop policy if exists vs_select on voucher_series;
create policy vs_select on voucher_series for select to authenticated
  using (public.company_is_member(company_id));
drop policy if exists pl_select on period_locks;
create policy pl_select on period_locks for select to authenticated
  using (public.company_is_member(company_id));

drop policy if exists je_select on journal_entries;
create policy je_select on journal_entries for select to authenticated
  using (public.company_is_member(company_id)
         and public.company_has_right(company_id, 'view_ledger'));

drop policy if exists jl_select on journal_lines;
create policy jl_select on journal_lines for select to authenticated
  using (exists (select 1 from journal_entries je
                 where je.id = journal_lines.entry_id
                   and public.company_is_member(je.company_id)
                   and public.company_has_right(je.company_id, 'view_ledger')));
