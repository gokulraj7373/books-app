import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useCompany } from "../company/CompanyProvider";
import { listAccounts, type Account } from "../../lib/queries";
import { accountBalances } from "../../lib/reports";
import { inr, toPaise } from "../../lib/money";
import { Alert, Badge, Button, Card, SectionTitle, Skeleton } from "../../components/ui";
import { AccountEditor, AccountRetire } from "./AccountEditor";
import { AdoptTemplate } from "./AdoptTemplate";

const TYPE_ORDER = ["asset", "liability", "equity", "income", "expense"] as const;
const TYPE_LABEL = {
  asset: "Assets",
  liability: "Liabilities",
  equity: "Equity",
  income: "Income",
  expense: "Expenses",
} as const;

/* ============================================================================
   Chart of accounts, doubling as the entry point to every individual ledger.

   Before, this was a static list — a name and a code, nothing to click, no
   balance. Every account here now shows its closing balance in the book you
   are looking at, and opens straight into its statement in the general
   ledger. This IS the "which ledger do you want" screen every accounting
   package has; it just used to stop one step short of being useful.
   ========================================================================= */
export function AccountList() {
  const { company, activeBookId, internalMode, can } = useCompany();
  // null = closed, "new" = adding, or the account being edited/retired
  const [editing, setEditing] = useState<Account | "new" | null>(null);
  const [retiring, setRetiring] = useState<Account | null>(null);
  const [adopting, setAdopting] = useState(false);
  // Retired accounts are hidden by default — the point of switching one off is
  // to get it out of the way — but never lost, so there is a way back to them.
  const [showRetired, setShowRetired] = useState(false);
  const mayEdit = can("edit_coa");

  const accountsQ = useQuery({
    queryKey: ["accounts", company?.id],
    queryFn: () => listAccounts(company!.id),
    enabled: !!company,
  });
  const balancesQ = useQuery({
    queryKey: ["balances", company?.id, activeBookId, "chart"],
    queryFn: () => accountBalances(company!.id, activeBookId!),
    enabled: !!company && !!activeBookId,
  });

  if (!company) return <p className="text-sm text-muted">Create a company first.</p>;
  if (accountsQ.isLoading) return <Skeleton rows={8} />;

  const all = accountsQ.data ?? [];
  const accounts = showRetired ? all : all.filter((a) => a.is_active);
  const retiredCount = all.filter((a) => !a.is_active).length;
  const balanceByCode = Object.fromEntries((balancesQ.data ?? []).map((b) => [b.code, b]));

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-extrabold text-navy">Chart of accounts</h1>
          <p className="mt-0.5 text-sm text-muted">
            {accounts.length} accounts. Click one to see its full ledger.{" "}
            {internalMode
              ? "Balances shown are the management view — official plus internal."
              : "Balances shown are the official books only."}
          </p>
        </div>
        {mayEdit && (
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setAdopting(true)}>
              Add a trade's accounts
            </Button>
            <Button onClick={() => setEditing("new")}>+ Add an account</Button>
          </div>
        )}
      </div>

      {retiredCount > 0 && (
        <button
          type="button"
          onClick={() => setShowRetired((v) => !v)}
          className="text-xs font-semibold text-navy underline underline-offset-2"
        >
          {showRetired
            ? "Hide switched-off accounts"
            : `Show ${retiredCount} switched-off account${retiredCount === 1 ? "" : "s"}`}
        </button>
      )}

      {!mayEdit && (
        <Alert tone="info">
          Your role can view the chart of accounts but not change it. Ask an owner or your
          accountant to add or rename one.
        </Alert>
      )}

      {editing && (
        <AccountEditor
          companyId={company.id}
          accounts={all}
          editing={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {adopting && (
        <AdoptTemplate
          companyId={company.id}
          accounts={all}
          currentIndustry={company.industry}
          onClose={() => setAdopting(false)}
        />
      )}
      {retiring && (
        <AccountRetire
          companyId={company.id}
          account={retiring}
          onClose={() => setRetiring(null)}
        />
      )}

      {TYPE_ORDER.map((type) => {
        const group = accounts.filter((a) => a.account_type === type && !a.is_group);
        if (group.length === 0) return null;
        const groupTotal = group.reduce((n, a) => {
          const b = balanceByCode[a.code];
          if (!b) return n;
          return n + (toPaise(b.closing_debit) - toPaise(b.closing_credit));
        }, 0);
        return (
          <section key={type}>
            <SectionTitle
              right={
                <span className="text-xs font-bold text-muted tnum">
                  {group.length} · {inr(Math.abs(groupTotal))} {groupTotal >= 0 ? "Dr" : "Cr"}
                </span>
              }
            >
              {TYPE_LABEL[type]}
            </SectionTitle>
            {/* A list, not a table — four columns of mostly-empty cells was
                never worth a sideways scroll on a phone. */}
            <Card className="divide-y divide-line overflow-hidden">
              {group.map((a) => {
                const b = balanceByCode[a.code];
                const net = b ? toPaise(b.closing_debit) - toPaise(b.closing_credit) : 0;
                const hasActivity = !!b && net !== 0;
                const inner = (
                  <>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="text-xs font-semibold text-muted tnum">{a.code}</span>
                        <span
                          className={`text-sm ${hasActivity ? "font-semibold text-navy" : "text-ink"}`}
                        >
                          {a.name}
                        </span>
                        {a.is_bank_or_cash && <Badge tone="info">bank/cash</Badge>}
                        {a.capex_role && <Badge tone="gold">{a.capex_role}</Badge>}
                        {!a.is_active && <Badge tone="warn">switched off</Badge>}
                        {a.is_system && <Badge>built in</Badge>}
                      </span>
                      {a.sub_group && (
                        <span className="mt-0.5 block text-xs text-muted">{a.sub_group}</span>
                      )}
                    </span>
                    <span className="shrink-0 text-right text-sm tnum">
                      {hasActivity ? (
                        <span className="font-semibold text-ink">
                          {inr(Math.abs(net))} {net >= 0 ? "Dr" : "Cr"}
                        </span>
                      ) : (
                        <span className="text-muted/50">—</span>
                      )}
                    </span>
                  </>
                );

                return (
                  <div key={a.id} className="flex items-start gap-3 px-3.5 py-2.5">
                    {hasActivity ? (
                      <Link
                        to="/reports/ledger"
                        search={{ account: a.id }}
                        className="flex min-w-0 flex-1 items-start gap-3 transition-colors duration-200 hover:text-navy"
                      >
                        {inner}
                      </Link>
                    ) : (
                      <span className="flex min-w-0 flex-1 items-start gap-3">{inner}</span>
                    )}

                    {/* A built-in account is the app's own plumbing, so it has
                        no edit affordance at all rather than a button that
                        would only ever refuse. */}
                    {mayEdit && !a.is_system && (
                      <span className="flex shrink-0 gap-2 pl-1 text-xs font-semibold">
                        <button
                          type="button"
                          onClick={() => setEditing(a)}
                          className="text-navy hover:underline"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => setRetiring(a)}
                          className="text-muted hover:text-danger hover:underline"
                        >
                          {a.is_active ? "Off" : "On"}
                        </button>
                      </span>
                    )}
                  </div>
                );
              })}
            </Card>
          </section>
        );
      })}
    </div>
  );
}
