import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { updateInvestor, type InvestorRow } from "../../lib/queries";
import { fromPaise, toPaise } from "../../lib/money";
import { Alert, Button, Field, inputClass, Sheet } from "../../components/ui";
import { errorMessage } from "../../lib/errors";

/* ============================================================================
   Correcting an investor's agreed terms.

   The agreed share is the single most likely thing to be typed wrong at setup
   and noticed months later — and until now there was no way to fix it without
   going into the database. It is also the number most likely to cause an
   argument between partners, which is precisely why it is fixed by agreement
   and never recalculated from who happened to fund fastest.

   Renaming here renames the person everywhere they appear: their party record
   and their own capital account, so the books do not end up with a "Capital -
   Anand" account belonging to someone now called something else.
   ========================================================================= */
export function InvestorEditor({
  row,
  onClose,
}: {
  row: InvestorRow;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(row.name);
  const [pct, setPct] = useState(Number(row.agreed_share_pct).toString());
  const [committed, setCommitted] = useState(fromPaise(toPaise(row.committed)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pctNum = Number(pct);
  const pctValid = pct.trim() !== "" && !Number.isNaN(pctNum) && pctNum >= 0 && pctNum <= 100;

  let committedValid = false;
  try {
    committedValid = toPaise(committed) >= 0;
  } catch {
    committedValid = false;
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await updateInvestor(row.investor_id, {
        display_name: name.trim(),
        agreed_share_pct: pct.trim(),
        committed_amount: fromPaise(toPaise(committed)),
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
    <Sheet open onClose={onClose} labelledBy="investor-editor-title">
      <div className="space-y-4 p-5">
        <h2 id="investor-editor-title" className="text-lg font-bold text-navy">
          {row.name}
        </h2>

        <Field label="Name" required>
          <input
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </Field>

        <Field
          label="Agreed share"
          required
          hint="Fixed by your agreement. It is never worked out from who has paid in most so far — that is how partners end up arguing."
        >
          <div className="relative">
            <input
              className={`${inputClass} pr-8 tnum`}
              inputMode="decimal"
              value={pct}
              onChange={(e) => setPct(e.target.value)}
            />
            <span className="absolute top-1/2 right-3 -translate-y-1/2 text-sm font-semibold text-muted">
              %
            </span>
          </div>
        </Field>

        <Field
          label="Committed amount"
          required
          hint="What they agreed to bring in altogether."
        >
          <div className="relative">
            <span className="absolute top-1/2 left-3 -translate-y-1/2 text-sm font-semibold text-muted">
              ₹
            </span>
            <input
              className={`${inputClass} pl-7 tnum`}
              inputMode="decimal"
              value={committed}
              onChange={(e) => setCommitted(e.target.value)}
            />
          </div>
        </Field>

        <Alert tone="info">
          Changing these does not touch a single entry. What they have actually paid in is worked
          out from the ledger and cannot be edited here — only what they agreed to.
        </Alert>

        {!pctValid && pct.trim() !== "" && (
          <Alert tone="danger">A share has to be between 0 and 100 percent.</Alert>
        )}

        {error && <Alert tone="danger">{error}</Alert>}

        <div className="flex flex-wrap gap-2">
          <Button onClick={save} disabled={busy || !name.trim() || !pctValid || !committedValid}>
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
