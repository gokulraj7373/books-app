import { useEffect, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useCompany } from "../company/CompanyProvider";
import { Alert, SectionTitle } from "../../components/ui";
import { downloadBlob, exportReport, type ReportKind } from "../../lib/exportBooks";
import { errorMessage } from "../../lib/errors";

/* ============================================================================
   The report centre.

   Reports were only reachable one at a time from a menu that also held Settings
   and Import/export. This is the one place you come to when someone asks for
   "the accounts" — every statement in one list, each openable, printable and
   saveable as PDF from the same screen.
   ========================================================================= */

type Report = {
  to: string;
  name: string;
  what: string;
  who: string;
  right?: string;
  /** set when this report can be produced as its own Excel file */
  kind?: ReportKind;
};

const STATEMENTS: Report[] = [
  {
    to: "/reports/balance-sheet",
    kind: "balance-sheet",
    name: "Balance sheet",
    what: "What the business owns and owes on a chosen date.",
    who: "The one your CA and your bank will ask for.",
    right: "view_reports",
  },
  {
    to: "/reports/profit-loss",
    kind: "profit-loss",
    name: "Profit & loss",
    what: "Income and costs over a period. Capital spending is deliberately not here.",
    who: "Shows whether trading is making money — meaningless before you open.",
    right: "view_reports",
  },
  {
    to: "/reports/trial-balance",
    kind: "trial-balance",
    name: "Trial balance",
    what: "Every account with its closing balance, and proof the books add up.",
    who: "The first thing an accountant checks.",
    right: "view_reports",
  },
  {
    to: "/reports/ledger",
    name: "General ledger",
    what: "Every posting to one account, with a running balance.",
    who: "For tracing a specific number back to where it came from.",
    right: "view_ledger",
  },
  {
    to: "/reports/cash-book",
    kind: "cash-book",
    name: "Cash & bank book",
    what: "Every rupee in and out, with a reconciliation box.",
    who: "Use this to tick off against your bank statement.",
    right: "view_cash_bank",
  },
];

const POSITION: Report[] = [
  {
    to: "/investors",
    kind: "investors",
    name: "Investor summary",
    what: "Each investor's commitment, what has arrived across both books, and what is still to come.",
    who: "What you send investors when they ask where things stand.",
  },
  {
    to: "/parties",
    kind: "parties",
    name: "Party ledger",
    what: "Every supplier and investor, picked by name, with a full statement and running balance.",
    who: "What Tally calls the party ledger.",
  },
  {
    to: "/bills",
    kind: "bills",
    name: "Bills & payables",
    what: "Outstanding bills, what is overdue, and what is already settled.",
    who: "Use this to decide who to pay next.",
  },
  {
    to: "/capex",
    name: "Building / CapEx",
    what: "Where money raised has gone: building work, equipment, advances, deposits, unspent.",
    who: "The picture Tally and Zoho have no concept of.",
    right: "view_capex",
  },
  {
    to: "/health",
    name: "Book health",
    what: "Automatic checks that the books still hold together, and the tamper-evident trail.",
    who: "Run this before sharing anything with an investor or your CA.",
  },
];

export function ReportHub() {
  const { company, can } = useCompany();
  if (!company) return <p className="text-sm text-muted">Create a company first.</p>;

  const allowed = (r: Report) => !r.right || can(r.right);

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div>
        <h1 className="text-xl font-extrabold text-navy">Reports</h1>
        <p className="mt-0.5 text-sm text-muted">
          Open any report, then use Print to send it to a printer or save it as a PDF. For the whole
          book as a spreadsheet, use{" "}
          <Link to="/data" className="font-semibold text-navy underline underline-offset-2">
            Import / export
          </Link>
          .
        </p>
      </div>

      <section>
        <SectionTitle>Financial statements</SectionTitle>
        <div className="space-y-2">
          {STATEMENTS.filter(allowed).map((r) => (
            <ReportRow key={r.to} r={r} />
          ))}
        </div>
      </section>

      <section>
        <SectionTitle>Where things stand</SectionTitle>
        <div className="space-y-2">
          {POSITION.filter(allowed).map((r) => (
            <ReportRow key={r.to} r={r} />
          ))}
        </div>
      </section>

      {STATEMENTS.some((r) => !allowed(r)) && (
        <p className="text-xs text-muted">
          Some reports are hidden because of what your role can see. Ask an owner if you need them.
        </p>
      )}
    </div>
  );
}

function ReportRow({ r }: { r: Report }) {
  const nav = useNavigate();
  const { company, activeBookId } = useCompany();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="rounded-2xl border border-line bg-card p-4 shadow-sm">
      <Link to={r.to} className="block">
        <span className="text-sm font-bold text-ink">{r.name}</span>
        <p className="mt-1 text-sm text-muted">{r.what}</p>
        <p className="mt-0.5 text-xs text-muted italic">{r.who}</p>
      </Link>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          onClick={() => void nav({ to: r.to })}
          className="rounded-lg border border-line px-3 py-1.5 text-xs font-bold text-ink hover:bg-canvas"
        >
          Open
        </button>
        {/* `?print=1` opens the report and fires the browser print dialog, which
            is also how a PDF gets saved. Navigating alone produced nothing
            printable, which is what the old "printable" badge wrongly implied. */}
        <button
          onClick={() => void nav({ to: r.to, search: { print: 1 } })}
          className="rounded-lg border border-line px-3 py-1.5 text-xs font-bold text-ink hover:bg-canvas"
        >
          Print / PDF
        </button>
        {r.kind && (
          <button
            disabled={busy || !company || !activeBookId}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const blob = await exportReport(company!, activeBookId!, r.kind!);
                const stamp = new Date().toISOString().slice(0, 10);
                downloadBlob(blob, `${r.name} ${stamp}.xlsx`);
              } catch (err) {
                setError(errorMessage(err));
              } finally {
                setBusy(false);
              }
            }}
            className="rounded-lg border border-line px-3 py-1.5 text-xs font-bold text-ink hover:bg-canvas disabled:opacity-50"
          >
            {busy ? "Preparing…" : "Excel"}
          </button>
        )}
      </div>
      {error && (
        <div className="mt-2">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
    </div>
  );
}

/**
 * Print bar shown on every report. Uses window.print(), which is also how the
 * browser's own "Save as PDF" works — no PDF library, and the output always
 * matches what the user sees.
 */
export function PrintBar({ title }: { title: string }) {
  const { company } = useCompany();

  // Arriving from the report list with ?print=1 opens the print dialog once the
  // figures have actually rendered — printing an empty skeleton helps nobody.
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has("print")) return;
    const t = setTimeout(() => window.print(), 1200);
    return () => clearTimeout(t);
  }, []);

  return (
    <>
      <div className="no-print flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-canvas px-4 py-2.5">
        <span className="text-xs text-muted">
          Printing also saves as PDF — choose “Save as PDF” as the destination.
        </span>
        <button
          onClick={() => window.print()}
          className="rounded-xl bg-navy px-4 py-2 text-sm font-semibold text-white transition-transform duration-200 active:scale-[0.98]"
        >
          Print / Save PDF
        </button>
      </div>

      {/* Letterhead that appears only on paper */}
      <div className="print-only mb-4 border-b border-black pb-2">
        <p className="text-lg font-bold">{company?.name}</p>
        <p className="text-sm">
          {title} · printed{" "}
          {new Date().toLocaleDateString("en-IN", {
            day: "2-digit",
            month: "short",
            year: "numeric",
          })}
        </p>
      </div>
    </>
  );
}
