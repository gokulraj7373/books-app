import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createCompany, listChartTemplates, templateAccounts } from "../../lib/queries";
import { useCompany } from "./CompanyProvider";
import { Alert, Button, Card, Field, inputClass, SectionTitle } from "../../components/ui";
import { errorMessage } from "../../lib/errors";

const LEGAL_FORMS = [
  ["proprietorship", "Proprietorship"],
  ["partnership", "Partnership"],
  ["llp", "LLP"],
  ["pvt_ltd", "Private Limited"],
  ["ltd", "Limited"],
  ["trust", "Trust"],
  ["society", "Society"],
  ["other", "Other"],
] as const;

export function NewCompany() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const { setCompanyId } = useCompany();

  const [name, setName] = useState("");
  const [legalForm, setLegalForm] = useState("partnership");
  const [startDate, setStartDate] = useState("");
  const [phase, setPhase] = useState<"capex" | "operations">("capex");
  const [industry, setIndustry] = useState("core");
  const [pan, setPan] = useState("");
  const [gstin, setGstin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const templatesQ = useQuery({
    queryKey: ["chart-templates"],
    queryFn: listChartTemplates,
    staleTime: Infinity,
  });
  // A preview of what the choice actually produces, so it is a decision rather
  // than a guess. Loaded only for the highlighted template.
  const previewQ = useQuery({
    queryKey: ["chart-template-accounts", industry],
    queryFn: () => templateAccounts(industry),
    staleTime: Infinity,
  });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const id = await createCompany({
        name,
        legal_form: legalForm,
        books_start_date: startDate,
        lifecycle_phase: phase,
        industry,
        pan: pan || undefined,
        gstin: gstin || undefined,
      });
      setCompanyId(id);
      await qc.invalidateQueries();
      void nav({ to: "/" });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-lg">
      <h1 className="mb-1 text-xl font-extrabold text-navy">Create your company</h1>
      <p className="mb-5 text-sm text-muted">
        This sets up your chart of accounts, your financial year, and both your statutory and
        management books in one go.
      </p>

      <form onSubmit={submit}>
        <Card className="space-y-4 p-5">
          <Field label="Company name" required>
            <input
              className={inputClass}
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Northwind Ventures"
            />
          </Field>

          <Field label="Legal form">
            <select
              className={inputClass}
              value={legalForm}
              onChange={(e) => setLegalForm(e.target.value)}
            >
              {LEGAL_FORMS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="Books start date"
            required
            hint="The date of your earliest transaction. Your financial year (1 Apr – 31 Mar) is worked out from this."
          >
            <input
              className={inputClass}
              type="date"
              required
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </Field>

          <div>
            <SectionTitle>What trade is it?</SectionTitle>
            <p className="mb-2 text-xs text-muted">
              This picks your starting chart of accounts. It is a head start, not a cage — you can
              add, rename and switch off accounts afterwards, and pull in another trade's accounts
              later if the business changes.
            </p>
            <select
              className={inputClass}
              value={industry}
              onChange={(e) => setIndustry(e.target.value)}
            >
              {(templatesQ.data ?? []).map((t) => (
                <option key={t.key} value={t.key}>
                  {t.name}
                </option>
              ))}
            </select>
            <p className="mt-2 text-xs text-muted">
              {(templatesQ.data ?? []).find((t) => t.key === industry)?.blurb}
            </p>
            {previewQ.data && (
              <details className="mt-2 rounded-xl border border-line p-3">
                <summary className="cursor-pointer text-xs font-semibold text-ink">
                  {previewQ.data.length} accounts — see the main ones
                </summary>
                <ul className="mt-2 space-y-1">
                  {previewQ.data
                    .filter((a) => ["1010", "1020", "1110", "1430", "4010", "5010"].includes(a.code))
                    .map((a) => (
                      <li key={a.code} className="text-xs text-muted">
                        <span className="tnum font-semibold text-ink">{a.code}</span> {a.name}
                      </li>
                    ))}
                </ul>
              </details>
            )}
          </div>

          <div>
            <SectionTitle>Where is the business right now?</SectionTitle>
            <div className="grid gap-2 sm:grid-cols-2">
              <PhaseCard
                selected={phase === "capex"}
                onClick={() => setPhase("capex")}
                title="Still building"
                body="Raising money, paying builders and suppliers, buying equipment. Not selling yet."
              />
              <PhaseCard
                selected={phase === "operations"}
                onClick={() => setPhase("operations")}
                title="Already trading"
                body="Selling to customers day to day."
              />
            </div>
            <p className="mt-2 text-xs text-muted">
              This only changes what the app shows you first. It never changes your accounts, and
              you can switch later.
            </p>
          </div>

          <details className="rounded-xl border border-line p-3">
            <summary className="cursor-pointer text-sm font-semibold text-ink">
              Tax details (optional — you can add these later)
            </summary>
            <div className="mt-3 space-y-3">
              <Field label="PAN">
                <input
                  className={inputClass}
                  value={pan}
                  onChange={(e) => setPan(e.target.value.toUpperCase())}
                  placeholder="AAAAA0000A"
                  maxLength={10}
                />
              </Field>
              <Field label="GSTIN">
                <input
                  className={inputClass}
                  value={gstin}
                  onChange={(e) => setGstin(e.target.value.toUpperCase())}
                  placeholder="33AAAAA0000A1Z5"
                  maxLength={15}
                />
              </Field>
            </div>
          </details>

          {error && <Alert tone="danger">{error}</Alert>}

          <Button type="submit" disabled={busy || !name || !startDate} className="w-full">
            {busy ? "Creating…" : "Create company"}
          </Button>
        </Card>
      </form>
    </div>
  );
}

function PhaseCard({
  selected,
  onClick,
  title,
  body,
}: {
  selected: boolean;
  onClick: () => void;
  title: string;
  body: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`rounded-xl border p-3 text-left transition-[border-color,background-color] duration-200 active:scale-[0.98] ${
        selected ? "border-navy bg-navy/5" : "border-line bg-card hover:bg-canvas"
      }`}
    >
      <p className="text-sm font-bold text-ink">{title}</p>
      <p className="mt-0.5 text-xs text-muted">{body}</p>
    </button>
  );
}
