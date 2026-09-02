import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCompany } from "../company/CompanyProvider";
import { listAccounts } from "../../lib/queries";
import { accountBalances, generalLedger } from "../../lib/reports";
import { inr, toPaise } from "../../lib/money";
import { Badge, Card, DataTable, EmptyState, Field, inputClass, Skeleton } from "../../components/ui";
import { PrintBar } from "./ReportHub";
import { ReportShell } from "./ReportShell";
import { VoucherLink } from "../entries/VoucherOverlay";

const fmtShort = (iso: string) =>
  new Date(iso + "T00:00:00").toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "2-digit",
  });

export function GeneralLedger() {
  const { company, activeBookId } = useCompany();
  const [from, setFrom] = useState("2026-04-01");
  const [to, setTo] = useState("2027-03-31");
  // Arriving from "Chart of accounts" with a specific account already chosen
  // (?account=<id>) is what makes that screen a real ledger, not just a list.
  const [accountId, setAccountId] = useState(
    () => new URLSearchParams(window.location.search).get("account") ?? "",
  );

  const accountsQ = useQuery({
    queryKey: ["accounts", company?.id],
    queryFn: () => listAccounts(company!.id),
    enabled: !!company,
  });
  const accounts = (accountsQ.data ?? []).filter((a) => !a.is_group);

  // Which accounts have actually been used in the book you are looking at.
  // Opening on "1020 Cash in Hand" and reporting "no postings" — while the
  // money sits in 1090 — is a dead end that looks like lost data.
  const balancesQ = useQuery({
    queryKey: ["balances", company?.id, activeBookId, "gl-picker"],
    queryFn: () => accountBalances(company!.id, activeBookId!),
    enabled: !!company && !!activeBookId,
  });
  const usedCodes = new Set(
    (balancesQ.data ?? [])
      .filter((b) => toPaise(b.closing_debit) !== 0 || toPaise(b.closing_credit) !== 0)
      .map((b) => b.code),
  );
  const used = accounts.filter((a) => usedCodes.has(a.code));
  const unused = accounts.filter((a) => !usedCodes.has(a.code));

  const selected = accountId || used[0]?.id || accounts[0]?.id || "";

  const q = useQuery({
    queryKey: ["gl", company?.id, activeBookId, selected, from, to],
    queryFn: () => generalLedger(company!.id, activeBookId!, selected, from, to),
    enabled: !!company && !!activeBookId && !!selected,
  });

  if (!company) return <p className="text-sm text-muted">Create a company first.</p>;
  const rows = q.data ?? [];
  const closing = rows.length ? toPaise(rows[rows.length - 1].running) : 0;

  return (
    <ReportShell
      title="General ledger"
      subtitle="every posting to one account, with a running balance"
      from={from}
      to={to}
      onFrom={setFrom}
      onTo={setTo}
    >
      <PrintBar title="General ledger" />
      <Card className="p-4">
        <Field
          label="Account"
          hint={
            used.length
              ? `${used.length} ${used.length === 1 ? "account has" : "accounts have"} postings in this book`
              : undefined
          }
        >
          <select className={inputClass} value={selected} onChange={(e) => setAccountId(e.target.value)}>
            {used.length > 0 && (
              <optgroup label="Accounts with postings">
                {used.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} · {a.name}
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup label="Everything else (no postings yet)">
              {unused.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} · {a.name}
                </option>
              ))}
            </optgroup>
          </select>
        </Field>
      </Card>

      {q.isLoading ? (
        <Skeleton rows={6} />
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            icon="≡"
            title="No postings to this account"
            body="Either nothing has been recorded against it yet, or it falls outside the date range above."
          />
        </Card>
      ) : (
        <DataTable
          rows={rows}
          rowKey={(r, i) => `${r.entry_id}-${i}`}
          minWidth="46rem"
          cardTitle={(r) => (
            <span className="flex flex-wrap items-center gap-2">
              <VoucherLink entryId={r.entry_id} voucherNo={r.voucher_no} />
              {r.book_code === "MGMT" && <Badge tone="warn">internal</Badge>}
              <span className="text-xs font-normal text-muted">{fmtShort(r.entry_date)}</span>
            </span>
          )}
          cardMeta={(r) => (
            <>
              {r.narration}
              {r.counter_accounts && <span className="block">↔ {r.counter_accounts}</span>}
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
                  {r.book_code === "MGMT" && (
                    <span className="ml-1">
                      <Badge tone="warn">M</Badge>
                    </span>
                  )}
                </span>
              ),
              hideOnCard: true,
            },
            {
              key: "narration",
              header: "Narration",
              cell: (r) => <span className="block max-w-[16rem] truncate">{r.narration}</span>,
              hideOnCard: true,
            },
            {
              key: "contra",
              header: "Contra",
              cell: (r) => (
                <span className="block max-w-[12rem] truncate text-muted">{r.counter_accounts}</span>
              ),
              hideOnCard: true,
            },
            {
              key: "dr",
              header: "Debit",
              align: "right",
              cell: (r) => (
                <span className="tnum">{toPaise(r.debit) ? inr(toPaise(r.debit)) : "—"}</span>
              ),
            },
            {
              key: "cr",
              header: "Credit",
              align: "right",
              cell: (r) => (
                <span className="tnum">{toPaise(r.credit) ? inr(toPaise(r.credit)) : "—"}</span>
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
              <td className="px-3 py-2" colSpan={6}>
                Closing balance
              </td>
              <td className="px-3 py-2 text-right tnum">
                {inr(Math.abs(closing))} {closing >= 0 ? "Dr" : "Cr"}
              </td>
            </tr>
          }
          cardFooter={
            <div className="flex items-baseline justify-between gap-3 font-bold text-navy">
              <span className="text-sm">Closing balance</span>
              <span className="text-sm tnum">
                {inr(Math.abs(closing))} {closing >= 0 ? "Dr" : "Cr"}
              </span>
            </div>
          }
        />
      )}
    </ReportShell>
  );
}
