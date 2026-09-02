import { useState } from "react";
import { InvestorEditor } from "./InvestorEditor";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../company/CompanyProvider";
import {
  addInvestor,
  investorMaster,
  investorShareCheck,
  listAccounts,
  recordInvestment,
  reclassifyInvestment,
  type InvestorRow,
} from "../../lib/queries";
import { inr, toPaise, fromPaise } from "../../lib/money";
import { moneyAccountsForBook } from "../../lib/recipes";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  inputClass,
  SectionTitle,
  Skeleton,
} from "../../components/ui";
import { errorMessage } from "../../lib/errors";

const today = () => new Date().toISOString().slice(0, 10);
const fmt = (iso: string | null) =>
  iso
    ? new Date(iso + "T00:00:00").toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "2-digit",
      })
    : "—";

/**
 * The investor master summary.
 *
 * Two books mean every investor has four figures, not one. They are shown
 * separately and never blended: showing only the statutory number misleads the
 * investor, and showing only the total misleads the accountant.
 *
 * Share % is what was AGREED, fixed at setup. It is deliberately not
 * recalculated from contributions — otherwise whoever funds fastest would
 * appear to own more, which is how partner disputes start.
 */
export function Investors() {
  const { company, can } = useCompany();
  const [adding, setAdding] = useState(false);
  const [fundingFor, setFundingFor] = useState<InvestorRow | null>(null);
  const [editing, setEditing] = useState<InvestorRow | null>(null);

  const q = useQuery({
    queryKey: ["investor-master", company?.id],
    queryFn: () => investorMaster(company!.id),
    enabled: !!company,
  });
  // Do the agreed shares add up? Reported, never enforced — shares legitimately
  // sit below 100% while partners are still being brought in, and refusing to
  // save a 60% position would only stop people recording what is true today.
  const shareQ = useQuery({
    queryKey: ["investor-shares", company?.id],
    queryFn: () => investorShareCheck(company!.id),
    enabled: !!company,
  });

  if (!company) return <p className="text-sm text-muted">Create a company first.</p>;

  const rows = q.data ?? [];
  const t = (k: keyof InvestorRow) =>
    rows.reduce((n, r) => n + toPaise(String(r[k] ?? "0")), 0);

  const committed = t("committed");
  const totalIn = t("total_in");
  const pending = t("pending");
  const outside = t("outside_books");
  const stillToBring = t("still_to_bring");
  const funded = committed > 0 ? Math.round((totalIn / committed) * 100) : 0;

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-extrabold text-navy">Investors</h1>
          <p className="mt-0.5 text-sm text-muted">
            What each investor agreed to put in, what has arrived, and what is still to come.
          </p>
        </div>
        {can("manage_members") && (
          <Button variant={rows.length ? "secondary" : "primary"} onClick={() => setAdding((v) => !v)}>
            {adding ? "Cancel" : "+ Add investor"}
          </Button>
        )}
      </div>

      {adding && (
        <AddInvestor
          companyId={company.id}
          target={toPaise(String(company.target_investment ?? "0"))}
          onDone={() => setAdding(false)}
        />
      )}

      {q.isLoading ? (
        <Skeleton rows={6} />
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            icon="◈"
            title="No investors yet"
            body="Add each investor with the share they agreed. Their commitment is worked out from your project target, and everything they put in — through the company or outside it — is tracked against it."
            action={
              can("manage_members") ? (
                <Button onClick={() => setAdding(true)}>Add the first investor</Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <>
          {/* ---- the project position, at a glance ---- */}
          <Card className="p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-sm font-bold text-ink">Total committed by all investors</span>
              <span className="text-2xl font-extrabold text-navy tnum">{inr(committed)}</span>
            </div>
            <div className="mt-3 h-3 w-full overflow-hidden rounded-full bg-line">
              <div className="h-full bg-navy" style={{ width: `${Math.min(100, funded)}%` }} />
            </div>
            <div className="mt-2 flex flex-wrap justify-between gap-3 text-xs">
              <span className="text-muted">
                Received so far <strong className="text-ink tnum">{inr(totalIn)}</strong> ({funded}%)
              </span>
              <span className="text-muted">
                Still to come <strong className="text-ink tnum">{inr(stillToBring)}</strong>
              </span>
            </div>
          </Card>

          {pending > 0 && (
            <Alert tone="warn" title="Money received but not yet classified">
              {inr(pending)} has come in without anyone deciding whether it is share capital or
              money the company must repay. It counts towards what the investor has put in, but
              your CA will need it settled. Open the investor below and choose.
            </Alert>
          )}

          {outside > 0 && (
            <Alert tone="info" title="Some funding never passed through the company">
              {inr(outside)} was paid directly by investors and sits only in the internal book. It
              is real money they contributed, but it will not appear in the statutory accounts —
              so the legal position and the fair position differ by that amount.
            </Alert>
          )}

          {shareQ.data && shareQ.data.status !== "ok" && shareQ.data.status !== "none" && (
            <Alert
              tone={shareQ.data.status === "over" ? "warn" : "info"}
              title={
                shareQ.data.status === "over"
                  ? "The agreed shares add up to more than 100%"
                  : "The agreed shares do not add up to 100% yet"
              }
            >
              {shareQ.data.message}
            </Alert>
          )}

          {editing && (
            <InvestorEditor row={editing} onClose={() => setEditing(null)} />
          )}

          <section>
            <SectionTitle>Each investor</SectionTitle>
            <div className="space-y-2">
              {rows.map((r) => (
                <InvestorCard
                  key={r.investor_id}
                  row={r}
                  onFund={() => setFundingFor(r)}
                  onEdit={can("manage_members") ? () => setEditing(r) : undefined}
                  canPost={can("post_entry")}
                  companyId={company.id}
                />
              ))}
            </div>
          </section>

          {/* ---- totals, so the summary reconciles on screen ---- */}
          {/* The per-investor cards above already carry these figures on a
              phone; this reconciliation grid is a desktop affordance. */}
          <Card className="hidden overflow-hidden md:block">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[46rem] text-sm">
                <thead>
                  <tr className="border-b border-line bg-canvas text-xs tracking-wide text-muted uppercase">
                    <th className="px-3 py-2 text-left font-bold">Investor</th>
                    <th className="px-3 py-2 text-right font-bold">Share</th>
                    <th className="px-3 py-2 text-right font-bold">Committed</th>
                    <th className="px-3 py-2 text-right font-bold">Official books</th>
                    <th className="px-3 py-2 text-right font-bold">Outside</th>
                    <th className="px-3 py-2 text-right font-bold">Total in</th>
                    <th className="px-3 py-2 text-right font-bold">Still to bring</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.investor_id} className="border-b border-line last:border-0">
                      <td className="px-3 py-2 font-semibold">{r.name}</td>
                      <td className="px-3 py-2 text-right tnum">
                        {Number(r.agreed_share_pct).toFixed(2)}%
                      </td>
                      <td className="px-3 py-2 text-right tnum">{inr(toPaise(r.committed))}</td>
                      <td className="px-3 py-2 text-right tnum">
                        {inr(toPaise(r.statutory_total))}
                      </td>
                      <td className="px-3 py-2 text-right tnum">
                        {toPaise(r.outside_books) ? inr(toPaise(r.outside_books)) : "—"}
                      </td>
                      <td className="px-3 py-2 text-right font-bold tnum">
                        {inr(toPaise(r.total_in))}
                      </td>
                      <td className="px-3 py-2 text-right tnum text-muted">
                        {inr(toPaise(r.still_to_bring))}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-navy bg-canvas font-bold text-navy">
                    <td className="px-3 py-2">Total</td>
                    <td className="px-3 py-2 text-right tnum">
                      {rows.reduce((n, r) => n + Number(r.agreed_share_pct), 0).toFixed(2)}%
                    </td>
                    <td className="px-3 py-2 text-right tnum">{inr(committed)}</td>
                    <td className="px-3 py-2 text-right tnum">{inr(t("statutory_total"))}</td>
                    <td className="px-3 py-2 text-right tnum">{inr(outside)}</td>
                    <td className="px-3 py-2 text-right tnum">{inr(totalIn)}</td>
                    <td className="px-3 py-2 text-right tnum">{inr(stillToBring)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </Card>
        </>
      )}

      {fundingFor && (
        <RecordFunding
          row={fundingFor}
          companyId={company.id}
          onDone={() => setFundingFor(null)}
        />
      )}
    </div>
  );
}

function InvestorCard({
  row,
  onFund,
  onEdit,
  canPost,
  companyId,
}: {
  row: InvestorRow;
  onFund: () => void;
  /** undefined when this role may not change agreed terms */
  onEdit?: () => void;
  canPost: boolean;
  companyId: string;
}) {
  const [open, setOpen] = useState(false);
  const pct = Number(row.pct_funded);
  const pending = toPaise(row.pending);

  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full p-4 text-left transition-colors duration-200 hover:bg-canvas"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-bold text-ink">{row.name}</span>
            <Badge tone="gold">{Number(row.agreed_share_pct).toFixed(0)}%</Badge>
            {pending > 0 && <Badge tone="warn">{inr(pending)} unclassified</Badge>}
            {toPaise(row.outside_books) > 0 && <Badge tone="info">has outside funding</Badge>}
          </span>
          <span className="text-sm font-bold text-navy tnum">
            {inr(toPaise(row.total_in))}
            <span className="font-normal text-muted"> of {inr(toPaise(row.committed))}</span>
          </span>
        </div>
        <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-line">
          <div
            className={`h-full ${pct >= 100 ? "bg-ok" : "bg-navy"}`}
            style={{ width: `${Math.min(100, pct)}%` }}
          />
        </div>
        <p className="mt-1.5 text-xs text-muted">
          {pct.toFixed(1)}% funded · {inr(toPaise(row.still_to_bring))} still to bring
          {row.last_received && ` · last received ${fmt(row.last_received)}`}
        </p>
      </button>

      {open && (
        <div className="border-t border-line p-4">
          {onEdit && (
            <button
              type="button"
              onClick={onEdit}
              className="mb-3 text-xs font-semibold text-navy hover:underline"
            >
              Correct their agreed share or commitment
            </button>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Bucket
              label="Share capital"
              value={toPaise(row.share_capital)}
              note="In the official books as share capital"
            />
            <Bucket
              label="Funding to be repaid"
              value={toPaise(row.investor_loan)}
              note="In the official books, the company owes this back"
            />
            <Bucket
              label="Not yet classified"
              value={pending}
              note="Received, but nobody has decided what it is yet"
              tone={pending > 0 ? "warn" : undefined}
            />
            <Bucket
              label="Paid outside the company"
              value={toPaise(row.outside_books)}
              note="Internal book only — never reached the company bank"
            />
          </div>

          {pending > 0 && canPost && (
            <Reclassify row={row} companyId={companyId} />
          )}

          {canPost && (
            <Button variant="secondary" className="mt-3" onClick={onFund}>
              Record money from {row.name}
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

function Bucket({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: number;
  note: string;
  tone?: "warn";
}) {
  return (
    <div className={`rounded-xl border p-3 ${tone === "warn" ? "border-warn/40 bg-warnbg" : "border-line"}`}>
      <p className="text-xs font-bold tracking-wide text-muted uppercase">{label}</p>
      <p className="mt-0.5 text-lg font-extrabold text-navy tnum">{inr(value)}</p>
      <p className="mt-0.5 text-xs text-muted">{note}</p>
    </div>
  );
}

function Reclassify({ row, companyId }: { row: InvestorRow; companyId: string }) {
  const qc = useQueryClient();
  const pending = toPaise(row.pending);
  const [amount, setAmount] = useState(fromPaise(pending));
  const [to, setTo] = useState<"share_capital" | "investor_loan">("investor_loan");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="mt-3 rounded-xl border border-warn/40 bg-warnbg p-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await reclassifyInvestment({
            company_id: companyId,
            investor_id: row.investor_id,
            from_kind: "pending",
            to_kind: to,
            amount,
          });
          await qc.invalidateQueries();
        } catch (err) {
          setError(errorMessage(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="mb-2 text-sm font-bold text-ink">Decide what this money is</p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-36">
          <Field label="Amount">
            <input
              className={`${inputClass} text-right tnum`}
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>
        </div>
        <div className="min-w-[12rem] flex-1">
          <Field label="Treat it as">
            <select
              className={inputClass}
              value={to}
              onChange={(e) => setTo(e.target.value as typeof to)}
            >
              <option value="investor_loan">Money the company must repay</option>
              <option value="share_capital">Share capital</option>
            </select>
          </Field>
        </div>
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Apply"}
        </Button>
      </div>
      {error && (
        <div className="mt-2">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
      <p className="mt-2 text-xs text-muted">
        This records a dated journal entry, so the audit trail shows exactly when and why the
        classification changed.
      </p>
    </form>
  );
}

function AddInvestor({
  companyId,
  target,
  onDone,
}: {
  companyId: string;
  target: number;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [pct, setPct] = useState("");
  const [amt, setAmt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // percentage and amount each fill the other in
  function onPct(v: string) {
    setPct(v);
    const n = Number(v);
    if (target > 0 && !Number.isNaN(n) && v !== "") setAmt(fromPaise(Math.round((target * n) / 100)));
  }
  function onAmt(v: string) {
    setAmt(v);
    try {
      const p = toPaise(v);
      if (target > 0) setPct(((p / target) * 100).toFixed(2));
    } catch {
      /* partial input */
    }
  }

  return (
    <Card className="p-5">
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await addInvestor({
              company_id: companyId,
              name: name.trim(),
              agreed_share_pct: pct || undefined,
              committed_amount: amt || undefined,
            });
            await qc.invalidateQueries();
            onDone();
          } catch (err) {
            setError(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Investor name" required>
          <input
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Anand"
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Agreed share %" hint="What was agreed between the partners">
            <input
              className={`${inputClass} text-right tnum`}
              inputMode="decimal"
              value={pct}
              onChange={(e) => onPct(e.target.value)}
              placeholder="20"
            />
          </Field>
          <Field
            label="Amount they will put in"
            hint={target > 0 ? `Worked out from your ${inr(target)} project target` : "Set a project target in Settings to link these"}
          >
            <input
              className={`${inputClass} text-right tnum`}
              inputMode="decimal"
              value={amt}
              onChange={(e) => onAmt(e.target.value)}
              placeholder="0.00"
            />
          </Field>
        </div>
        <p className="text-xs text-muted">
          This creates a capital account in their own name, so each partner appears separately on
          the balance sheet — which is what your CA will expect.
        </p>
        {error && <Alert tone="danger">{error}</Alert>}
        <Button type="submit" disabled={busy || !name.trim()}>
          {busy ? "Adding…" : "Add investor"}
        </Button>
      </form>
    </Card>
  );
}

function RecordFunding({
  row,
  companyId,
  onDone,
}: {
  row: InvestorRow;
  companyId: string;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const { activeBookId, internalMode } = useCompany();
  const [amount, setAmount] = useState("");
  const [kind, setKind] = useState<"investor_loan" | "share_capital" | "pending">("investor_loan");
  const [account, setAccount] = useState("");
  const [date, setDate] = useState(today());
  const [mode, setMode] = useState("bank_transfer");
  const [ref, setRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accountsQ = useQuery({
    queryKey: ["accounts", companyId],
    queryFn: () => listAccounts(companyId),
  });
  // Only accounts legal for the book this receipt lands in — see BillEntry.
  const money = moneyAccountsForBook(accountsQ.data ?? [], activeBookId, internalMode);

  let paise = 0;
  try {
    paise = toPaise(amount);
  } catch {
    paise = 0;
  }
  const ready = paise > 0 && !!account;

  const KINDS = [
    ["investor_loan", "Money the company must repay", "The usual choice when it is above the registered share capital"],
    ["share_capital", "Share capital", "Only up to the authorised capital in your legal documents"],
    ["pending", "Just record it for now", "Decide later — it will be flagged until you do"],
  ] as const;

  return (
    <Card className="p-5">
      <SectionTitle>Money from {row.name}</SectionTitle>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!ready) return;
          setBusy(true);
          setError(null);
          try {
            await recordInvestment({
              company_id: companyId,
              investor_id: row.investor_id,
              kind,
              amount,
              money_account_id: account,
              date,
              mode,
              reference: ref || undefined,
            });
            await qc.invalidateQueries();
            onDone();
          } catch (err) {
            setError(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="How much?" required>
            <input
              className={`${inputClass} text-right text-lg font-bold tnum`}
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              autoFocus
            />
          </Field>
          <Field label="Arrived where?" required>
            <select className={inputClass} value={account} onChange={(e) => setAccount(e.target.value)}>
              <option value="">Choose…</option>
              {money.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div>
          <span className="mb-1.5 block text-sm font-semibold text-ink">What is this money?</span>
          <div className="space-y-2">
            {KINDS.map(([v, label, hint]) => (
              <button
                key={v}
                type="button"
                onClick={() => setKind(v)}
                aria-pressed={kind === v}
                className={`block w-full rounded-xl border p-3 text-left transition-colors duration-200 active:scale-[0.99] ${
                  kind === v ? "border-navy bg-navy/5" : "border-line bg-card hover:bg-canvas"
                }`}
              >
                <span className="flex items-center gap-2">
                  <span className="text-sm font-bold text-ink">{label}</span>
                  {v === "investor_loan" && <Badge>default</Badge>}
                </span>
                <span className="mt-0.5 block text-xs text-muted">{hint}</span>
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted">
            You can change this later — it is recorded as a dated entry, not a hidden setting.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="When?">
            <input type="date" className={inputClass} value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="How?">
            <select className={inputClass} value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="bank_transfer">Bank transfer</option>
              <option value="upi">UPI</option>
              <option value="neft_rtgs">NEFT / RTGS</option>
              <option value="cheque">Cheque</option>
              <option value="cash">Cash</option>
            </select>
          </Field>
          <Field label="Reference">
            <input className={inputClass} value={ref} onChange={(e) => setRef(e.target.value)} />
          </Field>
        </div>

        {error && <Alert tone="danger">{error}</Alert>}
        <div className="flex gap-2">
          <Button type="submit" disabled={!ready || busy}>
            {busy ? "Saving…" : paise > 0 ? `Record ${inr(paise)}` : "Record"}
          </Button>
          <Button type="button" variant="secondary" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}
