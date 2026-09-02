import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCompany } from "../company/CompanyProvider";
import { cashBook } from "../../lib/reports";
import { inr, toPaise } from "../../lib/money";
import { Alert, Card, DataTable, EmptyState, Field, inputClass, Skeleton } from "../../components/ui";
import { PrintBar } from "./ReportHub";
import { ReportShell } from "./ReportShell";
import { VoucherLink } from "../entries/VoucherOverlay";

const fmtShort = (iso: string) =>
  new Date(iso + "T00:00:00").toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "2-digit",
  });

export function CashBook({ unified }: { unified?: boolean } = {}) {
  const { company, activeBookId, managementBook } = useCompany();
  const [from, setFrom] = useState("2026-04-01");
  const [to, setTo] = useState("2027-03-31");
  const [statement, setStatement] = useState("");
  const bookId = unified ? managementBook?.id : activeBookId;

  const q = useQuery({
    queryKey: ["cashbook", company?.id, bookId, from, to, unified ?? false],
    queryFn: () => cashBook(company!.id, bookId!, from, to, !unified),
    enabled: !!company && !!bookId,
  });

  if (!company) return <p className="text-sm text-muted">Create a company first.</p>;
  const rows = q.data ?? [];
  const closing = rows.length ? toPaise(rows[rows.length - 1].running) : 0;
  const totalIn = rows.reduce((n, r) => n + toPaise(r.money_in), 0);
  const totalOut = rows.reduce((n, r) => n + toPaise(r.money_out), 0);
  // Which money accounts actually appear here. The heading claimed "bank
  // statement" even when the only account with movement was cash in hand.
  const accountNames = [...new Set(rows.map((r) => r.account_name))];

  let diff: number | null = null;
  try {
    diff = statement.trim() === "" ? null : toPaise(statement) - closing;
  } catch {
    diff = null;
  }

  return (
    <ReportShell
      title={unified ? "Cash & bank book — unified" : "Cash &amp; bank book"}
      subtitle={
        unified
          ? "every rupee through cash and bank, official and internal together"
          : "every rupee through cash and bank, in date order"
      }
      from={from}
      to={to}
      onFrom={setFrom}
      onTo={setTo}
      unified={unified}
    >
      <PrintBar title="Cash & bank book" />
      <Card className="p-4">
        <p className="mb-1 text-sm font-bold text-ink">
          {accountNames.length === 1
            ? `Check ${accountNames[0]} against what you actually hold`
            : "Check this against your statements and your cash count"}
        </p>
        <p className="mb-3 text-xs text-muted">
          {accountNames.length === 0
            ? "No cash or bank account has been used in this book yet."
            : accountNames.length === 1
              ? "This is the only money account with movement in this book, so the total below is that account."
              : `The total below covers ${accountNames.length} accounts together — ${accountNames.join(", ")}. To reconcile one bank account on its own, open it in the general ledger.`}
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-48">
            <Field label="Balance per books">
              <input className={`${inputClass} text-right tnum`} value={inr(closing)} readOnly />
            </Field>
          </div>
          <div className="w-48">
            <Field label="Balance you actually have">
              <input
                className={`${inputClass} text-right tnum`}
                inputMode="decimal"
                placeholder="0.00"
                value={statement}
                onChange={(e) => setStatement(e.target.value)}
              />
            </Field>
          </div>
          {diff !== null && (
            <div className="pb-1">
              {diff === 0 ? (
                <Alert tone="ok">Reconciled — the books match exactly.</Alert>
              ) : (
                <Alert tone="warn">
                  Difference of {inr(Math.abs(diff))}. Something is recorded in one place but not the
                  other — usually a missing entry, an uncleared cheque, or cash spent without being
                  written down.
                </Alert>
              )}
            </div>
          )}
        </div>
      </Card>

      {q.isLoading ? (
        <Skeleton rows={6} />
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            icon="₹"
            title="No cash or bank movement yet"
            body="Receipts and payments will appear here as soon as they are posted."
          />
        </Card>
      ) : (
        <DataTable
          rows={rows}
          rowKey={(_, i) => String(i)}
          minWidth="44rem"
          cardTitle={(r) => (
            <span className="flex flex-wrap items-center gap-2">
              <VoucherLink entryId={r.entry_id} voucherNo={r.voucher_no} />
              <span className="text-xs font-normal text-muted">{fmtShort(r.entry_date)}</span>
            </span>
          )}
          cardMeta={(r) => (
            <>
              {r.account_name}
              {r.contra && <span className="block">for {r.contra}</span>}
            </>
          )}
          columns={[
            {
              key: "date",
              header: "Date",
              cell: (r) => <span className="whitespace-nowrap tnum">{fmtShort(r.entry_date)}</span>,
              hideOnCard: true,
            },
            {
              key: "voucher",
              header: "Voucher",
              cell: (r) => (
                <span className="font-semibold whitespace-nowrap tnum">
                  <VoucherLink entryId={r.entry_id} voucherNo={r.voucher_no} />
                </span>
              ),
              hideOnCard: true,
            },
            {
              key: "account",
              header: "Account",
              cell: (r) => <span className="block max-w-[12rem] truncate">{r.account_name}</span>,
              hideOnCard: true,
            },
            {
              key: "for",
              header: "For",
              cell: (r) => (
                <span className="block max-w-[14rem] truncate text-muted">{r.contra}</span>
              ),
              hideOnCard: true,
            },
            {
              key: "in",
              header: "In",
              align: "right",
              cell: (r) => (
                <span className="text-ok tnum">
                  {toPaise(r.money_in) ? inr(toPaise(r.money_in)) : "—"}
                </span>
              ),
            },
            {
              key: "out",
              header: "Out",
              align: "right",
              cell: (r) => (
                <span className="text-danger tnum">
                  {toPaise(r.money_out) ? inr(toPaise(r.money_out)) : "—"}
                </span>
              ),
            },
            {
              key: "bal",
              header: "Balance",
              align: "right",
              cell: (r) => <span className="font-semibold tnum">{inr(toPaise(r.running))}</span>,
            },
          ]}
          footer={
            <tr className="border-t-2 border-navy bg-canvas font-bold text-navy">
              <td className="px-3 py-2" colSpan={4}>
                Total
              </td>
              <td className="px-3 py-2 text-right tnum">{inr(totalIn)}</td>
              <td className="px-3 py-2 text-right tnum">{inr(totalOut)}</td>
              <td className="px-3 py-2 text-right tnum">{inr(closing)}</td>
            </tr>
          }
          cardFooter={
            <div className="space-y-1 font-bold text-navy">
              <div className="flex justify-between gap-3 text-sm">
                <span>Total in</span>
                <span className="tnum">{inr(totalIn)}</span>
              </div>
              <div className="flex justify-between gap-3 text-sm">
                <span>Total out</span>
                <span className="tnum">{inr(totalOut)}</span>
              </div>
              <div className="flex justify-between gap-3 border-t border-navy/20 pt-1 text-sm">
                <span>Closing balance</span>
                <span className="tnum">{inr(closing)}</span>
              </div>
            </div>
          }
        />
      )}
    </ReportShell>
  );
}
