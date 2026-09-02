import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createAccount,
  listSubGroups,
  updateAccount,
  type Account,
  type NewAccount,
} from "../../lib/queries";
import { Alert, Button, Field, inputClass, Sheet } from "../../components/ui";
import { errorMessage } from "../../lib/errors";

/* ============================================================================
   Adding and editing an account.

   WHAT CANNOT BE CHANGED, AND WHY IT IS NOT A LIMITATION
   The code, the kind of account, and where it sits in the reports are fixed
   once created. Every report groups on those, so changing one on an account
   that already has history silently rewrites what last month's balance sheet
   said — with no entry anywhere to explain it. If an account is in the wrong
   place, the honest fix is a new account and a dated journal entry moving the
   balance across, which leaves a record a CA can follow.

   The name IS editable, because nothing anywhere keys off it.
   ========================================================================= */

const TYPES: [Account["account_type"], string][] = [
  ["asset", "Something you own"],
  ["liability", "Something you owe"],
  ["equity", "Owners' money in the business"],
  ["income", "Money you earn"],
  ["expense", "Money you spend"],
];

const CAPEX_ROLES: [string, string][] = [
  ["", "None"],
  ["cwip", "Work in progress"],
  ["capital_advance", "Capital advance"],
  ["deposit", "Deposit"],
  ["ppe", "Fixed asset"],
  ["accum_dep", "Accumulated depreciation"],
  ["capital", "Owners' capital"],
];

export function AccountEditor({
  companyId,
  accounts,
  editing,
  onClose,
}: {
  companyId: string;
  accounts: Account[];
  /** null = creating a new one */
  editing: Account | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const isNew = editing === null;

  const [name, setName] = useState(editing?.name ?? "");
  const [code, setCode] = useState("");
  const [type, setType] = useState<Account["account_type"]>(editing?.account_type ?? "expense");
  const [subGroup, setSubGroup] = useState(editing?.sub_group ?? "");
  const [capexRole, setCapexRole] = useState(editing?.capex_role ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The real list of report sections, not the ones this company happens to
  // have used. Deriving it from existing accounts meant an empty section could
  // never be chosen — a services business with no stock could not create its
  // first Inventory account, because it had no Inventory account to copy from.
  // The database now refuses any section outside this list, so the two agree.
  const sectionsQ = useQuery({
    queryKey: ["account-sub-groups"],
    queryFn: listSubGroups,
    staleTime: Infinity,
  });
  const subGroups = useMemo(
    () => (sectionsQ.data ?? []).filter((g) => g.account_type === type),
    [sectionsQ.data, type],
  );
  const chosenSection = subGroups.find((g) => g.key === subGroup);

  // Next free code in the band this kind of account lives in — so the owner
  // never has to know that assets start at 1 and expenses at 5.
  const suggestedCode = useMemo(() => {
    const band = { asset: "1", liability: "2", equity: "3", income: "4", expense: "5" }[type];
    const used = accounts
      .map((a) => a.code)
      .filter((c) => c.startsWith(band) && /^\d{4}$/.test(c))
      .map(Number);
    if (used.length === 0) return `${band}010`;
    return String(Math.max(...used) + 10);
  }, [accounts, type]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      if (isNew) {
        const payload: NewAccount = {
          company_id: companyId,
          code: (code || suggestedCode).trim(),
          name: name.trim(),
          account_type: type,
          sub_group: subGroup.trim(),
          capex_role: capexRole || null,
        };
        await createAccount(payload);
      } else {
        await updateAccount(editing!.id, {
          name: name.trim(),
          capex_role: capexRole || null,
        });
      }
      await qc.invalidateQueries({ queryKey: ["accounts", companyId] });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const ready = name.trim().length > 0 && (!isNew || subGroup.trim().length > 0);

  return (
    <Sheet open onClose={onClose} labelledBy="account-editor-title">
      <div className="space-y-4 p-5">
        <h2 id="account-editor-title" className="text-lg font-bold text-navy">
          {isNew ? "Add an account" : `Edit ${editing!.code} ${editing!.name}`}
        </h2>

        <Field label="What is it called?" required>
          <input
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Bank - HDFC Current"
            autoFocus
          />
        </Field>

        {isNew ? (
          <>
            <Field label="What kind of account?" required>
              <select
                className={inputClass}
                value={type}
                onChange={(e) => {
                  setType(e.target.value as Account["account_type"]);
                  setSubGroup("");
                }}
              >
                {TYPES.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              label="Where should it appear in the reports?"
              required
              hint={
                chosenSection?.hint ??
                "This decides which line of the balance sheet or profit and loss it lands on."
              }
            >
              <select
                className={inputClass}
                value={subGroup}
                onChange={(e) => setSubGroup(e.target.value)}
                disabled={sectionsQ.isLoading}
              >
                <option value="">Choose…</option>
                {subGroups.map((g) => (
                  <option key={g.key} value={g.key}>
                    {g.label}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              label="Code"
              hint={`Leave blank to use ${suggestedCode}. The number decides the order accounts are listed in.`}
            >
              <input
                className={`${inputClass} tnum`}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder={suggestedCode}
                inputMode="numeric"
              />
            </Field>
          </>
        ) : (
          <Alert tone="info" title="What cannot be changed here">
            The code ({editing!.code}), the kind of account, and where it sits in the reports stay
            as they are. Changing them on an account that already has entries would quietly change
            what your past reports said. To move a balance somewhere else, add the new account and
            record a journal entry — that way the move is on the record.
          </Alert>
        )}

        <Field
          label="Capital tracking (optional)"
          hint="Only matters if this account is part of building something — it drives the CapEx screen."
        >
          <select
            className={inputClass}
            value={capexRole}
            onChange={(e) => setCapexRole(e.target.value)}
          >
            {CAPEX_ROLES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>

        {error && <Alert tone="danger">{error}</Alert>}

        <div className="flex flex-wrap gap-2">
          <Button onClick={save} disabled={!ready || busy}>
            {busy ? "Saving…" : isNew ? "Add it" : "Save"}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

/* ----------------------------------------------------------------------------
   Switching an account off.

   Never a delete: `journal_lines.account_id` is ON DELETE RESTRICT, so history
   holds it in place — which is the correct behaviour, not an obstacle. And the
   server refuses to switch off an account that still holds a balance, because
   nothing could ever post to it again to clear it.
---------------------------------------------------------------------------- */
export function AccountRetire({
  companyId,
  account,
  onClose,
}: {
  companyId: string;
  account: Account;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const turningOff = account.is_active;

  async function go() {
    setBusy(true);
    setError(null);
    try {
      await updateAccount(account.id, { is_active: !account.is_active });
      await qc.invalidateQueries({ queryKey: ["accounts", companyId] });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open onClose={onClose} labelledBy="account-retire-title">
      <div className="space-y-4 p-5">
        <h2 id="account-retire-title" className="text-lg font-bold text-navy">
          {turningOff ? "Switch off" : "Switch back on"} {account.code} {account.name}
        </h2>

        {turningOff ? (
          <Alert tone="info" title="What this does">
            It stops appearing when you record anything new. Everything already recorded against it
            stays exactly where it is, and it keeps showing in your reports and its own ledger —
            switching off is about tidying the list you pick from, not hiding history.
            <br />
            <br />
            If it still holds a balance, this will be refused: nothing could post to it afterwards
            to clear that balance. Move the balance across with a journal entry first.
          </Alert>
        ) : (
          <Alert tone="info">It will be offered again when you record something.</Alert>
        )}

        {error && <Alert tone="danger">{error}</Alert>}

        <div className="flex flex-wrap gap-2">
          <Button variant={turningOff ? "danger" : "primary"} onClick={go} disabled={busy}>
            {busy ? "Working…" : turningOff ? "Switch it off" : "Switch it back on"}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
