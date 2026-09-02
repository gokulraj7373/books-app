import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useCompany } from "../company/CompanyProvider";
import { listAccounts, listEntries, verifyChain } from "../../lib/queries";
import { computeActions } from "./nextAction";
import { Badge, Button, Card, EmptyState, SectionTitle, Skeleton } from "../../components/ui";
import { AlertList } from "../../components/Alerts";

const PHASE_LABEL = {
  capex: "Building phase",
  transition: "Opening up",
  operations: "Trading",
} as const;

export function Home() {
  const { company, statutoryBook, loading, activeBookId, internalMode } = useCompany();

  const entriesQ = useQuery({
    queryKey: ["entries", company?.id, activeBookId],
    queryFn: () => listEntries(company!.id, activeBookId!),
    enabled: !!company && !!activeBookId,
  });
  const accountsQ = useQuery({
    queryKey: ["accounts", company?.id],
    queryFn: () => listAccounts(company!.id),
    enabled: !!company,
  });
  const chainQ = useQuery({
    queryKey: ["chain", company?.id, statutoryBook?.id],
    queryFn: () => verifyChain(company!.id, statutoryBook!.id),
    enabled: !!company && !!statutoryBook,
  });

  if (loading) return <Skeleton rows={4} />;

  if (!company) {
    return (
      <Card>
        <EmptyState
          icon="◆"
          title="Let's set up your company"
          body="This takes about a minute. It creates your chart of accounts, your financial year, and both your statutory and management books automatically."
          action={
            <Link to="/company/new">
              <Button>Create company</Button>
            </Link>
          }
        />
      </Card>
    );
  }

  const entries = entriesQ.data ?? [];
  const posted = entries.filter((e) => e.status === "posted");
  const actions = computeActions({
    company,
    accounts: accountsQ.data ?? [],
    entries,
    chainBrokenAtSeq: chainQ.data ?? null,
    // Same scope as the notification and the health check: only an actual
    // BILL (recorded through the Bills tab) is expected to carry paperwork.
    // Three different counts of "missing proof" on three screens is how
    // people stop believing any of them.
    entriesWithoutProof: posted.filter((e) => e.voucher_type === "purchase" && !e.proof_url).length,
  });

  const [primary, ...rest] = actions;

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-extrabold text-navy">{company.name}</h1>
          <Badge tone="gold">{PHASE_LABEL[company.lifecycle_phase]}</Badge>
          {internalMode && <Badge tone="warn">Internal book</Badge>}
        </div>
        <p className="mt-0.5 text-sm text-muted">
          Books from {new Date(company.books_start_date + "T00:00:00").toLocaleDateString("en-IN", {
            day: "2-digit",
            month: "short",
            year: "numeric",
          })}
          {" · "}
          {posted.length} posted {posted.length === 1 ? "entry" : "entries"}
        </p>
      </div>

      {/* THE point of this screen: one clear next step, never a wall of zeroes. */}
      <section>
        <SectionTitle>Do this next</SectionTitle>
        <Card className="overflow-hidden">
          <div
            className={`h-1 w-full ${
              primary.tone === "danger"
                ? "bg-danger"
                : primary.tone === "warn"
                  ? "bg-warn"
                  : primary.tone === "ok"
                    ? "bg-ok"
                    : "bg-gold"
            }`}
          />
          <div className="p-5">
            <h2 className="text-lg font-extrabold text-navy">{primary.title}</h2>
            <p className="mt-1.5 text-sm leading-relaxed text-muted">{primary.why}</p>
            <Link to={primary.href} className="mt-4 inline-block">
              <Button variant={primary.tone === "danger" ? "danger" : "primary"}>
                {primary.cta}
              </Button>
            </Link>
          </div>
        </Card>
      </section>

      <section>
        <SectionTitle>Needs your attention</SectionTitle>
        <AlertList limit={5} />
      </section>

      {rest.length > 0 && (
        <section>
          <SectionTitle>Also worth a look</SectionTitle>
          <div className="space-y-2">
            {rest.map((a) => (
              <Card key={a.id} className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold text-ink">{a.title}</p>
                    <p className="mt-0.5 text-sm text-muted">{a.why}</p>
                  </div>
                  <Link to={a.href}>
                    <Button variant="secondary">{a.cta}</Button>
                  </Link>
                </div>
              </Card>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
