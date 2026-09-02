create table if not exists public.company_tax_profile (
  company_id            uuid primary key references public.companies(id) on delete cascade,
  gst_regime            text not null default 'unregistered'
                          check (gst_regime in ('unregistered','regular','composition')),
  gst_registered_from   date,
  composition_rate_bps  int check (composition_rate_bps between 0 and 10000),
  itc_blocked_by_scheme boolean not null default false,
  itc_blocked_reason    text,
  tds_deductor          boolean not null default false,
  tan                   text,
  updated_at            timestamptz not null default now(),
  updated_by            uuid references auth.users(id) on delete set null,
  constraint gst_needs_a_start_date
    check (gst_regime = 'unregistered' or gst_registered_from is not null),
  constraint composition_needs_a_rate
    check (gst_regime <> 'composition' or composition_rate_bps is not null)
);

alter table public.company_tax_profile enable row level security;
grant select on public.company_tax_profile to authenticated;

drop policy if exists ctp_select on public.company_tax_profile;
create policy ctp_select on public.company_tax_profile for select to authenticated
  using (public.company_is_member(company_id));

create table if not exists public.feature_keys (
  key             text primary key,
  label           text not null,
  blurb           text,
  default_enabled boolean not null default false,
  sort            int not null default 0
);
grant select on public.feature_keys to authenticated;
alter table public.feature_keys enable row level security;
drop policy if exists feature_keys_read on public.feature_keys;
create policy feature_keys_read on public.feature_keys for select to authenticated using (true);

insert into public.feature_keys (key, label, blurb, default_enabled, sort) values
  ('capex','Building something','Track a fit-out or construction project against a budget',true,10),
  ('purchases_credit','Bills to pay later','Record a supplier bill now and pay it later',true,20),
  ('sales','Sales','Record money you earn from customers',false,30),
  ('inventory','Stock','Track goods you hold',false,40),
  ('payroll','Payroll','Salaries with PF, ESI and TDS deductions',false,50),
  ('loans','Loans and EMIs','Money the business borrowed, and repayments split into interest and principal',false,60),
  ('aggregators','Delivery aggregators','Settlements from Swiggy, Zomato and the like',false,70),
  ('asset_disposal','Selling assets','Selling or scrapping equipment you own',false,80),
  ('gst','GST','Input credit on purchases and GST on sales',false,90),
  ('tds','TDS','Tax deducted at source on contractor, rent and professional payments',false,100)
on conflict (key) do update
  set label = excluded.label, blurb = excluded.blurb, sort = excluded.sort;

create table if not exists public.company_features (
  company_id uuid not null references public.companies(id) on delete cascade,
  feature    text not null references public.feature_keys(key),
  enabled    boolean not null default true,
  changed_at timestamptz not null default now(),
  changed_by uuid references auth.users(id) on delete set null,
  primary key (company_id, feature)
);

alter table public.company_features enable row level security;
grant select on public.company_features to authenticated;

drop policy if exists cf_select on public.company_features;
create policy cf_select on public.company_features for select to authenticated
  using (public.company_is_member(company_id));

create or replace function public.company_config(p_company uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case when public.company_is_member(p_company) then jsonb_build_object(
    'gst_regime',            coalesce(t.gst_regime, 'unregistered'),
    'gst_registered_from',   t.gst_registered_from,
    'composition_rate_bps',  t.composition_rate_bps,
    'itc_blocked_by_scheme', coalesce(t.itc_blocked_by_scheme, false),
    'itc_blocked_reason',    t.itc_blocked_reason,
    'tds_deductor',          coalesce(t.tds_deductor, false),
    'tan',                   t.tan,
    'gstin',                 c.gstin,
    'state_code',            c.state_code,
    'features', (
      select coalesce(jsonb_object_agg(fk.key,
               coalesce(cfe.enabled, fk.default_enabled)), '{}'::jsonb)
        from feature_keys fk
        left join company_features cfe
               on cfe.feature = fk.key and cfe.company_id = p_company)
  ) end
  from companies c
  left join company_tax_profile t on t.company_id = c.id
  where c.id = p_company;
$$;

create or replace function public.set_company_config(p_payload jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_co     uuid := (p_payload->>'company_id')::uuid;
  v_regime text := nullif(p_payload->>'gst_regime','');
  v_from   date := nullif(p_payload->>'gst_registered_from','')::date;
  v_rate   int  := nullif(p_payload->>'composition_rate_bps','')::int;
  v_gstin  text;
  v_before jsonb;
  v_feat   text;
  v_on     boolean;
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  if not public.company_has_right(v_co, 'manage_company') then
    raise exception 'Your role cannot change the company setup.';
  end if;

  v_before := public.company_config(v_co);

  if v_regime is not null then
    if v_regime not in ('unregistered','regular','composition') then
      raise exception 'Choose whether you are unregistered, registered normally, or on the composition scheme.';
    end if;

    select gstin into v_gstin from companies where id = v_co;
    if v_regime <> 'unregistered' and coalesce(trim(v_gstin),'') = '' then
      raise exception
        'Add your GSTIN in company details first — a registered business cannot be set up without it.';
    end if;
    if v_regime <> 'unregistered' and v_from is null then
      raise exception
        'Give the date your registration took effect. Input credit cannot be claimed on anything bought before it.';
    end if;
    if v_regime = 'composition' and v_rate is null then
      raise exception 'Give your composition rate.';
    end if;

    insert into company_tax_profile as t (
      company_id, gst_regime, gst_registered_from, composition_rate_bps,
      itc_blocked_by_scheme, itc_blocked_reason, tds_deductor, tan, updated_at, updated_by)
    values (
      v_co, v_regime,
      case when v_regime = 'unregistered' then null else v_from end,
      case when v_regime = 'composition' then v_rate else null end,
      coalesce((p_payload->>'itc_blocked_by_scheme')::boolean, false),
      nullif(trim(p_payload->>'itc_blocked_reason'),''),
      coalesce((p_payload->>'tds_deductor')::boolean, false),
      nullif(upper(trim(p_payload->>'tan')),''),
      now(), auth.uid())
    on conflict (company_id) do update set
      gst_regime            = excluded.gst_regime,
      gst_registered_from   = excluded.gst_registered_from,
      composition_rate_bps  = excluded.composition_rate_bps,
      itc_blocked_by_scheme = excluded.itc_blocked_by_scheme,
      itc_blocked_reason    = excluded.itc_blocked_reason,
      tds_deductor          = excluded.tds_deductor,
      tan                   = excluded.tan,
      updated_at            = now(),
      updated_by            = auth.uid();
  end if;

  if p_payload ? 'features' then
    for v_feat, v_on in
      select key, value::boolean from jsonb_each_text(p_payload->'features')
    loop
      if not exists (select 1 from feature_keys where key = v_feat) then
        raise exception 'There is no feature called "%".', v_feat;
      end if;
      insert into company_features (company_id, feature, enabled, changed_at, changed_by)
      values (v_co, v_feat, v_on, now(), auth.uid())
      on conflict (company_id, feature) do update
        set enabled = excluded.enabled, changed_at = now(), changed_by = auth.uid();
    end loop;
  end if;

  perform public.log_master_change(
    v_co, 'account', v_co, 'update',
    'Company setup changed — tax registration or which parts of the app are switched on.',
    v_before, public.company_config(v_co));
end;
$$;

revoke all on function public.company_config(uuid)      from public, anon;
revoke all on function public.set_company_config(jsonb)  from public, anon;
grant execute on function public.company_config(uuid)     to authenticated;
grant execute on function public.set_company_config(jsonb) to authenticated;
