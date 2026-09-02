-- journal_entries.created_by / posted_by are FKs with `on delete set null`, so
-- deleting a user makes Postgres null them — which the immutability trigger
-- refused. Net effect: any user who had ever posted an entry could never be
-- deleted, blocking account closure and DPDP erasure.
--
-- Simply allowing the null would destroy the audit trail ("who posted this?"),
-- which a statutory audit needs. So capture the actor's identity as an immutable
-- TEXT snapshot at post time. The FK can then be nulled freely on user deletion
-- while the audit trail survives.
--
-- Note these columns are deliberately NOT part of the hash chain (which covers
-- company, book, voucher_no, date and the lines), so this changes no hash.

alter table journal_entries add column if not exists created_by_name text;
alter table journal_entries add column if not exists posted_by_name  text;

-- backfill from profiles for anything already posted
update journal_entries je
   set created_by_name = coalesce(je.created_by_name, p.full_name, p.email),
       posted_by_name  = coalesce(je.posted_by_name,  p2.full_name, p2.email)
  from profiles p
  left join profiles p2 on true
 where p.id = je.created_by and p2.id = je.posted_by;

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
    -- Allow the FK cascade to null the actor references; the *_name snapshot
    -- preserves the audit trail. Anything else on a posted entry is immutable.
    if row(new.company_id, new.book_id, new.fiscal_year_id, new.voucher_no, new.voucher_type,
           new.entry_date, new.narration, new.party_id, new.payment_mode, new.reference_no,
           new.adjustment_reason, new.seq, new.prev_hash, new.hash,
           new.created_by_name, new.posted_by_name, new.posted_at)
       is distinct from
       row(old.company_id, old.book_id, old.fiscal_year_id, old.voucher_no, old.voucher_type,
           old.entry_date, old.narration, old.party_id, old.payment_mode, old.reference_no,
           old.adjustment_reason, old.seq, old.prev_hash, old.hash,
           old.created_by_name, old.posted_by_name, old.posted_at)
    then
      raise exception 'posted entry % is immutable; reverse it and re-enter', old.id;
    end if;

    -- created_by / posted_by may only go to NULL (user deleted), never be reassigned
    if new.created_by is distinct from old.created_by and new.created_by is not null then
      raise exception 'the author of posted entry % cannot be reassigned', old.id;
    end if;
    if new.posted_by is distinct from old.posted_by and new.posted_by is not null then
      raise exception 'the poster of posted entry % cannot be reassigned', old.id;
    end if;
  end if;
  return new;
end; $$;

revoke all on function public.block_if_posted() from public, anon, authenticated;

-- stamp the identity snapshot at save time
create or replace function public.stamp_actor_name()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.created_by_name is null and new.created_by is not null then
    select coalesce(full_name, email) into new.created_by_name
      from profiles where id = new.created_by;
  end if;
  if new.posted_by is not null and new.posted_by_name is null then
    select coalesce(full_name, email) into new.posted_by_name
      from profiles where id = new.posted_by;
  end if;
  return new;
end; $$;

drop trigger if exists je_stamp_actor on journal_entries;
create trigger je_stamp_actor before insert or update on journal_entries
  for each row execute function public.stamp_actor_name();

revoke all on function public.stamp_actor_name() from public, anon, authenticated;
