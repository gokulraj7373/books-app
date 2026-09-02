import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCompany } from "../company/CompanyProvider";
import { accountBalances, profitAndLoss } from "../../lib/reports";
import { inr } from "../../lib/money";
import { Alert, Card, Skeleton } from "../../components/ui";
import { PrintBar } from "./ReportHub";
import { ReportShell, Row } from "./ReportShell";

export function ProfitAndLoss({ unified }: { unified?: boolean } = {}) {
  const { company, activeBookId, managementBook } = useCompany();
  const [from, setFrom] = useState("2026-04-01");
  const [to, setTo] = useState("2027-03-31");
  const bookId = unified ? managementBook?.id : activeBookId;

  const q = useQuery({
    queryKey: ["balances", company?.id, bookId, to, from, unified ?? false],
    queryFn: () => accountBalances(company!.id, bookId!, to, from, !unified),
    enabled: !!company && !!bookId,
  });

  if (!company) return <p className="text-sm text-muted">Create a company first.</p>;
  const pl = profitAndLoss(q.data ?? []);

  return (
    <ReportShell
      title={unified ? "Profit & loss — unified" : "Profit &amp; loss"}
      subtitle={
        unified
          ? "income and expenses, official and internal together"
          : "income and expenses for the period"
      }
      from={from}
      to={to}
      onFrom={setFrom}
      onTo={setTo}
      unified={unified}
    >
     <PrintBar title="Profit & loss" />
      {q.isLoading ? (
        <Skeleton rows={6} />
      ) : (
        <>
          <Card className="overflow-hidden py-2">
            <p className="px-4 pt-2 pb-1 text-xs font-bold tracking-wide text-muted uppercase">Income</p>
            {pl.income.length === 0 ? (
              <Row label="No income recorded in this period" value="—" indent />
            ) : (
              pl.income.map((l) => <Row key={l.label} label={l.label} value={inr(l.paise)} indent />)
            )}
            <Row label="Total income" value={inr(pl.totalIncome)} bold rule />

            <p className="px-4 pt-4 pb-1 text-xs font-bold tracking-wide text-muted uppercase">Expenses</p>
            {pl.expenses.length === 0 ? (
              <Row label="No expenses recorded in this period" value="—" indent />
            ) : (
              pl.expenses.map((l) => <Row key={l.label} label={l.label} value={inr(l.paise)} indent />)
            )}
            <Row label="Total expenses" value={inr(pl.totalExpense)} bold rule />

            <div className="mt-2 border-t-2 border-navy bg-canvas">
              <Row
                label={pl.profit >= 0 ? "Net profit" : "Net loss"}
                value={inr(Math.abs(pl.profit))}
                bold
              />
            </div>
          </Card>

          {pl.totalIncome === 0 && (
            <Alert tone="info" title="Why capital spending is not here">
              Money spent on building, fit-out, equipment, deposits and supplier advances is an{" "}
              <strong>asset</strong>, not a cost — it appears on the balance sheet and only reaches
              this statement later, as depreciation. A pre-revenue business showing a small loss here
              while spending lakhs on construction is correct, not a mistake. This is the single
              thing Tally and Zoho most often mislead a construction-phase business about.
            </Alert>
          )}
        </>
      )}
    </ReportShell>
  );
}
