import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  applyChartTemplate,
  listChartTemplates,
  templateAccounts,
  type Account,
} from "../../lib/queries";
import { Alert, Button, Field, inputClass, Sheet } from "../../components/ui";
import { errorMessage } from "../../lib/errors";

/* ============================================================================
   Pulling in another trade's accounts, after the company already exists.

   A café that starts selling packaged goods, a consultant who begins holding
   stock — the business changes, and the chart has to be able to follow without
   starting again.

   WHAT THIS DOES NOT DO, DELIBERATELY
   It never renames or removes an account you already have. If your "4010" is
   called "Sales - Counter" and the restaurant template calls 4010 "Sales -
   Food (Dine-in)", yours is left alone: every entry already posted to that
   account would otherwise silently start reading as something else. Anything
   whose code OR name you already use is skipped, and you are told how many
   were actually added.
   ========================================================================= */

export function AdoptTemplate({
  companyId,
  accounts,
  currentIndustry,
  onClose,
}: {
  companyId: string;
  accounts: Account[];
  currentIndustry: string | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [template, setTemplate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<number | null>(null);

  const templatesQ = useQuery({
    queryKey: ["chart-templates"],
    queryFn: listChartTemplates,
    staleTime: Infinity,
  });
  const previewQ = useQuery({
    queryKey: ["chart-template-accounts", template],
    queryFn: () => templateAccounts(template),
    enabled: template !== "",
    staleTime: Infinity,
  });

  const haveCodes = new Set(accounts.map((a) => a.code));
  const haveNames = new Set(accounts.map((a) => a.name.trim().toLowerCase()));
  // The same test the database applies, so the preview and the result agree.
  const wouldAdd = (previewQ.data ?? []).filter(
    (a) => !haveCodes.has(a.code) && !haveNames.has(a.name.trim().toLowerCase()),
  );

  async function go() {
    setBusy(true);
    setError(null);
    try {
      const n = await applyChartTemplate(companyId, template);
      await qc.invalidateQueries({ queryKey: ["accounts", companyId] });
      setAdded(n);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open onClose={onClose} labelledBy="adopt-template-title">
      <div className="space-y-4 p-5">
        <h2 id="adopt-template-title" className="text-lg font-bold text-navy">
          Add another trade's accounts
        </h2>

        {added === null ? (
          <>
            <Alert tone="info" title="Nothing you already have is touched">
              Only accounts you do not have yet are added. Anything whose code or name you already
              use is left exactly as it is — renaming an account would change what every entry
              already posted to it appears to say.
            </Alert>

            <Field
              label="Which trade?"
              hint={
                currentIndustry
                  ? `This company was set up from the "${
                      templatesQ.data?.find((t) => t.key === currentIndustry)?.name ??
                      currentIndustry
                    }" chart.`
                  : undefined
              }
            >
              <select
                className={inputClass}
                value={template}
                onChange={(e) => {
                  setTemplate(e.target.value);
                  setError(null);
                }}
              >
                <option value="">Choose…</option>
                {(templatesQ.data ?? [])
                  .filter((t) => !t.is_base)
                  .map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.name}
                    </option>
                  ))}
              </select>
            </Field>

            {template !== "" && previewQ.data && (
              <div className="rounded-xl border border-line p-3">
                {wouldAdd.length === 0 ? (
                  <p className="text-sm text-muted">
                    You already have everything this chart would add. Nothing to do.
                  </p>
                ) : (
                  <>
                    <p className="text-sm font-semibold text-ink">
                      {wouldAdd.length} account{wouldAdd.length === 1 ? "" : "s"} would be added
                    </p>
                    <ul className="mt-2 space-y-1">
                      {wouldAdd.map((a) => (
                        <li key={a.code} className="text-xs text-muted">
                          <span className="tnum font-semibold text-ink">{a.code}</span> {a.name}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}

            {error && <Alert tone="danger">{error}</Alert>}

            <div className="flex flex-wrap gap-2">
              <Button onClick={go} disabled={busy || template === "" || wouldAdd.length === 0}>
                {busy ? "Adding…" : `Add ${wouldAdd.length || ""} account${wouldAdd.length === 1 ? "" : "s"}`.trim()}
              </Button>
              <Button variant="secondary" onClick={onClose}>
                Cancel
              </Button>
            </div>
          </>
        ) : (
          <>
            <Alert tone="ok" title={`${added} account${added === 1 ? "" : "s"} added`}>
              They are in your chart now and will be offered the next time you record something.
              The change is on the master data log with your name against it.
            </Alert>
            <Button onClick={onClose}>Done</Button>
          </>
        )}
      </div>
    </Sheet>
  );
}
