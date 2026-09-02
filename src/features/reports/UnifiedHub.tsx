import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useCompany } from "../company/CompanyProvider";
import { investorMaster } from "../../lib/queries";
import { inr, toPaise } from "../../lib/money";
import { Alert, Badge, Card, EmptyState, SectionTitle, Skeleton } from "../../components/ui";

/* ============================================================================
   Unified — the one place both books are ever shown merged.

   Every OTHER report in the app now shows exactly one book, alone: Official
   mode reads the statutory book, Internal mode reads the management book on
   its own, with nothing mixed in. That split is what makes each of them
   trustworthy on its own terms — a report that sometimes quietly includes the
   other book and sometimes doesn't is not a report you can rely on.

   This section is the deliberate exception: the true picture across both
   books together, for the one question that genuinely spans them — "as the
   person who put money in, where does it all stand". It only appears while
   you are in Internal mode, because that is the context where cross-checking
   against the internal book actually matters; someone working purely in the
   official books has no need to stumble onto figures that include off-book
   money.
   ========================================================================= */

const REPORTS = [
  {
    to: "/unified/balance-sheet",
    name: "Balance sheet — unified",
    what: "What the business owns and owes, official and internal combined.",
  },
  {
    to: "/unified/profit-loss",
    name: "Profit & loss — unified",
    what: "Income and costs across both books together.",
  },
  {
    to: "/unified/trial-balance",
    name: "Trial balance — unified",
    what: "Every account, both books, with proof the combined figures still tally.",
  },
  {
    to: "/unified/cash-book",
    name: "Cash & bank book — unified",
    what: "Every rupee through cash and bank in either book, in date order.",
  },
];

export function UnifiedHub() {
  const { company } = useCompany();
  const investorsQ = useQuery({
    queryKey: ["investor-master", company?.id],
    queryFn: () => investorMaster(company!.id),
    enabled: !!company,
  });

  if (!company) return <p className="text-sm text-muted">Create a company first.</p>;
  const investors = investorsQ.data ?? [];
  const totalCommitted = investors.reduce((n, i) => n + toPaise(i.committed), 0);
  const totalIn = investors.reduce((n, i) => n + toPaise(i.total_in), 0);
  const totalStillToBring = investors.reduce((n, i) => n + toPaise(i.still_to_bring), 0);

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div>
        <h1 className="text-xl font-extrabold text-navy">Unified</h1>
        <p className="mt-0.5 text-sm text-muted">
          Both books merged together — the full picture for whoever put money into this business.
          Nowhere else in the app mixes the two.
        </p>
      </div>

      <Alert tone="warn" title="Not what you file">
        These figures include money that never went through the official bank. Your CA and your
        return use the Official reports only — this section exists so you, as the person tracking
        every rupee, can see the whole truth in one place.
      </Alert>

      <section>
        <SectionTitle>Investor accountability</SectionTitle>
        <Card className="p-4">
          {investorsQ.isLoading ? (
            <Skeleton rows={3} />
          ) : investors.length === 0 ? (
            <EmptyState icon="◎" title="No investors recorded yet" body="Add one from the Investors page." />
          ) : (
            <>
              <div className="grid grid-cols-3 gap-3 text-center">
                <div>
                  <p className="text-xs font-bold tracking-wide text-muted uppercase">Committed</p>
                  <p className="mt-1 text-lg font-extrabold text-navy tnum">{inr(totalCommitted)}</p>
                </div>
                <div>
                  <p className="text-xs font-bold tracking-wide text-muted uppercase">Brought in</p>
                  <p className="mt-1 text-lg font-extrabold text-ok tnum">{inr(totalIn)}</p>
                </div>
                <div>
                  <p className="text-xs font-bold tracking-wide text-muted uppercase">Still to come</p>
                  <p className="mt-1 text-lg font-extrabold text-warn tnum">{inr(totalStillToBring)}</p>
                </div>
              </div>
              <p className="mt-3 text-xs text-muted">
                This total already spans both books — commitments are fulfilled from whichever one the
                money actually arrived in. See the per-investor split on{" "}
                <Link to="/investors" className="font-semibold text-navy underline underline-offset-2">
                  the Investors page
                </Link>
                .
              </p>
            </>
          )}
        </Card>
      </section>

      <section>
        <SectionTitle>Merged statements</SectionTitle>
        <div className="space-y-2">
          {REPORTS.map((r) => (
            <Link
              key={r.to}
              to={r.to}
              className="block rounded-2xl border border-line bg-card p-4 shadow-sm transition-[border-color,transform] duration-200 hover:border-navy active:scale-[0.99]"
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-ink">{r.name}</span>
                <Badge tone="warn">merged</Badge>
              </div>
              <p className="mt-1 text-sm text-muted">{r.what}</p>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
