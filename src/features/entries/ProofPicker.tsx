import { useState } from "react";
import { Field, inputClass } from "../../components/ui";
import { uploadBillProof } from "../../lib/billProof";
import { errorMessage } from "../../lib/errors";

/* ============================================================================
   Attach a photo of the bill.

   Lifted out of BillEntry, which was the only screen that could fill
   `proof_url` — so of 65 posted entries, exactly zero had a document attached.
   Anything that records money spent should be able to carry its evidence, and
   one shared picker means the upload rules (size, type, private bucket, the
   fact that `proof_url` holds a storage PATH and never a public link) are
   stated once instead of drifting between copies.
   ========================================================================= */

export function ProofPicker({
  companyId,
  value,
  onChange,
  label = "Photo of the bill",
  hint = "An investor or your CA will ask for this. Take a photo, or pick one from your files.",
}: {
  companyId: string | undefined;
  /** Storage path, or a pasted link. Empty string when nothing is attached. */
  value: string;
  onChange: (v: string) => void;
  label?: string;
  hint?: string;
}) {
  const [fileName, setFileName] = useState("");
  const [mode, setMode] = useState<"pick" | "file" | "link">("pick");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Field label={label} hint={hint}>
      {mode === "file" && fileName ? (
        <div className="flex items-center justify-between gap-2 rounded-xl border border-ok/30 bg-okbg px-3 py-2">
          <span className="truncate text-sm font-semibold text-ok">✓ {fileName}</span>
          <button
            type="button"
            onClick={() => {
              onChange("");
              setFileName("");
              setMode("pick");
            }}
            className="shrink-0 text-xs font-bold text-danger hover:underline"
          >
            Remove
          </button>
        </div>
      ) : mode === "link" ? (
        <input
          className={inputClass}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="https://drive.google.com/…"
          autoFocus
        />
      ) : (
        <label className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-line px-3 py-3 text-sm font-semibold text-navy hover:bg-canvas">
          {uploading ? "Uploading…" : "📷 Attach a photo or PDF"}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp,image/heic,application/pdf"
            className="hidden"
            disabled={uploading || !companyId}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file || !companyId) return;
              setUploading(true);
              setError(null);
              try {
                const path = await uploadBillProof(companyId, file);
                onChange(path);
                setFileName(file.name);
                setMode("file");
              } catch (err) {
                setError(errorMessage(err));
              } finally {
                setUploading(false);
              }
            }}
          />
        </label>
      )}
      {error && <p className="mt-1.5 text-xs font-semibold text-danger">{error}</p>}
      {mode === "pick" && (
        <p className="mt-1.5 text-xs text-muted">
          Already have it in Drive?{" "}
          <button
            type="button"
            onClick={() => setMode("link")}
            className="font-semibold text-navy underline underline-offset-2"
          >
            Paste a link instead
          </button>
        </p>
      )}
    </Field>
  );
}
