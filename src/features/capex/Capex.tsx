import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../company/CompanyProvider";
import {
  addProjectLine,
  capexSummary,
  createProject,
  listAccounts,
  listProjectLines,
} from "../../lib/queries";
import { accountBalances, type Balance } from "../../lib/reports";
import { Capitalize } from "./Capitalize";
import { inr, toPaise } from "../../lib/money";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  inputClass,
  SectionTitle,
  Skeleton,
} from "../../components/ui";
import { errorMessage } from "../../lib/errors";

type Bucket = { key: string; label: string; note: string; rows: Balance[]; paise: number };

const BUCKET_COLOR: Record<string, string> = {
  cwip: "bg-navy",
  ppe: "bg-navy2",
  capital_advance: "bg-gold",
  deposit: "bg-gold2",
  expense: "bg-danger",
  owed: "bg-warn",
  other: "bg-muted",
};

/**
 * Where the money went, in buckets that cover ALL of it.
 *
 * The previous version summed four `capex_role` tiles — cwip, ppe, advances,
 * deposits — and showed nothing else. Anything without one of those roles was
 * simply absent from the screen. On this company that hid ₹1,64,563 of
 * ₹13,53,363 raised: two "Loans & Advances" accounts carrying no role, plus
 * every real expense, because expenses have no capex_role by definition and
 * never will. The headline still read "₹8,07,163 has been put to work" while
 * the breakdown under it accounted for only ₹6,42,600, and nothing pointed at
 * the difference.
 *
 * So the last bucket is a catch-all rather than another named role. A new
 * account type, a new sub-group, an account somebody adds next year — all of it
 * lands somewhere visible instead of vanishing. `unaccounted` in the caller is
 * the belt to this braces: if the buckets ever fail to add up to what was
 * deployed, the screen says so rather than showing a tidy wrong number.
 */
export function buildBuckets(balances: Balance[]): Bucket[] {
  const seen = new Set<string>();
  // Cash is reported separately as "still unspent", and equity is the money
  // coming IN — neither is somewhere the money "went".
  const pool = balances.filter((b) => !b.is_bank_or_cash && b.account_type !== "equity");

  const take = (key: string, label: string, note: string, pred: (b: Balance) => boolean): Bucket => {
    const rows = pool.filter((b) => !seen.has(b.account_id) && pred(b) && toPaise(b.net) !== 0);
    rows.forEach((r) => seen.add(r.account_id));
    return { key, label, note, rows, paise: rows.reduce((n, r) => n + toPaise(r.net), 0) };
  };

  const role = (r: string) => (b: Balance) => b.capex_role === r;

  return [
    take("cwip", "Building work in progress", "Becomes a fixed asset when the work finishes", role("cwip")),
    take("ppe", "Equipment and furniture owned", "Assets you already hold", role("ppe")),
    take("capital_advance", "Advances with suppliers", "They owe you goods or work", role("capital_advance")),
    take("deposit", "Deposits", "Refundable or adjustable", role("deposit")),
    take("expense", "Spent and gone", "A real cost — it will not come back", (b) => b.account_type === "expense"),
    take("owed", "Money you owe", "Bills and liabilities outstanding", (b) => b.account_type === "liability"),
    // Deliberately last and deliberately unconditional.
    take("other", "Other amounts recoverable", "Advances and receivables not tied to the build", () => true),
  ].filter((b) => b.rows.length > 0);
}

/**
 * The capital-expenditure phase, which incumbents have no concept of.
 *
 * Everything here is derived from the ledger — nothing is stored twice — so the
 * project view and the balance sheet can never disagree.
 */
export function Capex() {
  const { company, activeBookId, can } = useCompany();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);

  const projectsQ = useQuery({
    queryKey: ["capex", company?.id, activeBookId],
    queryFn: () => capexSummary(company!.id, activeBookId!),
    enabled: !!company && !!activeBookId,
  });
  const balancesQ = useQuery({
    queryKey: ["balances", company?.id, activeBookId, "capex"],
    queryFn: () => accountBalances(company!.id, activeBookId!),
    enabled: !!company && !!activeBookId,
  });
  const accountsQ = useQuery({
    queryKey: ["accounts", company?.id],
    queryFn: () => listAccounts(company!.id),
    enabled: !!company,
  });

  if (!company) return <p className="text-sm text-muted">Create a company first.</p>;
  if (projectsQ.isLoading || balancesQ.isLoading) return <Skeleton rows={6} />;

  const balances = balancesQ.data ?? [];
  const capital = -balances
    .filter((b) => b.account_type === "equity")
    .reduce((n, b) => n + toPaise(b.net), 0);
  const cash = balances.filter((b) => b.is_bank_or_cash).reduce((n, b) => n + toPaise(b.net), 0);
  const deployed = capital - cash;

  const buckets = buildBuckets(balances);
  const bucketed = buckets.reduce((n, b) => n + b.paise, 0);
  // Every rupee raised must appear in exactly one place. If it does not, the
  // screen says so instead of quietly showing a smaller number — see
  // buildBuckets for why this exists.
  const unaccounted = deployed - bucketed;
  const cwip = buckets.find((b) => b.key === "cwip")?.paise ?? 0;

  const projects = projectsQ.data ?? [];
  const cwipAccounts = (accountsQ.data ?? []).filter((a) => a.capex_role === "cwip" && !a.is_group);

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div>
        <h1 className="text-xl font-extrabold text-navy">Building the business</h1>
        {/* Kept: "not a loss" is a consequence people get wrong, not a
            restatement of the heading. The sentence in front of it was. */}
        <p className="mt-0.5 text-sm text-muted">
          None of this is a loss — it is what you own or are owed.
        </p>
      </div>

      {/* where the money went */}
      <section>
        <SectionTitle>Money raised, and where it is now</SectionTitle>
        <Card className="p-4">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-sm font-semibold text-ink">Raised from investors</span>
            <span className="text-2xl font-extrabold text-navy tnum">{inr(capital)}</span>
          </div>
          {/* Driven by the same buckets as the breakdown below, so the bar and
              the list can never tell different stories. */}
          <Bar
            segments={[
              ...buckets.map((b) => ({ label: b.label, paise: b.paise, color: BUCKET_COLOR[b.key] })),
              { label: "Still unspent", paise: cash, color: "bg-ok" },
            ]}
          />
          {/* "still unspent" now has its own row in the breakdown below. */}
          <p className="mt-3 text-xs text-muted">
            {inr(deployed)} of {inr(capital)} put to work.
          </p>
        </Card>
      </section>

      <section>
        <SectionTitle>Where it went</SectionTitle>
        <Card className="divide-y divide-line p-0">
          {buckets.map((b) => (
            <div key={b.key} className="p-4">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm font-bold text-ink">{b.label}</span>
                <span className="text-lg font-extrabold text-navy tnum">{inr(b.paise)}</span>
              </div>
              <p className="mt-0.5 text-xs text-muted">{b.note}</p>
              {/* The accounts inside, by name. "Spent ₹28,363" is a number;
                  "Professional & Legal Fees ₹25,000" is an answer. */}
              <div className="mt-2 space-y-1">
                {b.rows.map((r) => (
                  <div key={r.account_id} className="flex items-baseline justify-between gap-3">
                    <span className="truncate text-xs text-muted">{r.name}</span>
                    <span className="shrink-0 text-xs text-ink tnum">{inr(toPaise(r.net))}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}

          <div className="flex items-baseline justify-between gap-3 p-4">
            <span className="text-sm font-bold text-ink">Still unspent</span>
            <span className="text-lg font-extrabold text-ok tnum">{inr(cash)}</span>
          </div>

          {/* Should always be zero. Shown only when it is not, because a
              breakdown that quietly fails to add up is how money goes missing
              from a screen without anyone noticing. */}
          {unaccounted !== 0 && (
            <div className="p-4">
              <Alert tone="warn" title="This does not add up">
                {inr(Math.abs(unaccounted))} of what was raised is not in any group above. Nothing
                is lost — the entries are all in the ledger — but this screen cannot explain where
                it sits, so it is saying so rather than showing a tidy total.
              </Alert>
            </div>
          )}
        </Card>
      </section>

      {/* projects */}
      <section>
        <SectionTitle
          right={
            can("manage_capital_project") && cwipAccounts.length > 0 ? (
              <button
                onClick={() => setAdding((v) => !v)}
                className="text-xs font-bold text-navy underline underline-offset-2"
              >
                {adding ? "Cancel" : "+ New project"}
              </button>
            ) : undefined
          }
        >
          Projects
        </SectionTitle>

        {adding && (
          <NewProject
            companyId={company.id}
            cwipAccounts={cwipAccounts}
            onDone={() => {
              setAdding(false);
              void qc.invalidateQueries({ queryKey: ["capex"] });
            }}
          />
        )}

        {projects.length === 0 && !adding ? (
          <Card>
            <EmptyState
              icon="⌂"
              title="No projects yet"
              body="One thing you are building — the kitchen fit-out, the dining area. Set a budget and watch the spend against it."
              action={
                can("manage_capital_project") && cwipAccounts.length > 0 ? (
                  <Button onClick={() => setAdding(true)}>Create a project</Button>
                ) : undefined
              }
            />
          </Card>
        ) : (
          <div className="space-y-2">
            {projects.map((p) => (
              <ProjectCard
                key={p.project_id}
                project={p}
                companyId={company.id}
                bookId={activeBookId!}
              />
            ))}
          </div>
        )}
      </section>

      {/* Kept, shortened: this is the commonest mistake at this stage and the
          app is the only thing that will mention it. */}
      {cwip > 0 && (
        <Alert tone="info" title="When the work finishes">
          Use <strong>Mark as finished</strong>. Until you do, this {inr(cwip)} is not depreciating.
        </Alert>
      )}
    </div>
  );
}

function Bar({
  segments,
}: {
  segments: { label: string; paise: number; color: string }[];
}) {
  const total = segments.reduce((n, s) => n + Math.max(0, s.paise), 0);
  if (total <= 0) return <p className="text-sm text-muted">Nothing recorded yet.</p>;
  const shown = segments.filter((s) => s.paise > 0);
  return (
    <>
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-line">
        {shown.map((s) => (
          <div
            key={s.label}
            className={s.color}
            style={{ width: `${(s.paise / total) * 100}%` }}
            title={`${s.label}: ${inr(s.paise)}`}
          />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {shown.map((s) => (
          <span key={s.label} className="flex items-center gap-1.5 text-xs text-muted">
            <span className={`h-2 w-2 rounded-full ${s.color}`} />
            {s.label} <span className="font-semibold text-ink tnum">{inr(s.paise)}</span>
          </span>
        ))}
      </div>
    </>
  );
}

function ProjectCard({
  project,
  companyId,
  bookId,
}: {
  project: import("../../lib/queries").CapexProject;
  companyId: string;
  bookId: string;
}) {
  const [open, setOpen] = useState(false);
  const [capitalizing, setCapitalizing] = useState(false);
  const qc = useQueryClient();
  const budget = toPaise(project.budget_amount);
  const spent = toPaise(project.cwip_balance);
  const planned = toPaise(project.planned_amount);
  const pct = budget > 0 ? Math.min(100, Math.round((spent / budget) * 100)) : 0;
  const over = budget > 0 && spent > budget;

  const linesQ = useQuery({
    queryKey: ["project-lines", project.project_id],
    queryFn: () => listProjectLines(project.project_id),
    enabled: open,
  });

  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full p-4 text-left transition-colors duration-200 hover:bg-canvas"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="flex items-center gap-2">
            <span className="text-sm font-bold text-ink">{project.name}</span>
            {project.status === "capitalized" && <Badge tone="ok">finished</Badge>}
            {over && <Badge tone="danger">over budget</Badge>}
          </span>
          <span className="text-sm font-bold text-navy tnum">
            {inr(spent)}
            {budget > 0 && <span className="font-normal text-muted"> of {inr(budget)}</span>}
          </span>
        </div>
        {budget > 0 && (
          <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-line">
            <div className={`h-full ${over ? "bg-danger" : "bg-navy"}`} style={{ width: `${pct}%` }} />
          </div>
        )}
        <p className="mt-1.5 text-xs text-muted">
          {project.line_count} planned {project.line_count === 1 ? "item" : "items"}
          {planned > 0 && ` · ${inr(planned)} planned`}
        </p>
      </button>

      {/* The action the screen has always told people they must not forget,
          and never gave them a way to do. Only offered when there is actually
          something under way to finish. */}
      {spent > 0 && project.status !== "capitalized" && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line bg-canvas px-4 py-2.5">
          <span className="text-xs text-muted">
            {inr(spent)} in progress. It does not depreciate until you mark it finished.
          </span>
          <Button variant="secondary" onClick={() => setCapitalizing(true)} className="shrink-0">
            Mark as finished
          </Button>
        </div>
      )}

      {capitalizing && (
        <Capitalize
          companyId={companyId}
          bookId={bookId}
          project={project}
          onClose={() => setCapitalizing(false)}
        />
      )}

      {open && (
        <div className="border-t border-line p-4">
          {linesQ.isLoading ? (
            <Skeleton rows={2} />
          ) : (linesQ.data ?? []).length === 0 ? (
            <p className="text-sm text-muted">
              No planned items yet. Add what you expect to spend, to compare against reality.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {(linesQ.data ?? []).map((l) => (
                <li key={l.id} className="flex items-baseline justify-between gap-3 text-sm">
                  <span>
                    {l.name}
                    {l.category && <span className="ml-2 text-xs text-muted">{l.category}</span>}
                  </span>
                  <span className="tnum text-muted">{inr(toPaise(l.planned_amount))}</span>
                </li>
              ))}
            </ul>
          )}
          <AddLine
            projectId={project.project_id}
            companyId={companyId}
            onDone={() => {
              void qc.invalidateQueries({ queryKey: ["project-lines", project.project_id] });
              void qc.invalidateQueries({ queryKey: ["capex"] });
            }}
          />
        </div>
      )}
    </Card>
  );
}

function AddLine({
  projectId,
  companyId,
  onDone,
}: {
  projectId: string;
  companyId: string;
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim() || !amount.trim()) return;
        setBusy(true);
        try {
          await addProjectLine({
            capital_project_id: projectId,
            company_id: companyId,
            name: name.trim(),
            planned_amount: amount,
          });
          setName("");
          setAmount("");
          onDone();
        } finally {
          setBusy(false);
        }
      }}
    >
      <input
        className={`${inputClass} flex-1 min-w-[10rem]`}
        placeholder="What are you planning? e.g. Chairs and tables"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        className={`${inputClass} w-32 text-right tnum`}
        placeholder="₹ amount"
        inputMode="decimal"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />
      <Button type="submit" variant="secondary" disabled={busy || !name.trim() || !amount.trim()}>
        Add
      </Button>
    </form>
  );
}

function NewProject({
  companyId,
  cwipAccounts,
  onDone,
}: {
  companyId: string;
  cwipAccounts: import("../../lib/queries").Account[];
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [budget, setBudget] = useState("");
  const [cwipId, setCwipId] = useState(cwipAccounts[0]?.id ?? "");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Card className="mb-2 p-4">
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await createProject({
              company_id: companyId,
              name: name.trim(),
              budget_amount: budget || "0",
              cwip_account_id: cwipId,
              target_date: target || undefined,
            });
            onDone();
          } catch (err) {
            setError(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="What are you building?" required>
          <input
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Kitchen fit-out"
          />
        </Field>
        <Field
          label="Budget"
          hint="Your best estimate — you can change it later. It is a yardstick to spend against, not a limit: going over it is reported, never blocked."
        >
          <input
            className={`${inputClass} text-right tnum`}
            inputMode="decimal"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            placeholder="0.00"
          />
        </Field>
        <Field
          label="Where does spend on this build up?"
          hint="Payments you record against this work land here"
        >
          <select className={inputClass} value={cwipId} onChange={(e) => setCwipId(e.target.value)}>
            {cwipAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Target finish date (optional)">
          <input
            type="date"
            className={inputClass}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          />
        </Field>
        {error && <Alert tone="danger">{error}</Alert>}
        <Button type="submit" disabled={busy || !name.trim() || !cwipId}>
          {busy ? "Creating…" : "Create project"}
        </Button>
      </form>
    </Card>
  );
}
