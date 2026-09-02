import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { useCompany } from "../company/CompanyProvider";
import {
  listPartyDetails,
  partyBalances,
  partyStatement,
  type PartyDetail,
} from "../../lib/queries";
import { inr, toPaise } from "../../lib/money";
import { Badge, Button, Card, EmptyState, inputClass, Skeleton } from "../../components/ui";
import { VoucherLink } from "../entries/VoucherOverlay";
import { PartyEditor, PartyMerge } from "./PartyEditor";

const fmt = (iso: string) =>
  new Date(iso + "T00:00:00").toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "2-digit",
  });

/**
 * What Tally users call "ledgers". Every supplier, investor and contractor you
 * have ever entered, with what they owe you or you owe them, and a full
 * statement per party.
 */
/**
 * What Tally calls the "party ledger" and Zoho calls "contacts" — every
 * supplier, investor and contractor you have ever recorded money against,
 * picked by name, with the full trail of what moved and the running balance.
 * The Chart of Accounts is the same idea for ACCOUNTS; this is it for PEOPLE
 * and BUSINESSES.
 */
export function Parties() {
  const { company, activeBookId, internalMode, can } = useCompany();
  // Arriving from a voucher, a bill or the ageing list opens that party
  // straight away, rather than dropping you on a list to hunt through.
  // `strict: false` because no route here declares a search schema.
  const routeSearch = useSearch({ strict: false }) as { party?: string };
  const [openId, setOpenId] = useState<string | null>(routeSearch.party ?? null);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<PartyDetail | null>(null);
  const [merging, setMerging] = useState(false);
  const mayEdit = can("edit_coa");

  const q = useQuery({
    queryKey: ["party-balances", company?.id, activeBookId],
    queryFn: () => partyBalances(company!.id, activeBookId!),
    enabled: !!company && !!activeBookId,
  });

  // The contact and tax details, which the balances RPC does not carry.
  const detailsQ = useQuery({
    queryKey: ["party-details", company?.id],
    queryFn: () => listPartyDetails(company!.id),
    enabled: !!company,
  });
  const detailById = Object.fromEntries((detailsQ.data ?? []).map((d) => [d.id, d]));

  if (!company) return <p className="text-sm text-muted">Create a company first.</p>;

  const needle = search.trim().toLowerCase();
  const parties = (q.data ?? []).filter((p) => !needle || p.name.toLowerCase().includes(needle));
  const owedToUs = parties.filter((p) => toPaise(p.balance) > 0);
  const weOwe = parties.filter((p) => toPaise(p.balance) < 0);
  const settled = parties.filter((p) => toPaise(p.balance) === 0);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-extrabold text-navy">Party ledger</h1>
          <p className="mt-0.5 text-sm text-muted">
            Every supplier, investor and contractor you have recorded money against. Pick a name to
            see everything that has moved with them, in order, with a running balance.{" "}
            {internalMode
              ? "Showing the internal book only."
              : "Showing the official books only."}
          </p>
        </div>
        {mayEdit && (q.data ?? []).length > 1 && (
          <Button variant="secondary" onClick={() => setMerging(true)} className="shrink-0">
            Merge duplicates
          </Button>
        )}
      </div>

      {editing && (
        <PartyEditor party={editing} onClose={() => setEditing(null)} />
      )}
      {merging && <PartyMerge companyId={company.id} onClose={() => setMerging(false)} />}

      {(q.data ?? []).length > 5 && (
        <input
          className={inputClass}
          placeholder="Search by name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      )}

      {q.isLoading ? (
        <Skeleton rows={5} />
      ) : (q.data ?? []).length === 0 ? (
        <Card>
          <EmptyState
            icon="◇"
            title="No parties yet"
            body="Record a payment to a supplier or money from an investor, and they will appear here with a full statement."
          />
        </Card>
      ) : parties.length === 0 ? (
        <Card>
          <EmptyState icon="◇" title={`Nobody matches "${search}"`} body="Try a different spelling." />
        </Card>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Card className="p-4">
              <p className="text-xs font-bold tracking-wide text-muted uppercase">They owe us</p>
              <p className="mt-1 text-2xl font-extrabold text-ok tnum">
                {inr(owedToUs.reduce((n, p) => n + toPaise(p.balance), 0))}
              </p>
              <p className="mt-0.5 text-xs text-muted">
                advances paid out, and money recoverable
              </p>
            </Card>
            <Card className="p-4">
              <p className="text-xs font-bold tracking-wide text-muted uppercase">We owe them</p>
              <p className="mt-1 text-2xl font-extrabold text-danger tnum">
                {inr(Math.abs(weOwe.reduce((n, p) => n + toPaise(p.balance), 0)))}
              </p>
              <p className="mt-0.5 text-xs text-muted">unpaid bills and investor capital</p>
            </Card>
          </div>

          {[
            { title: "They owe us", rows: owedToUs },
            { title: "We owe them", rows: weOwe },
            { title: "Settled", rows: settled },
          ]
            .filter((g) => g.rows.length > 0)
            .map((g) => (
              <section key={g.title}>
                <h2 className="mb-2 text-sm font-bold tracking-wide text-muted uppercase">
                  {g.title}
                </h2>
                <div className="space-y-2">
                  {g.rows.map((p) => (
                    <Card key={p.party_id} className="overflow-hidden">
                      <button
                        type="button"
                        onClick={() => setOpenId(openId === p.party_id ? null : p.party_id)}
                        className="flex w-full items-center justify-between gap-3 p-4 text-left transition-colors duration-200 hover:bg-canvas"
                      >
                        <span className="min-w-0">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-bold text-ink">{p.name}</span>
                            {p.party_type && <Badge>{p.party_type}</Badge>}
                            {p.is_related_party && <Badge tone="warn">related party</Badge>}
                            {detailById[p.party_id]?.gstin && <Badge tone="info">GSTIN</Badge>}
                            {detailById[p.party_id]?.is_active === false && (
                              <Badge tone="warn">no longer dealt with</Badge>
                            )}
                          </span>
                          <span className="mt-0.5 block text-xs text-muted">
                            {p.entry_count} {p.entry_count === 1 ? "entry" : "entries"}
                            {p.last_activity && ` · last ${fmt(p.last_activity)}`}
                          </span>
                        </span>
                        <span
                          className={`shrink-0 text-sm font-bold tnum ${
                            toPaise(p.balance) > 0
                              ? "text-ok"
                              : toPaise(p.balance) < 0
                                ? "text-danger"
                                : "text-muted"
                          }`}
                        >
                          {inr(Math.abs(toPaise(p.balance)))}
                        </span>
                      </button>
                      {openId === p.party_id && (
                        <>
                          {mayEdit && detailById[p.party_id] && (
                            <div className="flex flex-wrap items-center gap-3 border-t border-line bg-canvas px-4 py-2">
                              <button
                                type="button"
                                onClick={() => setEditing(detailById[p.party_id])}
                                className="text-xs font-semibold text-navy hover:underline"
                              >
                                Edit details
                              </button>
                              {!detailById[p.party_id].gstin && (
                                <span className="text-xs text-muted">
                                  No GSTIN on record — needed to claim input credit on their bills.
                                </span>
                              )}
                            </div>
                          )}
                          <Statement
                            companyId={company.id}
                            partyId={p.party_id}
                            bookId={activeBookId!}
                          />
                        </>
                      )}
                    </Card>
                  ))}
                </div>
              </section>
            ))}
        </>
      )}
    </div>
  );
}

function Statement({
  companyId,
  partyId,
  bookId,
}: {
  companyId: string;
  partyId: string;
  bookId: string;
}) {
  const q = useQuery({
    queryKey: ["party-statement", companyId, partyId, bookId],
    queryFn: () => partyStatement(companyId, partyId, bookId),
  });

  if (q.isLoading) return <Skeleton rows={3} />;
  const rows = q.data ?? [];
  if (rows.length === 0)
    return <p className="border-t border-line px-4 py-3 text-sm text-muted">No postings yet.</p>;

  return (
    <div className="border-t border-line">
      {/* phones: one line per posting, no sideways scroll */}
      <ul className="divide-y divide-line md:hidden">
        {rows.map((r, i) => (
          <li key={i} className="px-3.5 py-2.5">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm font-semibold tnum">
                <VoucherLink entryId={r.entry_id} voucherNo={r.voucher_no} />
              </span>
              <span className="text-sm font-semibold tnum">
                {toPaise(r.debit) ? (
                  <span className="text-ok">+{inr(toPaise(r.debit))}</span>
                ) : (
                  <span className="text-danger">−{inr(toPaise(r.credit))}</span>
                )}
              </span>
            </div>
            <div className="mt-0.5 flex items-baseline justify-between gap-3 text-xs text-muted">
              <span className="min-w-0 truncate">
                {fmt(r.entry_date)} · {r.narration}
              </span>
              <span className="shrink-0 tnum">bal {inr(toPaise(r.running))}</span>
            </div>
          </li>
        ))}
      </ul>

      <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[34rem] text-sm">
          <thead>
            <tr className="bg-canvas text-xs tracking-wide text-muted uppercase">
              <th className="px-3 py-2 text-left font-bold">Date</th>
              <th className="px-3 py-2 text-left font-bold">Voucher</th>
              <th className="px-3 py-2 text-left font-bold">What</th>
              <th className="px-3 py-2 text-right font-bold">Out</th>
              <th className="px-3 py-2 text-right font-bold">In</th>
              <th className="px-3 py-2 text-right font-bold">Balance</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-line">
                <td className="px-3 py-2 whitespace-nowrap tnum">{fmt(r.entry_date)}</td>
                <td className="px-3 py-2 font-semibold whitespace-nowrap tnum">
                  <VoucherLink entryId={r.entry_id} voucherNo={r.voucher_no} />
                </td>
                <td className="max-w-[16rem] truncate px-3 py-2">{r.narration}</td>
                <td className="px-3 py-2 text-right tnum">
                  {toPaise(r.debit) ? inr(toPaise(r.debit)) : "—"}
                </td>
                <td className="px-3 py-2 text-right tnum">
                  {toPaise(r.credit) ? inr(toPaise(r.credit)) : "—"}
                </td>
                <td className="px-3 py-2 text-right font-semibold tnum">
                  {inr(toPaise(r.running))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
