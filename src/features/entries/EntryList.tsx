import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useCompany } from "../company/CompanyProvider";
import { listEntries, type JournalEntry } from "../../lib/queries";
import { Badge, Button, Card, DataTable, EmptyState, Sheet, Skeleton } from "../../components/ui";
import { FixEntry } from "./FixEntry";
import { VoucherLink } from "./VoucherOverlay";

const TYPE_LABEL: Record<string, string> = {
  receipt: "Receipt",
  payment: "Payment",
  contra: "Contra",
  journal: "Journal",
  capitalization: "Capitalisation",
  opening: "Opening",
  closing: "Closing",
  sales: "Sales",
  purchase: "Bill",
};

const fmtDate = (iso: string) =>
  new Date(iso + "T00:00:00").toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "2-digit",
  });

/* A cancelled voucher is still posted — it stays in the ledger with its
   correction beside it, and the two cancel out. The badge reflects the
   correction link, not a status that would hide it from the reports. */
function StatusBadge({ entry }: { entry: JournalEntry }) {
  if (entry.status === "void") return <Badge tone="danger">Removed</Badge>;
  if (entry.status === "draft") return <Badge tone="warn">Draft</Badge>;
  if (entry.reversed_by_entry_id) return <Badge tone="danger">Cancelled</Badge>;
  if (entry.reverses_entry_id) return <Badge tone="neutral">Correction</Badge>;
  return <Badge tone="ok">Posted</Badge>;
}

/* Corrections read as unrelated rows unless the pair is spelled out — this is
   what turns "PA-007 looks like a random duplicate" into "cancels PA-001". */
function CorrectionNote({
  entry,
  voucherById,
}: {
  entry: JournalEntry;
  voucherById: Record<string, string>;
}) {
  if (entry.reversed_by_entry_id)
    return (
      <span className="block text-xs text-muted">
        → replaced by {voucherById[entry.reversed_by_entry_id] ?? "a later entry"}
      </span>
    );
  if (entry.reverses_entry_id)
    return (
      <span className="block text-xs text-muted">
        cancels {voucherById[entry.reverses_entry_id] ?? "an earlier entry"}
      </span>
    );
  return null;
}

export function EntryList() {
  const { company, books, can, activeBookId, internalMode } = useCompany();
  const [fixingId, setFixingId] = useState<string | null>(null);
  // Matches what the reports show for the same mode:
  //   Official   -> statutory entries only
  //   Management -> statutory PLUS internal, because the management view is a
  //                 layer over the official books, not a separate ledger
  // Listing both while the header said "Official" was the single most confusing
  // thing in the app: the screen and the mode indicator disagreed.
  const scope = internalMode ? undefined : (activeBookId ?? undefined);
  const q = useQuery({
    queryKey: ["entries", company?.id, internalMode ? "all" : activeBookId],
    queryFn: () => listEntries(company!.id, scope),
    enabled: !!company && !!activeBookId,
  });

  if (!company) return <p className="text-sm text-muted">Create a company first.</p>;
  if (q.isLoading) return <Skeleton rows={6} />;

  const entries = q.data ?? [];
  const bookById = Object.fromEntries(books.map((b) => [b.id, b]));
  const voucherById = Object.fromEntries(entries.map((e) => [e.id, e.voucher_no]));
  const fixingEntry = entries.find((e) => e.id === fixingId) ?? null;

  if (entries.length === 0) {
    return (
      <Card>
        <EmptyState
          icon="≡"
          title="No entries yet"
          body={
            internalMode
              ? "Nothing has been recorded in either book yet."
              : "Nothing has been recorded in the official books yet. If you have been working in the internal book, switch with the toggle at the top of the screen."
          }
          action={
            <Link to="/entry/new">
              <Button>New voucher</Button>
            </Link>
          }
        />
      </Card>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-extrabold text-navy">Entries</h1>
          <p className="mt-0.5 text-sm text-muted">
            {internalMode
              ? "Management view — official entries and internal ones together"
              : "Official books only — internal entries are hidden"}
            {" · "}
            {entries.length} shown
          </p>
        </div>
        <Link to="/entry/new">
          <Button>New voucher</Button>
        </Link>
      </div>

      {/* Over the screen, not pushed in above the table. Fixing an entry is a
          task you finish and leave — it should not move everything else down
          the page while you do it. */}
      <Sheet open={!!fixingEntry} onClose={() => setFixingId(null)}>
        {fixingEntry && (
          <FixEntry
            entryId={fixingEntry.id}
            voucherNo={fixingEntry.voucher_no}
            narration={fixingEntry.narration}
            onClose={() => setFixingId(null)}
          />
        )}
      </Sheet>

      <DataTable
        rows={entries}
        rowKey={(e) => e.id}
        minWidth="44rem"
        cardTitle={(e) => (
          <span className="flex flex-wrap items-center gap-2">
            <VoucherLink entryId={e.id} voucherNo={e.voucher_no} />
            <StatusBadge entry={e} />
          </span>
        )}
        cardMeta={(e) => (
          <>
            {fmtDate(e.entry_date)} · {TYPE_LABEL[e.voucher_type] ?? e.voucher_type}
            <span className="block">{e.narration}</span>
            <CorrectionNote entry={e} voucherById={voucherById} />
          </>
        )}
        columns={[
          {
            key: "date",
            header: "Date",
            cell: (e) => <span className="whitespace-nowrap tnum">{fmtDate(e.entry_date)}</span>,
            hideOnCard: true,
          },
          {
            key: "voucher",
            header: "Voucher",
            cell: (e) => (
              /* Click the voucher number anywhere in the app and the same
                 full-detail overlay opens — this is that "anywhere". */
              <span className="font-semibold whitespace-nowrap tnum">
                <VoucherLink entryId={e.id} voucherNo={e.voucher_no} />
              </span>
            ),
            hideOnCard: true,
          },
          {
            key: "type",
            header: "Type",
            cell: (e) => (
              <span className="whitespace-nowrap text-muted">
                {TYPE_LABEL[e.voucher_type] ?? e.voucher_type}
              </span>
            ),
            hideOnCard: true,
          },
          {
            key: "narration",
            header: "Narration",
            cell: (e) => (
              <div className="max-w-[18rem]">
                <span className="block truncate">{e.narration}</span>
                <CorrectionNote entry={e} voucherById={voucherById} />
              </div>
            ),
            hideOnCard: true,
          },
          {
            key: "book",
            header: "Book",
            cell: (e) =>
              bookById[e.book_id]?.kind === "adjustment" ? (
                <Badge tone="warn">Internal</Badge>
              ) : (
                <Badge tone="neutral">Official</Badge>
              ),
          },
          {
            key: "status",
            header: "Status",
            cell: (e) => <StatusBadge entry={e} />,
            hideOnCard: true,
          },
          {
            key: "proof",
            header: "Bill",
            cell: (e) =>
              e.proof_url ? (
                <span className="text-ok" title="Bill attached">
                  ✓ attached
                </span>
              ) : (
                <span className="text-muted/50">—</span>
              ),
          },
          {
            key: "fix",
            header: "Fix",
            cell: (e) =>
              /* Offered only where it can actually work: a posted entry that
                 has not already been cancelled, and is not itself the
                 correction of something else. */
              e.status === "posted" &&
              !e.reversed_by_entry_id &&
              !e.reverses_entry_id &&
              can("reverse_entry") ? (
                <button
                  onClick={() => setFixingId(e.id)}
                  className="rounded-lg border border-line px-2.5 py-1 text-xs font-bold text-navy hover:bg-canvas"
                >
                  Fix
                </button>
              ) : (
                <span className="text-xs text-muted/50">—</span>
              ),
          },
        ]}
      />
    </div>
  );
}
