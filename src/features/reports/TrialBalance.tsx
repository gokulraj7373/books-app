import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCompany } from "../company/CompanyProvider";
import { accountBalances, trialBalanceTotals } from "../../lib/reports";
import { inr, toPaise } from "../../lib/money";
import { Card, DataTable, EmptyState, Skeleton } from "../../components/ui";
import { PrintBar } from "./ReportHub";
import { ReportShell, TallyBanner } from "./ReportShell";

export function TrialBalance({ unified }: { unified?: boolean } = {}) {
  const { company, activeBookId, managementBook } = useCompany();
  const [asOn, setAsOn] = useState("2027-03-31");
  // Unified always reads the management book, merged with official — it does
  // not follow the header toggle, because it is meant to be checkable
  // regardless of which mode you happen to be recording in right now.
  const bookId = unified ? managementBook?.id : activeBookId;

  const q = useQuery({
    queryKey: ["balances", company?.id, bookId, asOn, unified ?? false],
    queryFn: () => accountBalances(company!.id, bookId!, asOn, undefined, !unified),
    enabled: !!company && !!bookId,
  });

  if (!company) return <p className="text-sm text-muted">Create a company first.</p>;

  const rows = (q.data ?? []).filter(
    (r) => toPaise(r.closing_debit) !== 0 || toPaise(r.closing_credit) !== 0,
  );
  const totals = trialBalanceTotals(q.data ?? []);

  return (
    <ReportShell
      title="Trial balance"
      subtitle="every account, and the proof that debits equal credits"
      to={asOn}
      onTo={setAsOn}
      singleDate
      unified={unified}
      banner={
        rows.length > 0 ? (
          <TallyBanner
            tallies={totals.tallies}
            left={`Total debits ${inr(totals.dr)}`}
            right={`total credits ${inr(totals.cr)}`}
          />
        ) : undefined
      }
    >
     <PrintBar title="Trial balance" />
      {q.isLoading ? (
        <Skeleton rows={8} />
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            icon="≡"
            title="Nothing to show yet"
            body="Post your first entry and every account it touches will appear here."
          />
        </Card>
      ) : (
        <DataTable
          rows={rows}
          rowKey={(r) => r.account_id}
          minWidth="36rem"
          cardTitle={(r) => (
            <span>
              <span className="text-muted tnum">{r.code}</span> {r.name}
            </span>
          )}
          columns={[
            {
              key: "code",
              header: "Code",
              cell: (r) => <span className="font-semibold text-muted tnum">{r.code}</span>,
              hideOnCard: true,
            },
            { key: "name", header: "Account", cell: (r) => r.name, hideOnCard: true },
            {
              key: "dr",
              header: "Debit",
              align: "right",
              cell: (r) => (
                <span className="tnum">
                  {toPaise(r.closing_debit) ? inr(toPaise(r.closing_debit)) : "—"}
                </span>
              ),
            },
            {
              key: "cr",
              header: "Credit",
              align: "right",
              cell: (r) => (
                <span className="tnum">
                  {toPaise(r.closing_credit) ? inr(toPaise(r.closing_credit)) : "—"}
                </span>
              ),
            },
          ]}
          footer={
            <tr className="border-t-2 border-navy bg-canvas font-bold text-navy">
              <td className="px-3 py-2" colSpan={2}>
                Total
              </td>
              <td className="px-3 py-2 text-right tnum">{inr(totals.dr)}</td>
              <td className="px-3 py-2 text-right tnum">{inr(totals.cr)}</td>
            </tr>
          }
          cardFooter={
            <div className="flex items-baseline justify-between gap-3 font-bold text-navy">
              <span className="text-sm">Total</span>
              <span className="text-sm tnum">
                Dr {inr(totals.dr)} · Cr {inr(totals.cr)}
              </span>
            </div>
          }
        />
      )}
    </ReportShell>
  );
}
