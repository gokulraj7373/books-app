import { createContext, useContext, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCompany } from "../company/CompanyProvider";
import { entryDetail } from "../../lib/queries";
import { inr, toPaise } from "../../lib/money";
import { Alert, Badge, Button, Sheet, Skeleton } from "../../components/ui";
import { FixEntry } from "./FixEntry";
import { PartyLink } from "../parties/PartyLink";
import { billProofUrl, isStoredProofPath } from "../../lib/billProof";
import { errorMessage } from "../../lib/errors";

/* ============================================================================
   The voucher overlay.

   One card, reachable from everywhere a voucher number is shown — the entries
   list, the general ledger, the cash book, a party statement, a bill, the
   activity log. Click it, see everything the voucher says, and fix it from the
   same place if it needs fixing. The fix runs through the exact same
   amend/reverse/void functions used everywhere else in the app, so a
   correction made here shows up identically in every report and in the
   activity log — there is only one way to change a posted entry, this is just
   another door into it.
   ========================================================================= */

type Ctx = { openVoucher: (entryId: string) => void };
const VoucherCtx = createContext<Ctx>({ openVoucher: () => {} });

export function useVoucherOverlay() {
  return useContext(VoucherCtx);
}

export function VoucherOverlayProvider({ children }: { children: ReactNode }) {
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <VoucherCtx.Provider value={{ openVoucher: setOpenId }}>
      {children}
      <Sheet open={!!openId} onClose={() => setOpenId(null)}>
        {openId && (
          <VoucherCard
            entryId={openId}
            onClose={() => setOpenId(null)}
            onNavigate={(id) => setOpenId(id)}
          />
        )}
      </Sheet>
    </VoucherCtx.Provider>
  );
}

/** A clickable voucher number. Drop this in wherever one is displayed. */
export function VoucherLink({ entryId, voucherNo }: { entryId: string; voucherNo: string }) {
  const { openVoucher } = useVoucherOverlay();
  return (
    <button
      type="button"
      onClick={() => openVoucher(entryId)}
      className="font-semibold text-navy underline-offset-2 hover:underline"
      title="See the full voucher"
    >
      {voucherNo}
    </button>
  );
}

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

function VoucherCard({
  entryId,
  onClose,
  onNavigate,
}: {
  entryId: string;
  onClose: () => void;
  onNavigate: (id: string) => void;
}) {
  const { can } = useCompany();
  const [fixing, setFixing] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["entry-detail", entryId],
    queryFn: () => entryDetail(entryId),
  });

  if (q.isLoading) {
    return (
      <div className="p-5">
        <Skeleton rows={5} />
      </div>
    );
  }
  const d = q.data;
  if (!d) {
    return (
      <div className="space-y-3 p-5">
        <Alert tone="danger">
          This voucher could not be found — it may belong to a company you no longer have open.
        </Alert>
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </div>
    );
  }

  if (fixing) {
    return (
      <FixEntry
        entryId={d.id}
        voucherNo={d.voucher_no}
        narration={d.narration}
        onClose={() => setFixing(false)}
        onDone={(message) => setNote(message)}
      />
    );
  }

  const canFix =
    d.status === "posted" && !d.reversed_by_entry_id && !d.reverses_entry_id && can("reverse_entry");

  return (
    <div className="space-y-4 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-lg font-extrabold text-navy">{d.voucher_no}</p>
            <Badge tone={d.book_kind === "adjustment" ? "warn" : "neutral"}>{d.book_name}</Badge>
            {d.status === "void" ? (
              <Badge tone="danger">Removed</Badge>
            ) : d.status === "draft" ? (
              <Badge tone="warn">Draft</Badge>
            ) : d.reversed_by_entry_id ? (
              <Badge tone="danger">Cancelled</Badge>
            ) : d.reverses_entry_id ? (
              <Badge tone="neutral">Correction</Badge>
            ) : (
              <Badge tone="ok">Posted</Badge>
            )}
          </div>
          <p className="mt-0.5 text-sm text-muted">
            {TYPE_LABEL[d.voucher_type] ?? d.voucher_type} ·{" "}
            {new Date(d.entry_date + "T00:00:00").toLocaleDateString("en-IN", {
              day: "2-digit",
              month: "short",
              year: "numeric",
            })}
          </p>
        </div>
        <button
          aria-label="Close"
          onClick={onClose}
          className="shrink-0 rounded-lg px-2 py-1 text-xl leading-none text-muted hover:bg-canvas hover:text-ink"
        >
          ×
        </button>
      </div>

      {note && <Alert tone="ok">{note}</Alert>}

      <p className="text-sm text-ink">{d.narration}</p>

      {(d.reverses_voucher_no || d.reversed_by_voucher_no) && (
        <div className="space-y-1 rounded-xl border border-line bg-canvas p-3 text-sm">
          {d.reverses_voucher_no && (
            <button
              onClick={() => d.reverses_entry_id && onNavigate(d.reverses_entry_id)}
              className="block text-navy underline-offset-2 hover:underline"
            >
              ← cancels {d.reverses_voucher_no}
            </button>
          )}
          {d.reversed_by_voucher_no && (
            <button
              onClick={() => d.reversed_by_entry_id && onNavigate(d.reversed_by_entry_id)}
              className="block text-navy underline-offset-2 hover:underline"
            >
              → replaced by {d.reversed_by_voucher_no}
            </button>
          )}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-line">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-canvas text-xs tracking-wide text-muted uppercase">
              <th className="px-3 py-2 text-left font-bold">Account</th>
              <th className="px-3 py-2 text-right font-bold">Debit</th>
              <th className="px-3 py-2 text-right font-bold">Credit</th>
            </tr>
          </thead>
          <tbody>
            {d.lines.map((l, i) => (
              <tr key={i} className="border-t border-line">
                <td className="px-3 py-2">
                  <span className="block font-medium text-ink">
                    {l.account_code} · {l.account_name}
                  </span>
                  {l.party_name && (
                    <span className="block text-xs text-muted">
                      <PartyLink partyId={l.party_id} name={l.party_name} />
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-right tnum">
                  {Number(l.debit) ? inr(toPaise(l.debit)) : "—"}
                </td>
                <td className="px-3 py-2 text-right tnum">
                  {Number(l.credit) ? inr(toPaise(l.credit)) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
        {d.party_name && (
          <>
            <span className="text-muted">Party</span>
            <span className="text-right font-medium text-ink">
              <PartyLink partyId={d.party_id} name={d.party_name} />
            </span>
          </>
        )}
        {d.payment_mode && (
          <>
            <span className="text-muted">Paid by</span>
            <span className="text-right font-medium text-ink">{d.payment_mode}</span>
          </>
        )}
        {d.reference_no && (
          <>
            <span className="text-muted">Reference</span>
            <span className="text-right font-medium text-ink">{d.reference_no}</span>
          </>
        )}
        {d.due_date && (
          <>
            <span className="text-muted">Due</span>
            <span className="text-right font-medium text-ink">
              {new Date(d.due_date + "T00:00:00").toLocaleDateString("en-IN", {
                day: "2-digit",
                month: "short",
                year: "numeric",
              })}
            </span>
          </>
        )}
        {d.created_by_name && (
          <>
            <span className="text-muted">Recorded by</span>
            <span className="text-right font-medium text-ink">{d.created_by_name}</span>
          </>
        )}
      </div>

      {d.proof_url && <ProofLink path={d.proof_url} />}

      <div className="flex flex-wrap gap-2 border-t border-line pt-3">
        {canFix && (
          <Button variant="secondary" onClick={() => setFixing(true)}>
            Fix this entry
          </Button>
        )}
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}

/** An uploaded file needs a freshly-signed URL each time; a pasted Drive link
    just opens as-is. Either way the click itself decides which, rather than
    trying to pre-resolve on every voucher the overlay ever renders. */
function ProofLink({ path }: { path: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stored = isStoredProofPath(path);

  if (!stored) {
    return (
      <a
        href={path}
        target="_blank"
        rel="noreferrer"
        className="block rounded-xl border border-line bg-canvas px-3 py-2 text-sm font-semibold text-navy hover:bg-card"
      >
        View attached bill / proof ↗
      </a>
    );
  }

  return (
    <div>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const url = await billProofUrl(path);
            window.open(url, "_blank", "noopener,noreferrer");
          } catch (err) {
            setError(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
        className="block w-full rounded-xl border border-line bg-canvas px-3 py-2 text-left text-sm font-semibold text-navy hover:bg-card disabled:opacity-50"
      >
        {busy ? "Opening…" : "View attached bill / proof ↗"}
      </button>
      {error && <p className="mt-1 text-xs font-semibold text-danger">{error}</p>}
    </div>
  );
}
