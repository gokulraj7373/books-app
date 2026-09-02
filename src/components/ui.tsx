import { useEffect, type ReactNode } from "react";

/* ============================================================================
   Primitives. Compose screens from these — never restyle inline. Adding a new
   variant here is correct; adding a one-off className soup at a call site is not.
   ========================================================================= */

export function Card({
  children,
  className = "",
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "section" | "article";
}) {
  return (
    <Tag className={`rounded-2xl border border-line bg-card shadow-sm ${className}`}>
      {children}
    </Tag>
  );
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-2 flex items-baseline justify-between gap-3">
      <h2 className="text-sm font-bold tracking-wide text-muted uppercase">{children}</h2>
      {right}
    </div>
  );
}

type Tone = "neutral" | "ok" | "warn" | "danger" | "info" | "gold";

const TONES: Record<Tone, string> = {
  neutral: "bg-canvas text-muted border-line",
  ok: "bg-okbg text-ok border-ok/20",
  warn: "bg-warnbg text-warn border-warn/20",
  danger: "bg-dangerbg text-danger border-danger/20",
  info: "bg-infobg text-info border-info/20",
  gold: "bg-gold/10 text-navy border-gold/30",
};

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: Tone }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}

export function Button({
  children,
  onClick,
  type = "button",
  variant = "primary",
  disabled,
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  variant?: "primary" | "secondary" | "ghost" | "danger";
  disabled?: boolean;
  className?: string;
}) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold " +
    "transition-[background-color,color,transform] duration-200 active:scale-[0.98] " +
    "disabled:pointer-events-none disabled:opacity-50";
  const variants = {
    primary: "bg-navy text-white hover:bg-navy2",
    secondary: "border border-line bg-card text-ink hover:bg-canvas",
    ghost: "text-navy hover:bg-canvas",
    danger: "bg-danger text-white hover:opacity-90",
  } as const;
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`${base} ${variants[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  required,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
  required?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-semibold text-ink">
        {label}
        {required && <span className="ml-0.5 text-danger">*</span>}
      </span>
      {children}
      {hint && !error && <span className="mt-1 block text-xs text-muted">{hint}</span>}
      {error && <span className="mt-1 block text-xs font-semibold text-danger">{error}</span>}
    </label>
  );
}

export const inputClass =
  "w-full rounded-xl border border-line bg-card px-3 py-2.5 text-sm text-ink " +
  "placeholder:text-muted/60 focus:border-navy focus:outline-none " +
  "transition-colors duration-200";

/** Right-aligned, tabular money. Never render an amount without this. */
export function Amount({
  children,
  bold,
  tone,
  className = "",
}: {
  children: ReactNode;
  bold?: boolean;
  tone?: "ok" | "danger" | "muted";
  className?: string;
}) {
  const toneClass =
    tone === "ok" ? "text-ok" : tone === "danger" ? "text-danger" : tone === "muted" ? "text-muted" : "";
  return (
    <span
      className={`tnum tabular-nums ${bold ? "font-bold" : ""} ${toneClass} ${className}`}
    >
      {children}
    </span>
  );
}

export function EmptyState({
  title,
  body,
  action,
  icon = "○",
}: {
  title: string;
  body: string;
  action?: ReactNode;
  icon?: string;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
      <div className="mb-1 text-2xl text-muted/50" aria-hidden>
        {icon}
      </div>
      <p className="text-sm font-bold text-ink">{title}</p>
      <p className="max-w-sm text-sm text-muted">{body}</p>
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

/** Skeleton, not a spinner. A spinner tells the user nothing about what's coming. */
export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-4" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-4 animate-pulse rounded bg-line" style={{ width: `${90 - i * 12}%` }} />
      ))}
    </div>
  );
}

export function StatTile({
  label,
  value,
  sub,
  tone = "neutral",
}: {
  label: string;
  value: ReactNode;
  sub?: string;
  tone?: Tone;
}) {
  return (
    <Card className="p-4">
      <p className="text-xs font-semibold tracking-wide text-muted uppercase">{label}</p>
      <p className="mt-1 text-2xl font-extrabold text-navy tnum">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-muted">{sub}</p>}
      {tone !== "neutral" && <div className="mt-2"><Badge tone={tone}>{tone}</Badge></div>}
    </Card>
  );
}

export function Alert({
  tone = "info",
  title,
  children,
}: {
  tone?: Tone;
  title?: string;
  children: ReactNode;
}) {
  return (
    <div className={`rounded-xl border px-4 py-3 text-sm ${TONES[tone]}`}>
      {title && <p className="mb-0.5 font-bold">{title}</p>}
      <div>{children}</div>
    </div>
  );
}

/* ============================================================================
   Sheet — the one way to show something over the screen.

   On a phone it rises from the bottom, where the thumb is and where the
   keyboard will not cover it. From `sm` up it becomes a centred dialog. Escape
   closes it, the background scroll is frozen while it is open, and tapping
   outside dismisses — all three are things people expect and notice the
   absence of.
   ========================================================================= */
export function Sheet({
  open,
  onClose,
  children,
  labelledBy,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  labelledBy?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    // A dialog that lets the page behind it scroll is disorienting on a phone.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="no-print fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
      <button
        aria-label="Close"
        onClick={onClose}
        className="fade-in absolute inset-0 cursor-default bg-ink/50 backdrop-blur-sm"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className="sheet-up relative flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-3xl bg-card shadow-2xl sm:max-w-lg sm:rounded-2xl"
      >
        {/* the grab handle reads as "this can be dismissed" on touch */}
        <div className="flex shrink-0 justify-center pt-2 pb-1 sm:hidden">
          <span className="h-1 w-10 rounded-full bg-line" aria-hidden />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
      </div>
    </div>
  );
}

/* ============================================================================
   Responsive table.

   A 46rem-wide table on a 375px phone is a sideways-scrolling wall that nobody
   reads. Same data, two shapes: a real table from `md` up, stacked cards
   below it, driven by one column definition so the two can never drift apart.
   ========================================================================= */
export type Column<T> = {
  key: string;
  header: string;
  /** desktop cell */
  cell: (row: T) => ReactNode;
  align?: "left" | "right";
  /** hide this column in the stacked card view (usually because `title` covers it) */
  hideOnCard?: boolean;
  /** don't show the label on the card — for the row's own heading */
  bare?: boolean;
};

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  cardTitle,
  cardMeta,
  footer,
  cardFooter,
  minWidth = "44rem",
  onRowClick,
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T, i: number) => string;
  /** heading of each stacked card on mobile */
  cardTitle?: (row: T) => ReactNode;
  /** small line under the card heading */
  cardMeta?: (row: T) => ReactNode;
  /** totals row for the desktop table — must be a <tr>, it lands in <tfoot> */
  footer?: ReactNode;
  /** the same totals for the stacked view — plain markup, it lands in a Card */
  cardFooter?: ReactNode;
  minWidth?: string;
  onRowClick?: (row: T) => void;
}) {
  return (
    <>
      {/* ---- phones: one card per row ---- */}
      <div className="space-y-2 md:hidden">
        {rows.map((row, i) => (
          <Card key={rowKey(row, i)} className="p-3.5">
            {cardTitle && <div className="text-sm font-bold text-ink">{cardTitle(row)}</div>}
            {cardMeta && <div className="mt-0.5 text-xs text-muted">{cardMeta(row)}</div>}
            <dl className="mt-2 space-y-1">
              {columns
                .filter((c) => !c.hideOnCard)
                .map((c) => (
                  <div key={c.key} className="flex items-baseline justify-between gap-3">
                    <dt className="shrink-0 text-xs text-muted">{c.header}</dt>
                    <dd className="min-w-0 text-right text-sm text-ink">{c.cell(row)}</dd>
                  </div>
                ))}
            </dl>
            {onRowClick && (
              <button
                onClick={() => onRowClick(row)}
                className="mt-2 text-xs font-bold text-navy underline underline-offset-2"
              >
                Open
              </button>
            )}
          </Card>
        ))}
        {cardFooter && <Card className="border-navy/30 bg-canvas p-3.5">{cardFooter}</Card>}
      </div>

      {/* ---- tablet and up: a real table ---- */}
      <Card className="hidden overflow-hidden md:block">
        <div className="overflow-x-auto">
          <table className="w-full text-sm" style={{ minWidth }}>
            <thead>
              <tr className="border-b border-line bg-canvas text-xs tracking-wide text-muted uppercase">
                {columns.map((c) => (
                  <th
                    key={c.key}
                    className={`px-3 py-2 font-bold ${c.align === "right" ? "text-right" : "text-left"}`}
                  >
                    {c.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr
                  key={rowKey(row, i)}
                  className={`border-b border-line last:border-0 ${
                    onRowClick ? "cursor-pointer hover:bg-canvas" : ""
                  }`}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                >
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className={`px-3 py-2 ${c.align === "right" ? "text-right" : "text-left"}`}
                    >
                      {c.cell(row)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            {footer && <tfoot>{footer}</tfoot>}
          </table>
        </div>
      </Card>
    </>
  );
}
