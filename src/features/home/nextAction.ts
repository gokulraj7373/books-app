import type { Account, Company, JournalEntry } from "../../lib/queries";

/* ============================================================================
   The Next Action engine.

   This exists because of one specific failure on a previous project: "if I open
   the app, I would never know where to start from." A dashboard full of zeroes
   is not an answer. The app must always name the single most useful next step.

   Rules are ordered by urgency: anything that means the books are WRONG comes
   before anything that is merely unfinished. The first matching rule wins, and
   the rest become the secondary list.
   ========================================================================= */

export type Action = {
  id: string;
  title: string;
  why: string;
  cta: string;
  href: string;
  tone: "danger" | "warn" | "info" | "gold" | "ok";
};

export type NextActionInput = {
  company: Company | null;
  accounts: Account[];
  entries: JournalEntry[];
  chainBrokenAtSeq: number | null;
  entriesWithoutProof: number;
};

export function computeActions(input: NextActionInput): Action[] {
  const { company, accounts, entries, chainBrokenAtSeq, entriesWithoutProof } = input;
  const out: Action[] = [];

  if (!company) {
    return [
      {
        id: "create-company",
        title: "Create your company",
        why: "Nothing can be recorded until a company exists. This takes about a minute and sets up your chart of accounts, financial year and both books automatically.",
        cta: "Create company",
        href: "/company/new",
        tone: "gold",
      },
    ];
  }

  // --- the books are WRONG: nothing else matters until this is resolved ---
  if (chainBrokenAtSeq !== null) {
    out.push({
      id: "chain-broken",
      title: `Audit trail broken at entry #${chainBrokenAtSeq}`,
      why: "A posted entry no longer matches its tamper-evident hash. This should be impossible through normal use. Do not file anything from these books until it is explained.",
      cta: "Open Book Health",
      href: "/health",
      tone: "danger",
    });
  }

  const posted = entries.filter((e) => e.status === "posted");
  const drafts = entries.filter((e) => e.status === "draft");

  // --- the genuine starting point ---
  if (posted.length === 0 && drafts.length === 0) {
    out.push({
      id: "first-entry",
      title: "Record your first transaction",
      why:
        company.lifecycle_phase === "capex"
          ? "Most businesses start with money coming in from investors and going out to builders and suppliers. Record what has already happened, oldest first."
          : "Record your first receipt or payment to get the books moving.",
      cta: "New voucher",
      href: "/entry/new",
      tone: "gold",
    });
  }

  if (drafts.length > 0) {
    out.push({
      id: "drafts",
      title: `${drafts.length} draft ${drafts.length === 1 ? "voucher" : "vouchers"} not yet posted`,
      why: "A draft does not affect any report. It counts only once posted.",
      cta: "Review drafts",
      href: "/entries?status=draft",
      tone: "warn",
    });
  }

  // --- accountability, the reason investors trust the numbers ---
  if (entriesWithoutProof > 0 && posted.length > 0) {
    out.push({
      id: "proof",
      title: `${entriesWithoutProof} ${entriesWithoutProof === 1 ? "bill has" : "bills have"} no copy attached`,
      why: "Not fatal, but an investor or a CA will ask. Attaching a photo of the bill is what makes a number checkable rather than merely asserted.",
      cta: "See which",
      href: "/bills",
      tone: "info",
    });
  }

  // --- the CapEx -> Operations transition, the thing Tally and Zoho ignore ---
  if (company.lifecycle_phase === "capex" && posted.length >= 5) {
    const cwip = accounts.some((a) => a.capex_role === "cwip");
    if (cwip) {
      out.push({
        id: "capex-review",
        title: "Review what your construction spend has become",
        why: "Money spent on building and fit-out is an asset, not a cost. When the work finishes it moves to a fixed asset and starts depreciating — that switch is easy to miss and it changes your balance sheet.",
        cta: "Open CapEx",
        href: "/capex",
        tone: "info",
      });
    }
  }

  if (out.length === 0) {
    out.push({
      id: "all-clear",
      title: "Your books are up to date",
      why: "Everything posted, nothing failing its checks. Keep recording as things happen — same-day entries are far easier than reconstructing a month later.",
      cta: "New voucher",
      href: "/entry/new",
      tone: "ok",
    });
  }

  return out;
}
