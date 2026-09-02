import { supabase } from "./supabase";

/* ============================================================================
   Bill photos.

   The bucket is private, so `proof_url` in the database is actually a STORAGE
   PATH ("company-id/random-name.jpg"), never a public URL — a signed link is
   minted on demand, valid for one hour, so a photo of someone's electricity
   bill is never sitting behind a link that works forever for anyone who has
   it.
   ========================================================================= */

const BUCKET = "bill-proofs";
const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPTED = ["image/jpeg", "image/png", "image/webp", "image/heic", "application/pdf"];

export function isAcceptedProofFile(file: File): boolean {
  return ACCEPTED.includes(file.type) && file.size <= MAX_BYTES;
}

/** Uploads the file and returns the storage PATH to save on the entry. */
export async function uploadBillProof(companyId: string, file: File): Promise<string> {
  if (!isAcceptedProofFile(file)) {
    throw new Error(
      file.size > MAX_BYTES
        ? "That file is larger than 10 MB. Try a smaller photo."
        : "Only photos (JPG, PNG, HEIC) or a PDF can be attached.",
    );
  }
  const ext = file.name.split(".").pop()?.toLowerCase() || "jpg";
  const path = `${companyId}/${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, file, {
    contentType: file.type,
    upsert: false,
  });
  if (error) throw error;
  return path;
}

/** A working link to view/download the file, valid for an hour. */
export async function billProofUrl(path: string): Promise<string> {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 3600);
  if (error) throw error;
  return data.signedUrl;
}

/** True for a path this uploader wrote ("company/uuid.ext"), false for an old free-typed URL. */
export function isStoredProofPath(value: string): boolean {
  return /^[0-9a-f-]{36}\/[^/]+$/i.test(value);
}
