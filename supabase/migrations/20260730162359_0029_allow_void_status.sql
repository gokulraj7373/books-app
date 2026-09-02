-- 'void' is a fourth state: still on the record, out of every report.
-- Reports already filter on status = 'posted', so a voided entry drops out of
-- them automatically, while verify_chain walks entries by seq regardless of
-- status — so voiding cannot break the tamper-evident chain.
alter table public.journal_entries drop constraint journal_entries_status_check;
alter table public.journal_entries add constraint journal_entries_status_check
  check (status = any (array['draft'::text, 'posted'::text, 'reversed'::text, 'void'::text]));

-- The immutability trigger must protect a voided entry exactly as it protects
-- a posted one: no edits, no deletes, ever.
create or replace function public.block_if_posted()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if old.status in ('posted','reversed','void') then
      raise exception 'posted entry % cannot be deleted; reverse or void it instead', old.id;
    end if;
    return old;
  end if;

  if old.status in ('posted','reversed','void') then
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

create or replace function public.block_lines_if_posted()
returns trigger language plpgsql set search_path = public as $$
declare v_status text;
begin
  select status into v_status from journal_entries
    where id = coalesce(new.entry_id, old.entry_id);
  if v_status in ('posted','reversed','void') then
    raise exception 'lines of a posted entry are immutable; reverse it and re-enter';
  end if;
  return coalesce(new, old);
end; $$;
