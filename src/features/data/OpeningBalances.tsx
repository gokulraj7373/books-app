import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../company/CompanyProvider";
import {
  listAccounts,
  openingBalanceStatus,
  setOpeningBalances,
  type OpeningLine,
} from "../../lib/queries";
import { fromPaise, inr, toPaise } from "../../lib/money";
import {
  Alert,
  Button,
  Card,
  Field,
  inputClass,
  SectionTitle,
  Skeleton,
} from "../../components/ui";
import { errorMessage } from "../../lib/errors";

/* ============================================================================
   Opening balances — what the business already had on the day it moved in.

   THE GAP THIS CLOSES
   Until now the app could only be used by a business starting from nothing.
   Anyone already trading had two bad options: re-enter years of history, or
   start with a balance sheet claiming the company owns nothing and owes
   nothing. Neither is the truth.

   WHY THIS IS AN ENTRY, NOT A SET OF FIELDS
   It posts a real dated voucher that appears in the ledger, carries a voucher
   number and hashes into the tamper-evident chain. A figure that decides your
   entire balance sheet should not be a number someone can quietly retype — and
   correcting it should leave the same trail as correcting anything else.

   The difference between the two sides is not an error to be rejected. It is
   what the business had accumulated before it arrived, and it goes to
   9900 Opening Balance Equalisation automatically.
   ========================================================================= */

type Row = { account_id: string; debit: string; credit: string };
const emptyRow = (): Row => ({ account_id: "", debit: "", credit: "" });

export function OpeningBalances() {
  const { company, statutoryBook, managementBook, internalMode, can } = useCompany();
  const qc = useQueryClient();
  const book = internalMode && managementBook ? managementBook : statutoryBook;

  const [rows, setRows] = useState<Row[]>([emptyRow(), emptyRow(), emptyRow()]);
  const [asOn, setAsOn] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const accountsQ = useQuery({
    queryKey: ["accounts", company?.id],
    queryFn: () => listAccounts(company!.id),
    enabled: !!company,
  });
  const statusQ = useQuery({
    queryKey: ["opening-status", company?.id, book?.id],
    queryFn: () => openingBalanceStatus(company!.id, book!.id),
    enabled: !!company && !!book,
  });

  // 9900 is worked out for the user, so it must not be pickable.
  const accounts = useMemo(
    () =>
      (accountsQ.data ?? []).filter(
        (a) => !a.is_group && a.is_active && a.code !== "9900",
      ),
    [accountsQ.data],
  );

  const totals = useMemo(() => {
    let dr = 0;
    let cr = 0;
    for (const r of rows) {
      try {
        dr += toPaise(r.debit || 0);
        cr += toPaise(r.credit || 0);
      } catch {
        /* half-typed number */
      }
    }
    return { dr, cr, diff: dr - cr };
  }, [rows]);

  if (!company) return <p className="text-sm text-muted">Create a company first.</p>;
  if (accountsQ.isLoading || statusQ.isLoading) return <Skeleton rows={6} />;

  const existing = statusQ.data;
  const filled = rows.filter((r) => r.account_id && (r.debit || r.credit));
  const ready = !!asOn && filled.length > 0 && !busy;

  function update(i: number, patch: Partial<Row>) {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const lines: OpeningLine[] = filled.map((r) => ({
        account_id: r.account_id,
        debit: r.debit ? fromPaise(toPaise(r.debit)) : undefined,
        credit: r.credit ? fromPaise(toPaise(r.credit)) : undefined,
      }));
      await setOpeningBalances({
        company_id: company!.id,
        book_id: book!.id,
        as_on: asOn,
        lines,
      });
      await qc.invalidateQueries();
      setDone("Opening balances recorded. They now appear in every report from that date.");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div>
        <h1 className="text-xl font-extrabold text-navy">Opening balances</h1>
        <p className="mt-0.5 text-sm text-muted">
          What the business already had on the day these books start — money in the bank, what you
          owed, what you owned. Only needed if you were trading before you started using this app.
        </p>
      </div>

      {existing ? (
        <>
          <Alert tone="ok" title="Already recorded">
            Opening balances for this book were recorded as{" "}
            <strong>{existing.voucher_no}</strong> dated{" "}
            {new Date(existing.entry_date + "T00:00:00").toLocaleDateString("en-IN", {
              day: "2-digit",
              month: "short",
              year: "numeric",
            })}
            , across {existing.line_count} accounts.
          </Alert>
          <Alert tone="info" title="To change them">
            There is deliberately no second set — a second one would silently double every balance.
            Correct the existing entry the same way you would correct any other: open{" "}
            <Link to="/entries" className="font-semibold underline underline-offset-2">
              the entries list
            </Link>
            , find {existing.voucher_no}, and use Fix. The correction stays on the record, which is
            the point.
          </Alert>
        </>
      ) : !can("post_entry") ? (
        <Alert tone="info">
          Your role can view this but not record opening balances. Ask an owner or your accountant.
        </Alert>
      ) : done ? (
        <Alert tone="ok" title="Done">
          {done}
        </Alert>
      ) : (
        <>
          <Alert tone="info" title="How this works">
            Put each balance on the side it sits on: what you own and what is owed TO you as a
            debit; what you owe and the owners' money as a credit. Whatever the two sides do not
            cover is your accumulated position before you arrived, and it is worked out for you —
            you do not have to make it balance.
          </Alert>

          <Card className="space-y-4 p-5">
            <Field
              label="As at"
              required
              hint={`On or before ${new Date(company.books_start_date + "T00:00:00").toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}, the day your books start.`}
            >
              <input
                type="date"
                className={inputClass}
                value={asOn}
                max={company.books_start_date}
                onChange={(e) => setAsOn(e.target.value)}
              />
            </Field>

            <div>
              <SectionTitle
                right={
                  <button
                    type="button"
                    onClick={() => setRows((r) => [...r, emptyRow()])}
                    className="text-xs font-bold text-navy underline underline-offset-2"
                  >
                    + add a row
                  </button>
                }
              >
                Balances
              </SectionTitle>

              <div className="space-y-2">
                {rows.map((r, i) => (
                  <div
                    key={i}
                    className="grid gap-2 rounded-xl border border-line p-2 sm:grid-cols-[1fr_7rem_7rem_2rem]"
                  >
                    <select
                      className={inputClass}
                      value={r.account_id}
                      onChange={(e) => update(i, { account_id: e.target.value })}
                      aria-label={`Account for row ${i + 1}`}
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
                      placeholder="Own / owed to you"
                      value={r.debit}
                      onChange={(e) => update(i, { debit: e.target.value, credit: "" })}
                      aria-label={`Debit for row ${i + 1}`}
                    />
                    <input
                      className={`${inputClass} text-right tnum`}
                      inputMode="decimal"
                      placeholder="Owe / capital"
                      value={r.credit}
                      onChange={(e) => update(i, { credit: e.target.value, debit: "" })}
                      aria-label={`Credit for row ${i + 1}`}
                    />
                    <button
                      type="button"
                      onClick={() => setRows((rs) => rs.filter((_, idx) => idx !== i))}
                      disabled={rows.length <= 1}
                      className="text-muted hover:text-danger disabled:opacity-30"
                      aria-label={`Remove row ${i + 1}`}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-xl border border-line bg-canvas p-3 text-sm">
              <div className="flex flex-wrap justify-between gap-2">
                <span className="text-muted">You own / are owed</span>
                <span className="font-bold tnum">{inr(totals.dr)}</span>
              </div>
              <div className="mt-1 flex flex-wrap justify-between gap-2">
                <span className="text-muted">You owe / owners' money</span>
                <span className="font-bold tnum">{inr(totals.cr)}</span>
              </div>
              {totals.diff !== 0 && (
                <div className="mt-2 border-t border-line pt-2">
                  <div className="flex flex-wrap justify-between gap-2">
                    <span className="font-semibold text-navy">
                      Accumulated position brought forward
                    </span>
                    <span className="font-bold text-navy tnum">
                      {inr(Math.abs(totals.diff))} {totals.diff > 0 ? "Cr" : "Dr"}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted">
                    Added automatically to 9900 Opening Balance Equalisation so the entry balances.
                    This is what the business had built up — or lost — before these books begin.
                  </p>
                </div>
              )}
            </div>

            {error && <Alert tone="danger">{error}</Alert>}

            <Button onClick={save} disabled={!ready} className="w-full">
              {busy ? "Recording…" : "Record opening balances"}
            </Button>
          </Card>
        </>
      )}
    </div>
  );
}
