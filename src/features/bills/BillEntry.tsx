import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../company/CompanyProvider";
import {
  listAccounts,
  recordBill,
  supplierAdvances,
  type BillLineInput,
} from "../../lib/queries";

import { inr, toPaise, fromPaise } from "../../lib/money";
import { accountsFor, moneyAccountsForBook } from "../../lib/recipes";
import { Alert, Button, Card, Field, inputClass, SectionTitle } from "../../components/ui";
import { PartyPicker } from "../entries/PartyPicker";
import { errorMessage } from "../../lib/errors";
import { ProofPicker } from "../entries/ProofPicker";

const INTERNAL_MODE_REASON = "Internal book entry — not routed through the company bank";

const today = () => new Date().toISOString().slice(0, 10);

/** Standard terms, as offered by Zoho Books and QuickBooks. */
const TERMS = [
  { key: "Due on receipt", days: 0 },
  { key: "Net 15", days: 15 },
  { key: "Net 30", days: 30 },
  { key: "Net 45", days: 45 },
  { key: "Net 60", days: 60 },
  { key: "Custom", days: null as number | null },
];

const MODES = [
  ["bank_transfer", "Bank transfer"],
  ["upi", "UPI"],
  ["cheque", "Cheque"],
  ["cash", "Cash"],
  ["card", "Card"],
  ["neft_rtgs", "NEFT / RTGS"],
] as const;

type Line = {
  key: number;
  description: string;
  accountId: string;
  qty: string;
  unit: string;
  rate: string;
  amount: string;
  hsn: string;
};

const blankLine = (k: number, accountId = ""): Line => ({
  key: k,
  description: "",
  accountId,
  qty: "",
  unit: "",
  rate: "",
  amount: "",
  hsn: "",
});

export function BillEntry() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const { company, statutoryBook, managementBook, activeBookId, can, internalMode } = useCompany();

  const accountsQ = useQuery({
    queryKey: ["accounts", company?.id],
    queryFn: () => listAccounts(company!.id),
    enabled: !!company,
  });
  const advancesQ = useQuery({
    queryKey: ["supplier-advances", company?.id, activeBookId],
    queryFn: () => supplierAdvances(company!.id, activeBookId!),
    enabled: !!company && !!activeBookId,
  });

  const accounts = accountsQ.data ?? [];
  // A bill buys something you keep (asset) or something used up (cost).
  const spendAccounts = useMemo(
    () => accountsFor(accounts, { capexRole: ["ppe", "cwip"], type: ["expense"] }),
    [accounts],
  );
  const [party, setParty] = useState("");
  const [billNo, setBillNo] = useState("");
  const [billDate, setBillDate] = useState(today());
  const [terms, setTerms] = useState("Net 30");
  const [dueDate, setDueDate] = useState("");
  const [lines, setLines] = useState<Line[]>([blankLine(1)]);
  const [notes, setNotes] = useState("");
  const [proof, setProof] = useState("");
  const [status, setStatus] = useState<"unpaid" | "paid" | "part">("unpaid");
  const [payAmount, setPayAmount] = useState("");
  const [payAccount, setPayAccount] = useState("");
  const [payDate, setPayDate] = useState(today());
  const [payMode, setPayMode] = useState("bank_transfer");
  const [payRef, setPayRef] = useState("");
  const [useAdvance, setUseAdvance] = useState(true);
  const [advanceAmount, setAdvanceAmount] = useState("");
  // Follows the book the app is in, same as every other entry screen.
  // DERIVED, never copied into state. `useState(internalMode)` captured the
  // value at first render — and on a cold load the books query had not resolved
  // yet, so internalMode was still false. The header then said "Internal" while
  // this form said "OFFICIAL" and posted to the statutory book: the exact
  // wrong-book mistake the whole mode exists to prevent.
  // null = follow the app's mode; true/false = this one entry goes the other way.
  const [override, setOverride] = useState<boolean | null>(null);
  const internal = override ?? internalMode;
  const setInternal = (v: boolean) => setOverride(v === internalMode ? null : v);
  const targetBookId = internal && managementBook ? managementBook.id : (statutoryBook?.id ?? null);
  // Offer only the money accounts that are LEGAL for the book being written to.
  // Listing an official bank account next to internal-only cash while the app
  // is in internal mode invites the wrong pick and then fails at submit — the
  // database refuses it, but that is the worst place to find out.
  const money = useMemo(
    () => moneyAccountsForBook(accounts, targetBookId, internal),
    [accounts, targetBookId, internal],
  );
  // When the WHOLE APP is in internal mode the reason is the mode itself, so
  // it is pre-filled rather than demanded on every entry. A one-off override
  // out of the official books still has to be explained in words.
  const [reason, setReason] = useState(INTERNAL_MODE_REASON);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ---- derived --------------------------------------------------------------
  const total = lines.reduce((n, l) => {
    try {
      return n + toPaise(l.amount || "0");
    } catch {
      return n;
    }
  }, 0);

  // advances this supplier already has sitting with them
  const theirAdvances = (advancesQ.data ?? []).filter(
    (a) => a.party_name.trim().toLowerCase() === party.trim().toLowerCase(),
  );
  const advanceAvailable = theirAdvances.reduce((n, a) => n + toPaise(a.advance_outstanding), 0);
  const advanceToApply =
    useAdvance && advanceAvailable > 0
      ? Math.min(
          advanceAmount ? safePaise(advanceAmount) : Math.min(advanceAvailable, total),
          advanceAvailable,
          total,
        )
      : 0;

  const afterAdvance = Math.max(0, total - advanceToApply);
  const payNow =
    status === "paid" ? afterAdvance : status === "part" ? Math.min(safePaise(payAmount), afterAdvance) : 0;
  const outstanding = Math.max(0, afterAdvance - payNow);

  function safePaise(v: string) {
    try {
      return toPaise(v || "0");
    } catch {
      return 0;
    }
  }

  function applyTerms(t: string, from = billDate) {
    setTerms(t);
    const spec = TERMS.find((x) => x.key === t);
    if (spec?.days != null && from) {
      const d = new Date(from + "T00:00:00");
      d.setDate(d.getDate() + spec.days);
      setDueDate(d.toISOString().slice(0, 10));
    }
  }

  function setLine(key: number, patch: Partial<Line>) {
    setLines((ls) =>
      ls.map((l) => {
        if (l.key !== key) return l;
        const next = { ...l, ...patch };
        // qty x rate fills the amount, but a typed amount always wins
        if ((patch.qty !== undefined || patch.rate !== undefined) && next.qty && next.rate) {
          const q = Number(next.qty);
          const r = safePaise(next.rate);
          if (!Number.isNaN(q) && r > 0) next.amount = fromPaise(Math.round(q * r));
        }
        return next;
      }),
    );
  }

  const ready =
    party.trim().length > 0 &&
    total > 0 &&
    lines.every((l) => !l.amount || l.accountId) &&
    lines.some((l) => safePaise(l.amount) > 0 && l.accountId) &&
    !!billDate &&
    (status === "unpaid" || !!payAccount) &&
    (status !== "part" || payNow > 0) &&
    (!internal || reason.trim().length > 0);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready || !company) return;
    setBusy(true);
    setError(null);
    try {
      const bookId = internal && managementBook ? managementBook.id : statutoryBook!.id;
      const payloadLines: BillLineInput[] = lines
        .filter((l) => safePaise(l.amount) > 0 && l.accountId)
        .map((l) => ({
          account_id: l.accountId,
          amount: l.amount,
          description: l.description || undefined,
          qty: l.qty || undefined,
          unit: l.unit || undefined,
          hsn_sac: l.hsn || undefined,
        }));

      const res = await recordBill({
        company_id: company.id,
        book_id: bookId,
        party_name: party.trim(),
        bill_no: billNo || undefined,
        bill_date: billDate,
        due_date: dueDate || undefined,
        payment_terms: terms,
        narration: notes || undefined,
        proof_url: proof || undefined,
        adjustment_reason: internal ? reason.trim() : undefined,
        lines: payloadLines,
        apply_advance:
          advanceToApply > 0
            ? { account_id: theirAdvances[0].account_id, amount: fromPaise(advanceToApply) }
            : undefined,
        payment:
          payNow > 0
            ? {
                money_account_id: payAccount,
                amount: fromPaise(payNow),
                date: payDate,
                mode: payMode,
                reference: payRef || undefined,
              }
            : undefined,
      });
      void res;
      await qc.invalidateQueries();
      void nav({ to: "/bills" });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!company) return <p className="text-sm text-muted">Create a company first.</p>;

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-xl font-extrabold text-navy">Record a bill</h1>
      <p className="mt-0.5 mb-4 text-sm text-muted">
        A bill from a supplier, whether you are paying it now or later. Any advance you already
        paid them is set against it automatically.
      </p>

      <form onSubmit={submit} className="space-y-4">
        {/* ---------------------------------------------------------- supplier */}
        <Card className="space-y-4 p-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Supplier" required hint="Type a new name to add them">
              <PartyPicker
                companyId={company.id}
                value={party}
                onChange={setParty}
                placeholder="Meridian Furniture"
              />
            </Field>
            <Field label="Their bill number" hint="As printed on their bill">
              <input
                className={inputClass}
                value={billNo}
                onChange={(e) => setBillNo(e.target.value)}
                placeholder="SKS/2026/114"
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Bill date" required>
              <input
                type="date"
                className={inputClass}
                value={billDate}
                onChange={(e) => {
                  setBillDate(e.target.value);
                  applyTerms(terms, e.target.value);
                }}
              />
            </Field>
            <Field label="Payment terms">
              <select
                className={inputClass}
                value={terms}
                onChange={(e) => applyTerms(e.target.value)}
              >
                {TERMS.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.key}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Payment due by">
              <input
                type="date"
                className={inputClass}
                value={dueDate}
                onChange={(e) => {
                  setDueDate(e.target.value);
                  setTerms("Custom");
                }}
              />
            </Field>
          </div>
        </Card>

        {/* ------------------------------------------------------------- items */}
        <Card className="p-5">
          <SectionTitle
            right={
              <button
                type="button"
                onClick={() => setLines((ls) => [...ls, blankLine(Date.now())])}
                className="text-xs font-bold text-navy underline underline-offset-2"
              >
                + Add item
              </button>
            }
          >
            What is on the bill
          </SectionTitle>

          <div className="space-y-3">
            {lines.map((l, i) => (
              <div key={l.key} className="rounded-xl border border-line p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-bold text-muted">Item {i + 1}</span>
                  {lines.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                      className="text-xs font-semibold text-danger"
                    >
                      Remove
                    </button>
                  )}
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Description">
                    <input
                      className={inputClass}
                      value={l.description}
                      onChange={(e) => setLine(l.key, { description: e.target.value })}
                      placeholder="SS work tables"
                    />
                  </Field>
                  <Field
                    label="What is it?"
                    required
                    hint="Something you keep is an asset; something used up is a cost"
                  >
                    <select
                      className={inputClass}
                      value={l.accountId}
                      onChange={(e) => setLine(l.key, { accountId: e.target.value })}
                    >
                      <option value="">Choose…</option>
                      {spendAccounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>

                <div className="mt-3 grid gap-3 sm:grid-cols-4">
                  <Field label="Qty">
                    <input
                      className={`${inputClass} text-right tnum`}
                      inputMode="decimal"
                      value={l.qty}
                      onChange={(e) => setLine(l.key, { qty: e.target.value })}
                    />
                  </Field>
                  <Field label="Unit">
                    <input
                      className={inputClass}
                      value={l.unit}
                      onChange={(e) => setLine(l.key, { unit: e.target.value })}
                      placeholder="nos"
                    />
                  </Field>
                  <Field label="Rate">
                    <input
                      className={`${inputClass} text-right tnum`}
                      inputMode="decimal"
                      value={l.rate}
                      onChange={(e) => setLine(l.key, { rate: e.target.value })}
                    />
                  </Field>
                  <Field label="Amount" required>
                    <input
                      className={`${inputClass} text-right font-bold tnum`}
                      inputMode="decimal"
                      value={l.amount}
                      onChange={(e) => setLine(l.key, { amount: e.target.value })}
                      placeholder="0.00"
                    />
                  </Field>
                </div>

                <details className="mt-2">
                  <summary className="cursor-pointer text-xs font-semibold text-muted">
                    HSN / SAC code (for GST later)
                  </summary>
                  <div className="mt-2">
                    <input
                      className={inputClass}
                      value={l.hsn}
                      onChange={(e) => setLine(l.key, { hsn: e.target.value })}
                      placeholder="7323"
                    />
                  </div>
                </details>
              </div>
            ))}
          </div>

          <div className="mt-4 flex items-baseline justify-between border-t border-line pt-3">
            <span className="text-sm font-bold text-ink">Bill total</span>
            <span className="text-xl font-extrabold text-navy tnum">{inr(total)}</span>
          </div>
        </Card>

        {/* --------------------------------------------------- advance + payment */}
        <Card className="space-y-4 p-5">
          <SectionTitle>Settling this bill</SectionTitle>

          {advanceAvailable > 0 && (
            <div className="rounded-xl border border-gold/40 bg-gold/5 p-3">
              <label className="flex cursor-pointer items-start gap-2.5">
                <input
                  type="checkbox"
                  checked={useAdvance}
                  onChange={(e) => setUseAdvance(e.target.checked)}
                  className="mt-0.5"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-bold text-ink">
                    Use the {inr(advanceAvailable)} advance already with {party.trim()}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted">
                    Held in {theirAdvances[0]?.account_name}. This reduces the bill instead of
                    paying twice.
                  </span>
                </span>
              </label>
              {useAdvance && (
                <div className="mt-3 w-40">
                  <Field label="Amount to use">
                    <input
                      className={`${inputClass} text-right tnum`}
                      inputMode="decimal"
                      value={advanceAmount}
                      onChange={(e) => setAdvanceAmount(e.target.value)}
                      placeholder={fromPaise(Math.min(advanceAvailable, total))}
                    />
                  </Field>
                </div>
              )}
            </div>
          )}

          <div>
            <span className="mb-1.5 block text-sm font-semibold text-ink">
              Is the balance paid?
            </span>
            <div className="grid gap-2 sm:grid-cols-3">
              {[
                ["unpaid", "Not paid yet", "Goes to what you owe"],
                ["paid", "Paid in full", "Settles it right now"],
                ["part", "Part paid", "Pay some now, rest later"],
              ].map(([v, label, hint]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setStatus(v as typeof status)}
                  aria-pressed={status === v}
                  className={`rounded-xl border p-3 text-left transition-colors duration-200 active:scale-[0.98] ${
                    status === v ? "border-navy bg-navy/5" : "border-line bg-card hover:bg-canvas"
                  }`}
                >
                  <span className="block text-sm font-bold text-ink">{label}</span>
                  <span className="mt-0.5 block text-xs text-muted">{hint}</span>
                </button>
              ))}
            </div>
          </div>

          {status !== "unpaid" && (
            <div className="grid gap-4 sm:grid-cols-2">
              {status === "part" && (
                <Field label="Paying now" required>
                  <input
                    className={`${inputClass} text-right tnum`}
                    inputMode="decimal"
                    value={payAmount}
                    onChange={(e) => setPayAmount(e.target.value)}
                    placeholder="0.00"
                  />
                </Field>
              )}
              <Field label="Paid from" required>
                <select
                  className={inputClass}
                  value={payAccount}
                  onChange={(e) => setPayAccount(e.target.value)}
                >
                  <option value="">Choose…</option>
                  {money.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Payment date">
                <input
                  type="date"
                  className={inputClass}
                  value={payDate}
                  onChange={(e) => setPayDate(e.target.value)}
                />
              </Field>
              <Field label="How paid">
                <select
                  className={inputClass}
                  value={payMode}
                  onChange={(e) => setPayMode(e.target.value)}
                >
                  {MODES.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Payment reference" hint="UTR, cheque number">
                <input
                  className={inputClass}
                  value={payRef}
                  onChange={(e) => setPayRef(e.target.value)}
                />
              </Field>
            </div>
          )}

          {/* running summary — the thing that makes this understandable */}
          {total > 0 && (
            <div className="rounded-xl bg-canvas p-3 text-sm">
              <Row label="Bill total" value={inr(total)} />
              {advanceToApply > 0 && (
                <Row label="Less advance already paid" value={`− ${inr(advanceToApply)}`} tone="ok" />
              )}
              {payNow > 0 && <Row label="Paying now" value={`− ${inr(payNow)}`} tone="ok" />}
              <div className="mt-1.5 flex items-baseline justify-between border-t border-line pt-1.5">
                <span className="font-bold text-ink">
                  {outstanding > 0 ? `Still owed to ${party.trim() || "them"}` : "Fully settled"}
                </span>
                <span
                  className={`text-base font-extrabold tnum ${
                    outstanding > 0 ? "text-danger" : "text-ok"
                  }`}
                >
                  {inr(outstanding)}
                </span>
              </div>
            </div>
          )}
        </Card>

        {/* ------------------------------------------------------------ extras */}
        <Card className="space-y-4 p-5">
          <SectionTitle>Notes and proof</SectionTitle>
          <Field label="Note" hint="Anything you want to remember about this bill">
            <input className={inputClass} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
          <ProofPicker companyId={company?.id} value={proof} onChange={setProof} />

          {managementBook && can("view_management_book") && (
            <div className="rounded-xl border border-line p-3">
              <label className="flex cursor-pointer items-start gap-2.5">
                <input
                  type="checkbox"
                  checked={internal}
                  onChange={(e) => setInternal(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  <span className="block text-sm font-semibold text-ink">
                    Keep this out of the official books
                  </span>
                  <span className="mt-0.5 block text-xs text-muted">
                    Anything paid through the company bank cannot be kept out — the bank statement
                    has to match.
                  </span>
                </span>
              </label>
              {internal && (
                <div className="mt-3">
                  <Field label="Why is this internal only?" required>
                    <input
                      className={inputClass}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                    />
                  </Field>
                </div>
              )}
            </div>
          )}
        </Card>

        {error && <Alert tone="danger">{error}</Alert>}

        <Button type="submit" disabled={!ready || busy} className="w-full">
          {busy ? "Saving…" : total > 0 ? `Record bill of ${inr(total)}` : "Record bill"}
        </Button>
      </form>
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: "ok" }) {
  return (
    <div className="flex items-baseline justify-between py-0.5">
      <span className="text-muted">{label}</span>
      <span className={`tnum ${tone === "ok" ? "text-ok" : ""}`}>{value}</span>
    </div>
  );
}
