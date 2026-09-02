import { useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../company/CompanyProvider";
import { listAccounts, saveJournalEntry, type LineInput } from "../../lib/queries";
import { supabase } from "../../lib/supabase";
import { balanceDelta, inr, toPaise } from "../../lib/money";
import { PartyPicker } from "./PartyPicker";
import {
  Alert,
  Amount,
  Badge,
  Button,
  Card,
  Field,
  inputClass,
  SectionTitle,
  Skeleton,
} from "../../components/ui";
import { errorMessage } from "../../lib/errors";

const VOUCHER_TYPES = [
  ["receipt", "Receipt — money came in"],
  ["payment", "Payment — money went out"],
  ["contra", "Contra — between own cash/bank"],
  ["journal", "Journal — no money moved"],
  ["capitalization", "Capitalisation — work became an asset"],
] as const;

const ADJUSTMENT_REASONS = [
  ["promoter_direct_outlay", "Paid directly by an owner/investor, not through the company"],
  ["management_depreciation", "Management-basis depreciation"],
  ["notional_rent_or_salary", "Notional owner rent or salary"],
  ["cost_allocation", "Internal cost allocation"],
  ["provision_or_estimate", "Provision or estimate"],
  ["timing_difference", "Timing difference"],
  ["other", "Other (explain in the narration)"],
] as const;

/**
 * `party` is the supplier/investor/employee this line is about, by NAME. It is
 * resolved to an id on submit, exactly as the guided screen does it.
 *
 * This screen is the escape hatch for everything the guided recipes cannot
 * express — and until now it could not tag a party at all. Anything recorded
 * here was therefore invisible in party statements and in the payables ageing,
 * silently, with no hint that a field was missing.
 */
type Row = { account_id: string; debit: string; credit: string; party: string };
const emptyRow = (): Row => ({ account_id: "", debit: "", credit: "", party: "" });

export function NewEntry() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const { company, statutoryBook, managementBook, can, activeBookId } = useCompany();

  // Starts on whichever book the app is in, so this screen agrees with every
  // other one. Still explicitly switchable below — this is the accountant's
  // screen, where being able to choose is the point.
  const [bookId, setBookId] = useState<string>(activeBookId ?? "");
  const [voucherType, setVoucherType] = useState("payment");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [narration, setNarration] = useState("");
  const [reason, setReason] = useState("promoter_direct_outlay");
  const [paymentMode, setPaymentMode] = useState("");
  const [refNo, setRefNo] = useState("");
  const [proofUrl, setProofUrl] = useState("");
  const [rows, setRows] = useState<Row[]>([emptyRow(), emptyRow()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idempotencyKey = useRef(crypto.randomUUID());

  const accountsQ = useQuery({
    queryKey: ["accounts", company?.id],
    queryFn: () => listAccounts(company!.id),
    enabled: !!company,
  });

  const accounts = useMemo(
    () => (accountsQ.data ?? []).filter((a) => !a.is_group && a.is_active),
    [accountsQ.data],
  );
  const accountById = useMemo(
    () => Object.fromEntries(accounts.map((a) => [a.id, a])),
    [accounts],
  );

  const activeBook = bookId || statutoryBook?.id || "";
  const isManagement = !!managementBook && activeBook === managementBook.id;

  const delta = useMemo(() => {
    try {
      return balanceDelta(rows.map((r) => ({ debit: r.debit, credit: r.credit })));
    } catch {
      return NaN;
    }
  }, [rows]);

  const totals = useMemo(() => {
    let dr = 0;
    let cr = 0;
    for (const r of rows) {
      try {
        dr += toPaise(r.debit || 0);
        cr += toPaise(r.credit || 0);
      } catch {
        /* a half-typed number is not an error yet */
      }
    }
    return { dr, cr };
  }, [rows]);

  // The two-book rule, surfaced BEFORE the user submits. The database enforces
  // it regardless; this is so the reason is understood rather than just refused.
  const bankLineInManagement = isManagement
    ? rows.find((r) => r.account_id && accountById[r.account_id]?.is_bank_or_cash)
    : undefined;

  const filled = rows.filter((r) => r.account_id && (r.debit || r.credit));

  // A minus sign in an amount box. `toPaise` parses it happily, and two
  // negatives can still make `delta` zero — so the entry looks balanced right
  // up until Postgres rejects it on a check constraint with a message nobody
  // can act on. Say it here instead. To take money the other way, swap the
  // debit and the credit; that is what a negative debit means.
  const negativeAmount = rows.some((r) =>
    [r.debit, r.credit].some((v) => {
      if (!v) return false;
      try {
        return toPaise(v) < 0;
      } catch {
        return false; // junk is already reported by the balance badge
      }
    }),
  );

  // An entry whose every account nets to zero records nothing at all, however
  // neatly it balances. The database refuses it too (migration 0044) — this is
  // so it is caught before the button rather than after.
  const changesNothing = useMemo(() => {
    if (filled.length < 2) return false;
    const net = new Map<string, number>();
    for (const r of filled) {
      try {
        const d = toPaise(r.debit || 0) - toPaise(r.credit || 0);
        net.set(r.account_id, (net.get(r.account_id) ?? 0) + d);
      } catch {
        return false;
      }
    }
    return [...net.values()].every((n) => n === 0);
  }, [filled]);

  const canSubmit =
    !!company &&
    !!activeBook &&
    narration.trim().length > 0 &&
    filled.length >= 2 &&
    delta === 0 &&
    !negativeAmount &&
    !changesNothing &&
    !bankLineInManagement;

  function update(i: number, patch: Partial<Row>) {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  async function submit(status: "draft" | "posted") {
    if (!company) return;
    setBusy(true);
    setError(null);
    try {
      // Resolve each line's party name to an id. Names are de-duplicated first
      // so "Meridian" on three lines is one round trip and one party.
      const names = [...new Set(filled.map((r) => r.party.trim()).filter(Boolean))];
      const partyIdByName = new Map<string, string>();
      for (const name of names) {
        const { data, error } = await supabase.rpc("find_or_create_party", {
          p_company: company.id,
          p_name: name,
          p_type: null,
        });
        if (error) throw error;
        partyIdByName.set(name, data as string);
      }
      if (names.length) void qc.invalidateQueries({ queryKey: ["parties", company.id] });

      const lines: LineInput[] = filled.map((r) => ({
        account_id: r.account_id,
        debit: r.debit || undefined,
        credit: r.credit || undefined,
        party_id: partyIdByName.get(r.party.trim()),
      }));
      await saveJournalEntry({
        company_id: company.id,
        book_id: activeBook,
        voucher_type: voucherType,
        entry_date: date,
        narration: narration.trim(),
        status,
        adjustment_reason: isManagement ? reason : undefined,
        payment_mode: paymentMode || undefined,
        reference_no: refNo || undefined,
        proof_url: proofUrl || undefined,
        // Generated once per form, not once per attempt. A new key on every
        // press turns "the reply timed out, try again" into two vouchers.
        idempotency_key: idempotencyKey.current,
        lines,
      });
      await qc.invalidateQueries();
      void nav({ to: "/entries" });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!company) return <Alert tone="info">Create a company first.</Alert>;
  if (accountsQ.isLoading) return <Skeleton rows={6} />;

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <h1 className="text-xl font-extrabold text-navy">New voucher</h1>

      <Card className="space-y-4 p-5">
        {managementBook && can("view_management_book") && (
          <div>
            <SectionTitle>Which book?</SectionTitle>
            <div className="grid gap-2 sm:grid-cols-2">
              <BookCard
                selected={!isManagement}
                onClick={() => setBookId(statutoryBook!.id)}
                title="Statutory"
                body="The official books. Anything that moved through the company bank belongs here."
              />
              <BookCard
                selected={isManagement}
                onClick={() => setBookId(managementBook.id)}
                title="Management"
                body="Internal view only. Cannot touch a bank or cash account."
              />
            </div>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Type" required>
            <select
              className={inputClass}
              value={voucherType}
              onChange={(e) => setVoucherType(e.target.value)}
            >
              {VOUCHER_TYPES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Date" required>
            <input
              className={inputClass}
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </Field>
        </div>

        <Field label="Narration" required hint="What actually happened, in plain words.">
          <input
            className={inputClass}
            value={narration}
            onChange={(e) => setNarration(e.target.value)}
            placeholder="Capital contribution received from Anand"
          />
        </Field>

        {isManagement && (
          <Field label="Why is this management-only?" required>
            <select
              className={inputClass}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            >
              {ADJUSTMENT_REASONS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
        )}
      </Card>

      <Card className="p-5">
        <SectionTitle
          right={
            <button
              type="button"
              onClick={() => setRows((r) => [...r, emptyRow()])}
              className="text-xs font-bold text-navy underline underline-offset-2"
            >
              + add line
            </button>
          }
        >
          Lines
        </SectionTitle>

        <div className="space-y-2">
          {rows.map((r, i) => {
            const acct = r.account_id ? accountById[r.account_id] : undefined;
            const offending = isManagement && acct?.is_bank_or_cash;
            return (
              <div
                key={i}
                className={`rounded-xl border p-2 ${offending ? "border-danger bg-dangerbg" : "border-line"}`}
              >
                <div className="grid gap-2 sm:grid-cols-[1fr_7rem_7rem_2rem]">
                  <select
                    className={inputClass}
                    value={r.account_id}
                    onChange={(e) => update(i, { account_id: e.target.value })}
                    aria-label={`Account for line ${i + 1}`}
                  >
                    <option value="">Choose an account…</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} · {a.name}
                      </option>
                    ))}
                  </select>
                  <input
                    className={`${inputClass} text-right tnum`}
                    inputMode="decimal"
                    placeholder="Debit"
                    value={r.debit}
                    onChange={(e) => update(i, { debit: e.target.value, credit: "" })}
                    aria-label={`Debit for line ${i + 1}`}
                  />
                  <input
                    className={`${inputClass} text-right tnum`}
                    inputMode="decimal"
                    placeholder="Credit"
                    value={r.credit}
                    onChange={(e) => update(i, { credit: e.target.value, debit: "" })}
                    aria-label={`Credit for line ${i + 1}`}
                  />
                  <button
                    type="button"
                    onClick={() => setRows((rs) => rs.filter((_, idx) => idx !== i))}
                    disabled={rows.length <= 2}
                    className="text-muted hover:text-danger disabled:opacity-30"
                    aria-label={`Remove line ${i + 1}`}
                  >
                    ×
                  </button>
                </div>
                {/* Who this line is about. Appears once the account is chosen,
                    so an empty form is not five identical name boxes. A bank
                    line has no party — its counterparty is the bank — which is
                    why it is offered rather than demanded. */}
                {r.account_id && !acct?.is_bank_or_cash && (
                  <div className="mt-2">
                    <label className="mb-1 block px-1 text-xs font-semibold text-muted">
                      Who is this line about? (optional)
                    </label>
                    <PartyPicker
                      companyId={company!.id}
                      value={r.party}
                      onChange={(name) => update(i, { party: name })}
                      placeholder="Supplier, investor or staff name"
                    />
                  </div>
                )}

                {offending && (
                  <p className="mt-1.5 px-1 text-xs font-semibold text-danger">
                    {acct?.name} is a bank/cash account. Money that actually moved through the
                    company belongs in the statutory book — otherwise your statutory cash balance
                    would stop matching your bank statement.
                  </p>
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
          <div className="text-sm text-muted">
            Debit <Amount bold>{inr(totals.dr)}</Amount>
            {"  ·  "}
            Credit <Amount bold>{inr(totals.cr)}</Amount>
          </div>
          {delta === 0 && filled.length >= 2 ? (
            <Badge tone="ok">Balanced</Badge>
          ) : Number.isNaN(delta) ? (
            <Badge tone="danger">Check the amounts</Badge>
          ) : (
            <Badge tone="warn">
              Off by {inr(Math.abs(delta))}
            </Badge>
          )}
        </div>
      </Card>

      <details className="rounded-2xl border border-line bg-card p-4">
        <summary className="cursor-pointer text-sm font-semibold text-ink">
          Proof and payment details — strongly recommended
        </summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="Payment mode">
            <select
              className={inputClass}
              value={paymentMode}
              onChange={(e) => setPaymentMode(e.target.value)}
            >
              <option value="">Not recorded</option>
              {["cash", "bank_transfer", "upi", "cheque", "card", "neft_rtgs", "auto_debit"].map(
                (m) => (
                  <option key={m} value={m}>
                    {m.replace(/_/g, " ")}
                  </option>
                ),
              )}
            </select>
          </Field>
          <Field label="Bill / reference no">
            <input className={inputClass} value={refNo} onChange={(e) => setRefNo(e.target.value)} />
          </Field>
          <div className="sm:col-span-2">
            <Field
              label="Proof link"
              hint="A Drive link or photo URL. This is what turns a number into something an investor can check."
            >
              <input
                className={inputClass}
                value={proofUrl}
                onChange={(e) => setProofUrl(e.target.value)}
                placeholder="https://drive.google.com/…"
              />
            </Field>
          </div>
        </div>
      </details>

      {negativeAmount && (
        <Alert tone="danger" title="An amount is negative">
          Debits and credits are always positive — the side they sit on is what says which way the
          money went. To reverse a line, move the figure to the other column.
        </Alert>
      )}

      {changesNothing && (
        <Alert tone="danger" title="This entry would change nothing">
          Every account here is debited and credited for the same amount, so no balance moves. It
          would balance, get a voucher number and mean nothing. Check the accounts on each line.
        </Alert>
      )}

      {error && <Alert tone="danger">{error}</Alert>}

      <div className="flex flex-wrap gap-2">
        <Button onClick={() => submit("posted")} disabled={!canSubmit || busy || !can("post_entry")}>
          {busy ? "Saving…" : "Post entry"}
        </Button>
        <Button variant="secondary" onClick={() => submit("draft")} disabled={busy || filled.length === 0}>
          Save as draft
        </Button>
      </div>
      {!can("post_entry") && (
        <p className="text-xs text-muted">
          Your role can prepare entries but not post them. Save a draft and ask an owner or
          accountant to post it.
        </p>
      )}
    </div>
  );
}

function BookCard({
  selected,
  onClick,
  title,
  body,
}: {
  selected: boolean;
  onClick: () => void;
  title: string;
  body: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`rounded-xl border p-3 text-left transition-colors duration-200 active:scale-[0.98] ${
        selected ? "border-navy bg-navy/5" : "border-line bg-card hover:bg-canvas"
      }`}
    >
      <p className="text-sm font-bold text-ink">{title}</p>
      <p className="mt-0.5 text-xs text-muted">{body}</p>
    </button>
  );
}
