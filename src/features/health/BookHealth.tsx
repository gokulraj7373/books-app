import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useCompany } from "../company/CompanyProvider";
import { listEntries, verifyChain } from "../../lib/queries";
import { accountBalances, trialBalanceTotals } from "../../lib/reports";
import { inr } from "../../lib/money";
import { Alert, Badge, Card, SectionTitle, Skeleton } from "../../components/ui";
import { AlertList } from "../../components/Alerts";

/* ============================================================================
   Book health.

   Every failing check now LINKS to the screen that resolves it. A red row you
   cannot act on tells you something is wrong without telling you where to go,
   which is worse than not showing it at all.

   The page also states plainly what can and cannot be changed, because that is
   the question anyone asks before trusting a set of books.
   ========================================================================= */

type Check = {
  name: string;
  detail: string;
  ok: boolean;
  /** worth tidying, not a failure — never blocks a clean verdict */
  info?: boolean;
  to?: string;
  action?: string;
};

export function BookHealth() {
  const { company, statutoryBook, managementBook, activeBookId } = useCompany();

  const entriesQ = useQuery({
    queryKey: ["entries", company?.id, activeBookId],
    queryFn: () => listEntries(company!.id, activeBookId!),
    enabled: !!company && !!activeBookId,
  });
  const statChainQ = useQuery({
    queryKey: ["chain", company?.id, statutoryBook?.id],
    queryFn: () => verifyChain(company!.id, statutoryBook!.id),
    enabled: !!company && !!statutoryBook,
  });
  const mgmtChainQ = useQuery({
    queryKey: ["chain", company?.id, managementBook?.id],
    queryFn: () => verifyChain(company!.id, managementBook!.id),
    enabled: !!company && !!managementBook,
  });
  const balancesQ = useQuery({
    queryKey: ["balances", company?.id, activeBookId, "health"],
    queryFn: () => accountBalances(company!.id, activeBookId!),
    enabled: !!company && !!activeBookId,
  });

  if (!company) return <p className="text-sm text-muted">Create a company first.</p>;
  if (entriesQ.isLoading || statChainQ.isLoading || balancesQ.isLoading) return <Skeleton rows={6} />;

  const entries = entriesQ.data ?? [];
  const posted = entries.filter((e) => e.status === "posted");
  const drafts = entries.filter((e) => e.status === "draft");
  // Only an actual BILL — recorded through the Bills tab — is expected to have
  // paperwork attached. An ordinary payment (rent, an advance, lending money
  // out) was never asked for a bill anywhere in the app, so flagging it here
  // was noise: most entries genuinely have nothing to attach.
  const needProof = posted.filter((e) => e.voucher_type === "purchase");
  const noProof = needProof.filter((e) => !e.proof_url).length;
  const noMode = posted.filter((e) => !e.payment_mode).length;
  const tb = trialBalanceTotals(balancesQ.data ?? []);

  const checks: Check[] = [
    {
      name: "The books add up",
      detail: tb.tallies
        ? `Debits and credits both come to ${inr(tb.dr)}.`
        : `Debits and credits differ by ${inr(Math.abs(tb.dr - tb.cr))}. Do not file or share anything from these books yet.`,
      ok: tb.tallies,
      to: "/reports/trial-balance",
      action: "Open the trial balance",
    },
    {
      name: "Official audit trail intact",
      detail:
        statChainQ.data == null
          ? "Every posted entry still matches its tamper-evident record."
          : `Entry #${statChainQ.data} no longer matches its record. This cannot happen through normal use of the app.`,
      ok: statChainQ.data == null,
      to: "/entries",
      action: "Look at the entries",
    },
    {
      name: "Internal audit trail intact",
      detail:
        mgmtChainQ.data == null
          ? "The internal book is unaltered too."
          : `Internal entry #${mgmtChainQ.data} no longer matches its record.`,
      ok: mgmtChainQ.data == null,
      to: "/entries",
      action: "Look at the entries",
    },
    {
      name: "Nothing left half-finished",
      detail:
        drafts.length === 0
          ? "No drafts are waiting."
          : `${drafts.length} draft ${drafts.length === 1 ? "entry is" : "entries are"} saved but not posted, so ${drafts.length === 1 ? "it does" : "they do"} not appear in any report.`,
      ok: drafts.length === 0,
      to: "/entries",
      action: "Review the drafts",
    },
    {
      name: "Bills have their paperwork attached",
      detail:
        needProof.length === 0
          ? "No bills recorded yet."
          : noProof === 0
            ? "Every bill has a copy attached."
            : `${noProof} of ${needProof.length} bills have no copy attached. An investor or your CA will ask for these.`,
      ok: noProof === 0,
      info: true,
      to: "/bills",
      action: "See which ones",
    },
    {
      name: "How the money moved is recorded",
      detail:
        noMode === 0
          ? "Every entry says whether it was bank, UPI or cash."
          : `${noMode} of ${posted.length} posted entries do not say whether it was bank, UPI or cash, so they are harder to reconcile.`,
      ok: noMode === 0,
      info: true,
      to: "/entries",
      action: "See which ones",
    },
  ];

  const failing = checks.filter((c) => !c.ok && !c.info).length;
  const tidying = checks.filter((c) => !c.ok && c.info).length;

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div>
        <h1 className="text-xl font-extrabold text-navy">Book health</h1>
        <p className="mt-0.5 text-sm text-muted">
          Run this before you share anything with an investor or your CA.
        </p>
      </div>

      {failing > 0 ? (
        <Alert tone="danger" title={`${failing} thing${failing === 1 ? "" : "s"} to fix first`}>
          These are structural problems. Do not file or share these books until they are resolved —
          tap the failing check below to go straight to it.
        </Alert>
      ) : tidying > 0 ? (
        <Alert tone="warn" title="The books hold together">
          Nothing structural is wrong. {tidying} thing{tidying === 1 ? " is" : "s are"} worth tidying
          up before anyone else looks at these accounts.
        </Alert>
      ) : (
        <Alert tone="ok" title="These books are clean">
          Every check passes across {posted.length} posted {posted.length === 1 ? "entry" : "entries"}.
          The figures add up and nothing has been altered behind your back.
        </Alert>
      )}

      <section>
        <SectionTitle>Needs your attention</SectionTitle>
        <AlertList />
      </section>

      <section>
        <SectionTitle>Structural checks</SectionTitle>
        <div className="space-y-2">
          {checks.map((c) => {
            const body = (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-bold text-ink">{c.name}</span>
                  {c.ok ? (
                    <Badge tone="ok">pass</Badge>
                  ) : c.info ? (
                    <Badge tone="warn">worth doing</Badge>
                  ) : (
                    <Badge tone="danger">fix now</Badge>
                  )}
                </div>
                <p className="mt-0.5 text-sm text-muted">{c.detail}</p>
                {!c.ok && c.action && (
                  <p className="mt-1 text-xs font-semibold text-navy underline underline-offset-2">
                    {c.action} →
                  </p>
                )}
              </>
            );
            // Only a FAILING check is clickable — a green row that navigates
            // somewhere is a trap, because there is nothing to do there.
            return !c.ok && c.to ? (
              <Link
                key={c.name}
                to={c.to}
                className="block rounded-2xl border border-line bg-card p-4 shadow-sm transition-[border-color,transform] duration-200 hover:border-navy active:scale-[0.99]"
              >
                {body}
              </Link>
            ) : (
              <Card key={c.name} className="p-4">
                {body}
              </Card>
            );
          })}
        </div>
      </section>

      <LockedRules />

      <Alert tone="info" title="What the audit trail actually proves">
        The tamper-evident chain <strong>detects</strong> a change — it does not prevent one. Someone
        with direct database access could in principle recompute the whole chain. It becomes proof a
        third party can rely on the moment you keep an independent copy: take a backup from{" "}
        <Link to="/data" className="font-semibold underline underline-offset-2">
          Import / export
        </Link>{" "}
        and keep it somewhere the app cannot reach, because two separate copies cannot both be
        quietly rewritten.
      </Alert>
    </div>
  );
}

/** What can and cannot be changed — the question people ask before trusting books. */
function LockedRules() {
  const CANNOT: [string, string][] = [
    [
      "A posted entry",
      "Never editable, never deletable. Correct it by reversing and re-entering — both stay visible, which is exactly what an auditor expects to see.",
    ],
    [
      "The amount, date or accounts on a posted entry",
      "Locked by the database itself, not just by the screen. Even a direct API call is refused.",
    ],
    [
      "Voucher numbers",
      "Allocated in order with no gaps, so a missing number is visible immediately.",
    ],
    [
      "Anything inside a closed period",
      "Refused once a period is locked, unless an owner deliberately unlocks it again.",
    ],
    [
      "Official cash or bank in an internal-only entry",
      "Refused, because those balances must always match your bank statement.",
    ],
    [
      "The audit trail record on each entry",
      "Written once when the entry is posted and never touched again.",
    ],
  ];
  // Every line here is a promise the app has to keep. Two of them were briefly
  // downgraded to "possible, but not from inside the app" because the editing
  // screens did not exist. They do now, so the original claim is true again —
  // and this comment stays as the reminder that the words follow the software,
  // never the other way round.
  const CAN: [string, string][] = [
    ["Drafts", "Edit them freely. A draft affects no report until you post it."],
    [
      "The chart of accounts",
      "Add an account, rename one, or switch one off — though not while it still holds a balance, because nothing could post to it afterwards to clear it.",
    ],
    [
      "Party and investor details",
      "Names, contact details, GSTIN and agreed shares. Two names that turn out to be the same supplier can be merged into one.",
    ],
    ["Bill due dates and payment terms", "Terms genuinely do get renegotiated."],
    [
      "Unclassified investor money",
      "Reclassify it whenever you know — that posts a dated entry, so the change itself is on the record.",
    ],
    ["Notes, references and attached bills", "You can add paperwork to an entry after the fact."],
  ];

  return (
    <section>
      <SectionTitle>What can and cannot be changed</SectionTitle>
      <div className="grid gap-3 md:grid-cols-2">
        <Card className="p-4">
          <p className="mb-2 text-sm font-bold text-danger">Locked forever</p>
          <ul className="space-y-2.5">
            {CANNOT.map(([t, d]) => (
              <li key={t}>
                <span className="block text-sm font-semibold text-ink">{t}</span>
                <span className="block text-xs text-muted">{d}</span>
              </li>
            ))}
          </ul>
        </Card>
        <Card className="p-4">
          <p className="mb-2 text-sm font-bold text-ok">Yours to change</p>
          <ul className="space-y-2.5">
            {CAN.map(([t, d]) => (
              <li key={t}>
                <span className="block text-sm font-semibold text-ink">{t}</span>
                <span className="block text-xs text-muted">{d}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
      <p className="mt-2 text-xs text-muted">
        These rules live in the database, not in the screens. A bug in the app, a direct API call, or
        a mistake by someone with a login cannot get around them.
      </p>
    </section>
  );
}
