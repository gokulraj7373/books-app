import type { ReactNode } from "react";
import { useCompany } from "../company/CompanyProvider";
import { Alert, Badge, Card, Field, inputClass } from "../../components/ui";

/** Shared chrome for every statement: book switcher, date controls, tally banner. */
export function ReportShell({
  title,
  subtitle,
  from,
  to,
  onFrom,
  onTo,
  singleDate,
  children,
  banner,
  /** Set by the Unified section, which explicitly shows both books merged
      regardless of the header toggle — everywhere else, a report shows
      exactly one book, alone. */
  unified,
}: {
  title: string;
  subtitle?: string;
  from?: string;
  to: string;
  onFrom?: (v: string) => void;
  onTo: (v: string) => void;
  singleDate?: boolean;
  children: ReactNode;
  banner?: ReactNode;
  unified?: boolean;
}) {
  const { company, internalMode, managementBook, can } = useCompany();
  const showsBooks = !!managementBook && can("view_management_book");

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div>
        <h1 className="text-xl font-extrabold text-navy">{title}</h1>
        <p className="mt-0.5 text-sm text-muted">
          {company?.name}
          {subtitle ? ` · ${subtitle}` : ""}
        </p>
      </div>

      <Card className="flex flex-wrap items-end gap-3 p-4">
        {/* No book switcher here any more. There is exactly ONE control that
            chooses the book — the Official / Internal toggle in the header —
            and it governs the whole app. Two switchers for the same thing is
            how a report ends up disagreeing with the screen that led to it. */}
        {!singleDate && onFrom && (
          <div className="w-40">
            <Field label="From">
              <input type="date" className={inputClass} value={from ?? ""} onChange={(e) => onFrom(e.target.value)} />
            </Field>
          </div>
        )}
        <div className="w-40">
          <Field label={singleDate ? "As on" : "To"}>
            <input type="date" className={inputClass} value={to} onChange={(e) => onTo(e.target.value)} />
          </Field>
        </div>

        {/* Say exactly what the figures are, and no report is ever allowed to
            silently merge — merging happens only in the Unified section,
            reached its own way, never as a side-effect of this toggle. */}
        {unified ? (
          <Badge tone="warn">Unified — official and internal books merged together</Badge>
        ) : (
          showsBooks && (
            <Badge tone={internalMode ? "warn" : "ok"}>
              {internalMode
                ? "Internal book only — not merged with the official figures"
                : "Official books only — this is what your CA sees"}
            </Badge>
          )
        )}
      </Card>

      {banner}
      {children}
    </div>
  );
}

export function TallyBanner({ tallies, left, right }: { tallies: boolean; left: string; right: string }) {
  return tallies ? (
    <Alert tone="ok">
      <strong>Tallies.</strong> {left} equals {right}.
    </Alert>
  ) : (
    <Alert tone="danger" title="These books do not tally">
      {left} does not equal {right}. Do not file anything from this report until it is explained —
      check Book Health for the failing entry.
    </Alert>
  );
}

export function Row({
  label,
  value,
  indent,
  bold,
  rule,
}: {
  label: string;
  value: ReactNode;
  indent?: boolean;
  bold?: boolean;
  rule?: boolean;
}) {
  return (
    <div
      className={`flex items-baseline justify-between gap-4 px-4 py-2 ${
        rule ? "border-t border-line" : ""
      } ${bold ? "font-bold text-navy" : ""}`}
    >
      <span className={`${indent ? "pl-4" : ""} text-sm`}>{label}</span>
      <span className="tnum text-sm tabular-nums">{value}</span>
    </div>
  );
}
