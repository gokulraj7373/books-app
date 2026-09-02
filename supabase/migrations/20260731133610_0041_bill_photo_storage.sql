-- ============================================================================
-- 0041  Somewhere to actually put a photo of a bill.
--
-- proof_url has existed since the start, but nothing in the app could ever
-- fill it — it was a text box asking for a URL nobody had, which is why every
-- bill ended up with nothing attached. This is the missing half: a private
-- storage bucket, one folder per company, readable by anyone in that company
-- and writable only by whoever has the upload_document right.
--
-- Kept private rather than public: these are financial documents, and a
-- public bucket means the URL alone is the only thing standing between the
-- internet and someone's bill. Access goes through a short-lived signed URL
-- instead, generated on demand.
-- ============================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('bill-proofs', 'bill-proofs', false, 10485760,
        array['image/jpeg','image/png','image/webp','image/heic','application/pdf'])
on conflict (id) do nothing;

drop policy if exists "bill proofs: members can view" on storage.objects;
create policy "bill proofs: members can view"
  on storage.objects for select
  using (
    bucket_id = 'bill-proofs'
    and exists (
      select 1 from company_members cm
       where cm.company_id::text = (storage.foldername(name))[1]
         and cm.user_id = auth.uid()
    )
  );

drop policy if exists "bill proofs: uploaders can add" on storage.objects;
create policy "bill proofs: uploaders can add"
  on storage.objects for insert
  with check (
    bucket_id = 'bill-proofs'
    and exists (
      select 1 from company_members cm
       where cm.company_id::text = (storage.foldername(name))[1]
         and cm.user_id = auth.uid()
         and coalesce((cm.rights->>'upload_document')::boolean, false)
    )
  );

-- A mistaken upload can be replaced before the bill is finalised, but never
-- silently after — same principle as the ledger itself.
drop policy if exists "bill proofs: uploaders can remove their own recent upload" on storage.objects;
create policy "bill proofs: uploaders can remove their own recent upload"
  on storage.objects for delete
  using (
    bucket_id = 'bill-proofs'
    and owner = auth.uid()
    and created_at > now() - interval '10 minutes'
  );
