import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  listPartyDetails,
  mergeParties,
  updateParty,
  type PartyDetail,
} from "../../lib/queries";
import { Alert, Button, Field, inputClass, Sheet } from "../../components/ui";
import { errorMessage } from "../../lib/errors";

const TYPES: [string, string][] = [
  ["", "Not set"],
  ["vendor", "Supplier"],
  ["customer", "Customer"],
  ["investor", "Investor"],
  ["staff", "Staff"],
  ["other", "Other"],
];

/* ============================================================================
   Editing one party.

   GSTIN is the reason this screen matters more than it looks. The column has
   existed since the first migration and nothing could ever fill it in — and
   input credit cannot be claimed without the supplier's GSTIN on record. That
   is a compliance gap, not a missing nicety.
   ========================================================================= */
export function PartyEditor({
  party,
  onClose,
}: {
  party: PartyDetail;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [f, setF] = useState<PartyDetail>(party);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof PartyDetail>(k: K, v: PartyDetail[K]) =>
    setF((p) => ({ ...p, [k]: v }));

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await updateParty(party.id, {
        name: f.name.trim(),
        party_type: f.party_type,
        gstin: f.gstin,
        pan: f.pan,
        phone: f.phone,
        email: f.email,
        notes: f.notes,
        is_related_party: f.is_related_party,
        is_active: f.is_active,
      });
      await qc.invalidateQueries();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open onClose={onClose} labelledBy="party-editor-title">
      <div className="space-y-4 p-5">
        <h2 id="party-editor-title" className="text-lg font-bold text-navy">
          {party.name}
        </h2>

        <Field label="Name" required>
          <input
            className={inputClass}
            value={f.name}
            onChange={(e) => set("name", e.target.value)}
            autoFocus
          />
        </Field>

        <Field label="What are they to you?">
          <select
            className={inputClass}
            value={f.party_type ?? ""}
            onChange={(e) => set("party_type", e.target.value || null)}
          >
            {TYPES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="GSTIN"
            hint="Needed to claim input credit on their bills."
          >
            <input
              className={`${inputClass} uppercase`}
              value={f.gstin ?? ""}
              onChange={(e) => set("gstin", e.target.value.toUpperCase() || null)}
              placeholder="33AAAAA0000A1Z5"
              maxLength={15}
            />
          </Field>
          <Field label="PAN">
            <input
              className={`${inputClass} uppercase`}
              value={f.pan ?? ""}
              onChange={(e) => set("pan", e.target.value.toUpperCase() || null)}
              maxLength={10}
            />
          </Field>
          <Field label="Phone">
            <input
              className={inputClass}
              value={f.phone ?? ""}
              onChange={(e) => set("phone", e.target.value || null)}
              inputMode="tel"
            />
          </Field>
          <Field label="Email">
            <input
              className={inputClass}
              type="email"
              value={f.email ?? ""}
              onChange={(e) => set("email", e.target.value || null)}
            />
          </Field>
        </div>

        <Field label="Notes">
          <input
            className={inputClass}
            value={f.notes ?? ""}
            onChange={(e) => set("notes", e.target.value || null)}
            placeholder="Anything worth remembering about them"
          />
        </Field>

        <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-line p-3">
          <input
            type="checkbox"
            checked={f.is_related_party}
            onChange={(e) => set("is_related_party", e.target.checked)}
            className="mt-0.5"
          />
          <span>
            <span className="block text-sm font-semibold text-ink">This is a related party</span>
            <span className="mt-0.5 block text-xs text-muted">
              Another business you or a partner control, a director, or a close relative. Your CA
              has to disclose these separately, so flagging them now saves an awkward question at
              year end.
            </span>
          </span>
        </label>

        <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-line p-3">
          <input
            type="checkbox"
            checked={!f.is_active}
            onChange={(e) => set("is_active", !e.target.checked)}
            className="mt-0.5"
          />
          <span>
            <span className="block text-sm font-semibold text-ink">
              No longer deal with them
            </span>
            <span className="mt-0.5 block text-xs text-muted">
              Keeps them out of the name suggestions. Everything already recorded against them
              stays exactly as it is.
            </span>
          </span>
        </label>

        {error && <Alert tone="danger">{error}</Alert>}

        <div className="flex flex-wrap gap-2">
          <Button onClick={save} disabled={busy || !f.name.trim()}>
            {busy ? "Saving…" : "Save"}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

/* ============================================================================
   Merging two names that are the same person.

   "Meridian", "Meridian Furniture" and "meridian furnitures" are one
   supplier typed three ways, and until they are one record their balance is
   split three ways and none of the three is the truth.

   Safe against the audit trail: the tamper-evident hash covers the accounts
   and amounts on each line, never who the line is about. Re-tagging changes no
   hash — proven by test, not assumed.
   ========================================================================= */
export function PartyMerge({
  companyId,
  initial,
  onClose,
}: {
  companyId: string;
  initial?: PartyDetail | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [keepId, setKeepId] = useState(initial?.id ?? "");
  const [mergeId, setMergeId] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["party-details", companyId],
    queryFn: () => listPartyDetails(companyId),
  });
  const parties = useMemo(() => q.data ?? [], [q.data]);
  const keep = parties.find((p) => p.id === keepId);
  const loser = parties.find((p) => p.id === mergeId);

  async function go() {
    setBusy(true);
    setError(null);
    try {
      const r = await mergeParties(companyId, keepId, mergeId, reason.trim() || undefined);
      await qc.invalidateQueries();
      setDone(
        `Done. ${r.entries_moved} ${r.entries_moved === 1 ? "entry" : "entries"} and ${
          r.lines_moved
        } ${r.lines_moved === 1 ? "line" : "lines"} now point at ${keep?.name}.`,
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open onClose={onClose} labelledBy="party-merge-title">
      <div className="space-y-4 p-5">
        <h2 id="party-merge-title" className="text-lg font-bold text-navy">
          Merge two names
        </h2>

        {done ? (
          <>
            <Alert tone="ok" title="Merged">
              {done}
            </Alert>
            <Button onClick={onClose}>Close</Button>
          </>
        ) : (
          <>
            <p className="text-sm text-muted">
              Use this when the same person or business was typed twice. Everything recorded
              against the one you drop moves across, so their balance becomes one number instead
              of two.
            </p>

            <Field label="Keep this one" required>
              <select
                className={inputClass}
                value={keepId}
                onChange={(e) => setKeepId(e.target.value)}
              >
                <option value="">Choose…</option>
                {parties.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Fold this one into it" required>
              <select
                className={inputClass}
                value={mergeId}
                onChange={(e) => setMergeId(e.target.value)}
              >
                <option value="">Choose…</option>
                {parties
                  .filter((p) => p.id !== keepId)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </Field>

            <Field label="Why? (optional)" hint="Goes on the record with the merge.">
              <input
                className={inputClass}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. same supplier, entered twice"
              />
            </Field>

            {keep && loser && (
              <Alert tone="warn" title="What will happen">
                Every entry tagged <strong>{loser.name}</strong> will be re-tagged{" "}
                <strong>{keep.name}</strong>, and <strong>{loser.name}</strong> will be removed
                from your list. No amount, account or date changes, and your audit trail stays
                intact. This cannot be undone from here — but nothing is lost, so you can merge
                the other way if you pick the wrong one.
              </Alert>
            )}

            {error && <Alert tone="danger">{error}</Alert>}

            <div className="flex flex-wrap gap-2">
              <Button onClick={go} disabled={busy || !keepId || !mergeId}>
                {busy ? "Merging…" : "Merge them"}
              </Button>
              <Button variant="secondary" onClick={onClose}>
                Cancel
              </Button>
            </div>
          </>
        )}
      </div>
    </Sheet>
  );
}
