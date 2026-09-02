import { useQuery } from "@tanstack/react-query";
import { useCompany } from "../company/CompanyProvider";
import { entryAuditLog, listEntries, masterAuditLog } from "../../lib/queries";
import { Alert, Badge, Card, EmptyState, Skeleton } from "../../components/ui";
import { VoucherLink } from "../entries/VoucherOverlay";

/* ============================================================================
   Activity log.

   Every correction and every removal, who did it, when, and the reason they
   gave. Nothing writes here except the actions themselves, and there is no
   delete — the table has a read policy and no other, so even an owner cannot
   quietly tidy it up.

   This is the record an auditor asks for when they want to know whether the
   books have been edited. Being able to hand it over without preparing
   anything is the point.
   ========================================================================= */

const WHAT = {
  amend: {
    label: "Corrected",
    tone: "warn" as const,
    line: "The figures were changed. The old version was cancelled and a corrected entry posted.",
  },
  void: {
    label: "Removed",
    tone: "danger" as const,
    line: "Taken out of every report. What it said is kept in this record.",
  },
};

const MASTER_LABEL: Record<string, string> = {
  account: "Account",
  party: "Name",
  investor: "Investor",
  capital_project: "Project",
  opening_balance: "Opening balances",
};

export function ActivityLog() {
  const { company } = useCompany();

  const logQ = useQuery({
    queryKey: ["audit-log", company?.id],
    queryFn: () => entryAuditLog(company!.id),
    enabled: !!company,
  });
  // So a row can name the voucher rather than a database id.
  const entriesQ = useQuery({
    queryKey: ["entries", company?.id, "all-for-log"],
    queryFn: () => listEntries(company!.id),
    enabled: !!company,
  });
  // Master-data changes — renaming an account, merging two suppliers, setting
  // opening balances. These do not touch an entry, but they absolutely change
  // what the reports say, so they belong on the same page rather than being
  // invisible.
  const masterQ = useQuery({
    queryKey: ["master-audit-log", company?.id],
    queryFn: () => masterAuditLog(company!.id),
    enabled: !!company,
  });

  if (!company) return <p className="text-sm text-muted">Create a company first.</p>;

  const rows = logQ.data ?? [];
  const masterRows = masterQ.data ?? [];
  const voucherById = Object.fromEntries(
    (entriesQ.data ?? []).map((e) => [e.id, `${e.voucher_no} · ${e.narration}`]),
  );

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div>
        <h1 className="text-xl font-extrabold text-navy">Activity log</h1>
        <p className="mt-0.5 text-sm text-muted">
          Everything that has been corrected or removed, and who did it.
        </p>
      </div>

      <Alert tone="info" title="Nobody can edit this, including you">
        Entries themselves are never altered in place — a correction posts a cancelling entry beside
        the original, and both stay in the ledger. This page is the plain-English version of that,
        plus anything removed from the reports. It is append-only: there is no way to delete a line
        from it through the app, and no way around the app.
      </Alert>

      {logQ.isLoading ? (
        <Skeleton rows={5} />
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            icon="✓"
            title="No entry has been changed"
            body="No entry in these books has been corrected or removed. That is the best possible state for this section to be in."
          />
        </Card>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => {
            const w = WHAT[r.action];
            return (
              <Card key={r.id} className="p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={w.tone}>{w.label}</Badge>
                  {voucherById[r.entry_id] ? (
                    <span className="text-sm font-bold text-ink">
                      <VoucherLink entryId={r.entry_id} voucherNo={voucherById[r.entry_id]} />
                    </span>
                  ) : (
                    <span className="text-sm font-bold text-ink">An entry</span>
                  )}
                </div>
                <p className="mt-1 text-sm text-ink">“{r.reason}”</p>
                <p className="mt-1 text-xs text-muted">{w.line}</p>
                <p className="mt-1.5 text-xs text-muted">
                  {r.acted_by_name ?? "Someone"} ·{" "}
                  {new Date(r.acted_at).toLocaleString("en-IN", {
                    day: "2-digit",
                    month: "short",
                    year: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </p>
              </Card>
            );
          })}
        </div>
      )}

      {masterRows.length > 0 && (
        <section className="pt-2">
          <h2 className="mb-1 text-sm font-bold tracking-wide text-muted uppercase">
            Changes to accounts, names and setup
          </h2>
          <p className="mb-2 text-xs text-muted">
            No entry was touched by any of these — but renaming an account or merging two suppliers
            changes what the reports say, so they are on the record too.
          </p>
          <div className="space-y-2">
            {masterRows.map((r) => (
              <Card key={r.id} className="p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={r.action === "merge" ? "warn" : "info"}>
                    {MASTER_LABEL[r.object_type] ?? r.object_type}
                  </Badge>
                  <span className="text-sm font-semibold text-ink">{r.summary}</span>
                </div>
                <p className="mt-1.5 text-xs text-muted">
                  {r.acted_by_name ?? "Someone"} ·{" "}
                  {new Date(r.acted_at).toLocaleString("en-IN", {
                    day: "2-digit",
                    month: "short",
                    year: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </p>
              </Card>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
