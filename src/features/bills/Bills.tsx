import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../company/CompanyProvider";
import {
  listAccounts,
  openBills,
  payBill,
  unappliedCredits,
  type OpenBill,
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
import { VoucherLink } from "../entries/VoucherOverlay";
import { PartyLink } from "../parties/PartyLink";

const fmt = (iso: string | null) =>
  iso
    ? new Date(iso + "T00:00:00").toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "2-digit",
      })
    : "—";

export function Bills() {
  const { company, activeBookId } = useCompany();

  const q = useQuery({
    queryKey: ["open-bills", company?.id, activeBookId],
    queryFn: () => openBills(company!.id, activeBookId!),
    enabled: !!company && !!activeBookId,
  });
  // Guard: money that reduced a supplier balance without being tied to a bill.
  // If this is non-zero the bills list and the ledger disagree, and the owner
  // must be told rather than shown two different numbers on two screens.
  const unappliedQ = useQuery({
    queryKey: ["unapplied", company?.id, activeBookId],
    queryFn: () => unappliedCredits(company!.id, activeBookId!),
    enabled: !!company && !!activeBookId,
  });
  const unapplied = unappliedQ.data ?? [];
  const unappliedTotal = unapplied.reduce((n, u) => n + toPaise(u.amount), 0);

  if (!company) return <p className="text-sm text-muted">Create a company first.</p>;

  const bills = q.data ?? [];
  const open = bills.filter((b) => toPaise(b.outstanding) > 0);
  const settled = bills.filter((b) => toPaise(b.outstanding) === 0);
  const overdue = open.filter((b) => b.days_overdue > 0);
  const totalOpen = open.reduce((n, b) => n + toPaise(b.outstanding), 0);
  const totalOverdue = overdue.reduce((n, b) => n + toPaise(b.outstanding), 0);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-extrabold text-navy">Bills</h1>
          <p className="mt-0.5 text-sm text-muted">
            What you owe suppliers, and what is already settled.
          </p>
        </div>
        <Link to="/bills/new">
          <Button>+ Record a bill</Button>
        </Link>
      </div>

      {unappliedTotal > 0 && (
        <Alert tone="warn" title="Some payments are not linked to a bill">
          {inr(unappliedTotal)} was paid to{" "}
          {unapplied.map((u) => u.party_name).join(", ")} without being set against a specific
          bill, so the totals below are higher than what you actually owe. Record those payments
          from the bill itself using “Record a payment” so the two agree.
        </Alert>
      )}

      {open.length > 0 && <Ageing bills={open} />}

      {q.isLoading ? (
        <Skeleton rows={5} />
      ) : bills.length === 0 ? (
        <Card>
          <EmptyState
            icon="🧾"
            title="No bills yet"
            body="Record a supplier bill and it will appear here until it is paid. Any advance you already gave them is set against it automatically."
            action={
              <Link to="/bills/new">
                <Button>Record a bill</Button>
              </Link>
            }
          />
        </Card>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Card className="p-4">
              <p className="text-xs font-bold tracking-wide text-muted uppercase">Still to pay</p>
              <p className="mt-1 text-2xl font-extrabold text-navy tnum">{inr(totalOpen)}</p>
              <p className="mt-0.5 text-xs text-muted">
                across {open.length} {open.length === 1 ? "bill" : "bills"}
              </p>
            </Card>
            <Card className="p-4">
              <p className="text-xs font-bold tracking-wide text-muted uppercase">Overdue</p>
              <p
                className={`mt-1 text-2xl font-extrabold tnum ${
                  totalOverdue > 0 ? "text-danger" : "text-ok"
                }`}
              >
                {inr(totalOverdue)}
              </p>
              <p className="mt-0.5 text-xs text-muted">
                {overdue.length === 0
                  ? "nothing past its due date"
                  : `${overdue.length} past the agreed date`}
              </p>
            </Card>
          </div>

          {open.length > 0 && (
            <section>
              <SectionTitle>Outstanding</SectionTitle>
              <div className="space-y-2">
                {open.map((b) => (
                  <BillRow key={b.entry_id} bill={b} companyId={company.id} />
                ))}
              </div>
            </section>
          )}

          {settled.length > 0 && (
            <section>
              <SectionTitle>Settled</SectionTitle>
              <div className="space-y-2">
                {settled.slice(0, 20).map((b) => (
                  <BillRow key={b.entry_id} bill={b} companyId={company.id} />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function BillRow({ bill, companyId }: { bill: OpenBill; companyId: string }) {
  const [paying, setPaying] = useState(false);
  const out = toPaise(bill.outstanding);
  const settledPct =
    toPaise(bill.total) > 0 ? Math.round((toPaise(bill.settled) / toPaise(bill.total)) * 100) : 0;

  return (
    <Card className="overflow-hidden">
      <div className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-bold text-ink">
                {bill.party_name ? (
                  <PartyLink partyId={bill.party_id} name={bill.party_name} />
                ) : (
                  "—"
                )}
              </span>
              {bill.supplier_bill_no && <Badge>{bill.supplier_bill_no}</Badge>}
              {out === 0 ? (
                <Badge tone="ok">paid</Badge>
              ) : bill.days_overdue > 0 ? (
                <Badge tone="danger">{bill.days_overdue} days overdue</Badge>
              ) : bill.due_date ? (
                <Badge tone="info">due {fmt(bill.due_date)}</Badge>
              ) : null}
            </div>
            <p className="mt-0.5 truncate text-xs text-muted">
              <VoucherLink entryId={bill.entry_id} voucherNo={bill.voucher_no} /> · {fmt(bill.bill_date)}
              {bill.payment_terms && ` · ${bill.payment_terms}`}
            </p>
          </div>
          <div className="text-right">
            <p className={`text-sm font-bold tnum ${out > 0 ? "text-danger" : "text-ok"}`}>
              {inr(out)}
            </p>
            {toPaise(bill.settled) > 0 && (
              <p className="text-xs text-muted tnum">of {inr(toPaise(bill.total))}</p>
            )}
          </div>
        </div>

        {settledPct > 0 && settledPct < 100 && (
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-line">
            <div className="h-full bg-ok" style={{ width: `${settledPct}%` }} />
          </div>
        )}

        {out > 0 && (
          <button
            type="button"
            onClick={() => setPaying((v) => !v)}
            className="mt-2 text-xs font-bold text-navy underline underline-offset-2"
          >
            {paying ? "Cancel" : "Record a payment"}
          </button>
        )}
      </div>

      {paying && (
        <PayForm
          bill={bill}
          companyId={companyId}
          onDone={() => setPaying(false)}
        />
      )}
    </Card>
  );
}

/* ----------------------------------------------------------------------------
   Payables ageing.

   The one report every accountant opens before deciding who to pay next, and
   the standard shape of it: not yet due, then 1-30, 31-60, 61-90 and over 90
   days past the date you agreed. Tally, Zoho and QuickBooks all present it this
   way, so a CA can read it without being told what the columns mean.
   -------------------------------------------------------------------------- */
const BUCKETS = [
  { key: "current", label: "Not due yet", from: -Infinity, to: 0 },
  { key: "b30", label: "1–30 days", from: 1, to: 30 },
  { key: "b60", label: "31–60 days", from: 31, to: 60 },
  { key: "b90", label: "61–90 days", from: 61, to: 90 },
  { key: "b90p", label: "Over 90 days", from: 91, to: Infinity },
] as const;

function Ageing({ bills }: { bills: OpenBill[] }) {
  const byParty = new Map<string, Record<string, number>>();
  for (const b of bills) {
    const bucket = BUCKETS.find((x) => b.days_overdue >= x.from && b.days_overdue <= x.to)!;
    // A bill can be recorded without naming the supplier; it still has to appear
    // here, or the total on this table would not match what you owe.
    const party = b.party_name ?? "No supplier named";
    const row = byParty.get(party) ?? {};
    row[bucket.key] = (row[bucket.key] ?? 0) + toPaise(b.outstanding);
    byParty.set(party, row);
  }
  const rows = [...byParty.entries()].sort(
    (a, b) => sum(b[1]) - sum(a[1]),
  );
  const totals = Object.fromEntries(
    BUCKETS.map((x) => [x.key, rows.reduce((n, [, r]) => n + (r[x.key] ?? 0), 0)]),
  );

  return (
    <Card className="overflow-hidden">
      <div className="border-b border-line px-4 py-3">
        <p className="text-sm font-bold text-ink">How old is what you owe</p>
        <p className="mt-0.5 text-xs text-muted">
          Counted from the date you agreed to pay. Use it to decide who to pay first.
        </p>
      </div>
      {/* phones: one row per supplier, oldest bucket that has money in it */}
      <ul className="divide-y divide-line md:hidden">
        {rows.map(([party, r]) => {
          const worst = [...BUCKETS].reverse().find((b) => r[b.key]);
          return (
            <li key={party} className="flex items-baseline justify-between gap-3 px-3.5 py-2.5">
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold text-ink">{party}</span>
                {worst && (
                  <span
                    className={`text-xs ${worst.key === "b90p" ? "font-bold text-danger" : "text-muted"}`}
                  >
                    oldest: {worst.label}
                  </span>
                )}
              </span>
              <span className="shrink-0 text-sm font-bold tnum">{inr(sum(r))}</span>
            </li>
          );
        })}
        <li className="flex items-baseline justify-between gap-3 bg-canvas px-3.5 py-2.5 font-bold text-navy">
          <span className="text-sm">Total</span>
          <span className="text-sm tnum">
            {inr(Object.values(totals).reduce((a, b) => a + b, 0))}
          </span>
        </li>
      </ul>

      <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[40rem] text-sm">
          <thead>
            <tr className="border-b border-line bg-canvas text-xs tracking-wide text-muted uppercase">
              <th className="px-3 py-2 text-left font-bold">Supplier</th>
              {BUCKETS.map((b) => (
                <th key={b.key} className="px-3 py-2 text-right font-bold">
                  {b.label}
                </th>
              ))}
              <th className="px-3 py-2 text-right font-bold">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([party, r]) => (
              <tr key={party} className="border-b border-line last:border-0">
                <td className="max-w-[12rem] truncate px-3 py-2 font-semibold">{party}</td>
                {BUCKETS.map((b) => (
                  <td
                    key={b.key}
                    className={`px-3 py-2 text-right tnum ${
                      b.key === "b90p" && r[b.key] ? "font-bold text-danger" : ""
                    }`}
                  >
                    {r[b.key] ? inr(r[b.key]) : "—"}
                  </td>
                ))}
                <td className="px-3 py-2 text-right font-bold tnum">{inr(sum(r))}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-navy bg-canvas font-bold text-navy">
              <td className="px-3 py-2">Total</td>
              {BUCKETS.map((b) => (
                <td key={b.key} className="px-3 py-2 text-right tnum">
                  {totals[b.key] ? inr(totals[b.key]) : "—"}
                </td>
              ))}
              <td className="px-3 py-2 text-right tnum">
                {inr(Object.values(totals).reduce((a, b) => a + b, 0))}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </Card>
  );
}

const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);

function PayForm({
  bill,
  companyId,
  onDone,
}: {
  bill: OpenBill;
  companyId: string;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const { activeBookId, internalMode } = useCompany();
  const out = toPaise(bill.outstanding);
  const [amount, setAmount] = useState(fromPaise(out));
  const [account, setAccount] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [mode, setMode] = useState("bank_transfer");
  const [ref, setRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accountsQ = useQuery({
    queryKey: ["accounts", companyId],
    queryFn: () => listAccounts(companyId),
  });
  // Only accounts legal for the book this payment lands in — see BillEntry.
  const money = moneyAccountsForBook(accountsQ.data ?? [], activeBookId, internalMode);

  let paise = 0;
  try {
    paise = toPaise(amount);
  } catch {
    paise = 0;
  }
  const ready = paise > 0 && paise <= out && !!account;

  return (
    <form
      className="space-y-3 border-t border-line bg-canvas p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!ready) return;
        setBusy(true);
        setError(null);
        try {
          await payBill({
            company_id: companyId,
            bill_entry_id: bill.entry_id,
            amount,
            source_account_id: account,
            date,
            mode,
            reference: ref || undefined,
            narration: `Paid ${bill.party_name ?? ""} against ${bill.supplier_bill_no ?? bill.voucher_no}`,
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
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Amount" required hint={`Up to ${inr(out)}`}>
          <input
            className={`${inputClass} text-right tnum`}
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </Field>
        <Field label="Paid from" required>
          <select className={inputClass} value={account} onChange={(e) => setAccount(e.target.value)}>
            <option value="">Choose…</option>
            {money.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Date">
          <input
            type="date"
            className={inputClass}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </Field>
        <Field label="How paid">
          <select className={inputClass} value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="bank_transfer">Bank transfer</option>
            <option value="upi">UPI</option>
            <option value="cheque">Cheque</option>
            <option value="cash">Cash</option>
            <option value="neft_rtgs">NEFT / RTGS</option>
          </select>
        </Field>
      </div>
      <Field label="Reference" hint="UTR or cheque number">
        <input className={inputClass} value={ref} onChange={(e) => setRef(e.target.value)} />
      </Field>
      {error && <Alert tone="danger">{error}</Alert>}
      <Button type="submit" disabled={!ready || busy}>
        {busy ? "Saving…" : `Pay ${inr(paise)}`}
      </Button>
    </form>
  );
}
