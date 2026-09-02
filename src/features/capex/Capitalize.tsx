import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { capitalizeProject, listAccounts, type CapexProject } from "../../lib/queries";
import { fromPaise, inr, toPaise } from "../../lib/money";
import { Alert, Button, Field, inputClass, Sheet } from "../../components/ui";
import { errorMessage } from "../../lib/errors";

/* ============================================================================
   Turning finished work into an asset you own.

   THE MISTAKE THIS PREVENTS
   While a fit-out is under way, every rupee piles up in Capital Work in
   Progress. On the day it is finished and in use, that pile stops being "work
   under way" and becomes a real asset — and only then does it start
   depreciating. Until this entry is posted the balance sheet shows a building
   site rather than a kitchen, and depreciation that should have started has
   not.

   The app has warned about this on the CapEx screen since it was built, while
   providing no button. This is the button.
   ========================================================================= */
export function Capitalize({
  companyId,
  bookId,
  project,
  onClose,
}: {
  companyId: string;
  bookId: string;
  project: CapexProject;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const cwip = toPaise(project.cwip_balance);

  const [toAccount, setToAccount] = useState("");
  const [amount, setAmount] = useState(fromPaise(cwip));
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [life, setLife] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accountsQ = useQuery({
    queryKey: ["accounts", companyId],
    queryFn: () => listAccounts(companyId),
  });

  // Finished work becomes a FIXED ASSET, never an expense and never another
  // work-in-progress account. Offering anything else here would invite exactly
  // the misposting this screen exists to prevent.
  const targets = (accountsQ.data ?? []).filter(
    (a) => a.capex_role === "ppe" && a.is_active && !a.is_group,
  );

  let paise = 0;
  let valid = false;
  try {
    paise = toPaise(amount);
    valid = paise > 0 && paise <= cwip;
  } catch {
    valid = false;
  }

  async function go() {
    setBusy(true);
    setError(null);
    try {
      await capitalizeProject({
        capital_project_id: project.project_id,
        to_account_id: toAccount,
        event_date: date,
        amount: fromPaise(paise),
        useful_life_months: life ? Number(life) : undefined,
        book_id: bookId,
      });
      await qc.invalidateQueries();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const leftover = cwip - paise;

  return (
    <Sheet open onClose={onClose} labelledBy="capitalize-title">
      <div className="space-y-4 p-5">
        <h2 id="capitalize-title" className="text-lg font-bold text-navy">
          {project.name} is finished
        </h2>

        <Alert tone="info" title="What this does">
          {inr(cwip)} has built up as work in progress on this project. Recording it as finished
          moves that value into something you own, so it shows on your balance sheet as an asset
          rather than a building site — and starts wearing out as depreciation from this date.
        </Alert>

        {targets.length === 0 ? (
          <Alert tone="warn" title="No fixed-asset account to move it into">
            Finished work has to become something you own — furniture, equipment, a building. Add
            an account for it in the chart of accounts first, and mark it as a fixed asset.
          </Alert>
        ) : (
          <>
            <Field label="What has it become?" required>
              <select
                className={inputClass}
                value={toAccount}
                onChange={(e) => setToAccount(e.target.value)}
              >
                <option value="">Choose…</option>
                {targets.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} · {a.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              label="How much of it?"
              required
              hint={`${inr(cwip)} is available. Leave the full amount unless only part of the work is finished.`}
            >
              <div className="relative">
                <span className="absolute top-1/2 left-3 -translate-y-1/2 text-sm font-semibold text-muted">
                  ₹
                </span>
                <input
                  className={`${inputClass} pl-7 tnum`}
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </div>
            </Field>

            <Field label="Finished and in use from" required>
              <input
                type="date"
                className={inputClass}
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </Field>

            <Field
              label="Expected life in months (optional)"
              hint="Recorded for later. Depreciation is not calculated automatically yet."
            >
              <input
                className={`${inputClass} tnum`}
                inputMode="numeric"
                value={life}
                onChange={(e) => setLife(e.target.value.replace(/\D/g, "").slice(0, 4))}
                placeholder="e.g. 120 for ten years"
              />
            </Field>

            {valid && leftover > 0 && (
              <Alert tone="info">
                {inr(leftover)} will stay in work in progress, and the project stays open. Use this
                again when the rest is finished.
              </Alert>
            )}
            {amount.trim() !== "" && !valid && (
              <Alert tone="danger">
                Enter an amount between ₹0 and {inr(cwip)} — you cannot capitalise more than has
                actually been spent.
              </Alert>
            )}

            {error && <Alert tone="danger">{error}</Alert>}

            <div className="flex flex-wrap gap-2">
              <Button onClick={go} disabled={busy || !valid || !toAccount}>
                {busy ? "Recording…" : `Record ${inr(paise)} as an asset`}
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
