import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCompany } from "../company/CompanyProvider";
import { accountBalances, balanceSheet } from "../../lib/reports";
import { inr } from "../../lib/money";
import { Card, Skeleton } from "../../components/ui";
import { PrintBar } from "./ReportHub";
import { ReportShell, Row, TallyBanner } from "./ReportShell";

export function BalanceSheet({ unified }: { unified?: boolean } = {}) {
  const { company, activeBookId, managementBook } = useCompany();
  const [asOn, setAsOn] = useState("2027-03-31");
  const bookId = unified ? managementBook?.id : activeBookId;

  const q = useQuery({
    queryKey: ["balances", company?.id, bookId, asOn, unified ?? false],
    queryFn: () => accountBalances(company!.id, bookId!, asOn, undefined, !unified),
    enabled: !!company && !!bookId,
  });

  if (!company) return <p className="text-sm text-muted">Create a company first.</p>;
  const bs = balanceSheet(q.data ?? []);
  const any = (q.data ?? []).length > 0;

  return (
    <ReportShell
      title={unified ? "Balance sheet — unified" : "Balance sheet"}
      subtitle={
        unified
          ? "what the business owns, official and internal together"
          : "what the business owns, and who funded it"
      }
      to={asOn}
      onTo={setAsOn}
      singleDate
      unified={unified}
      banner={
        any ? (
          <TallyBanner
            tallies={bs.tallies}
            left={`Total assets ${inr(bs.totalAssets)}`}
            right={`equity and liabilities ${inr(bs.totalEquityAndLiabilities)}`}
          />
        ) : undefined
      }
    >
     <PrintBar title="Balance sheet" />
      {q.isLoading ? (
        <Skeleton rows={8} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <Card className="overflow-hidden py-2">
            <p className="px-4 pt-2 pb-1 text-xs font-bold tracking-wide text-muted uppercase">Assets</p>
            {bs.assets.length === 0 ? (
              <Row label="Nothing recorded yet" value="—" indent />
            ) : (
              bs.assets.map((l) => <Row key={l.label} label={l.label} value={inr(l.paise)} indent />)
            )}
            <div className="mt-1 border-t-2 border-navy bg-canvas">
              <Row label="Total assets" value={inr(bs.totalAssets)} bold />
            </div>
          </Card>

          <Card className="overflow-hidden py-2">
            <p className="px-4 pt-2 pb-1 text-xs font-bold tracking-wide text-muted uppercase">
              Equity &amp; liabilities
            </p>
            {bs.equity.map((l) => (
              <Row key={l.label} label={l.label} value={inr(l.paise)} indent />
            ))}
            <Row
              label={bs.profit >= 0 ? "Accumulated profit" : "Accumulated loss"}
              value={inr(bs.profit)}
              indent
            />
            {bs.liabilities.map((l) => (
              <Row key={l.label} label={l.label} value={inr(l.paise)} indent />
            ))}
            {bs.equity.length === 0 && bs.liabilities.length === 0 && bs.profit === 0 && (
              <Row label="Nothing recorded yet" value="—" indent />
            )}
            <div className="mt-1 border-t-2 border-navy bg-canvas">
              <Row label="Total equity &amp; liabilities" value={inr(bs.totalEquityAndLiabilities)} bold />
            </div>
          </Card>
        </div>
      )}
    </ReportShell>
  );
}
