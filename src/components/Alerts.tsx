import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../features/company/CompanyProvider";
import {
  companyAlerts,
  dismissAlert,
  dismissedAlertCount,
  restoreAlerts,
  type Alert as AlertRow,
} from "../lib/queries";
import { inr, toPaise } from "../lib/money";
import { Badge } from "./ui";

/* ============================================================================
   Notifications.

   Alerts are COMPUTED from the ledger, never stored, so "dismiss" cannot mean
   delete — the underlying fact is still true. It means "I have seen this", and
   it is remembered per user so one person clearing their view does not blind
   everybody else.

   Two deliberate safety rules:
     · A `danger` alert cannot be dismissed at all. "Your books do not add up"
       disappears when it is FIXED, not when it is tapped away.
     · Dismissal is fingerprinted by amount, so if the figure grows the alert
       comes back rather than staying silent forever.
   ========================================================================= */

export function useAlerts() {
  const { company, activeBookId } = useCompany();
  return useQuery({
    queryKey: ["alerts", company?.id, activeBookId],
    queryFn: () => companyAlerts(company!.id, activeBookId!),
    enabled: !!company && !!activeBookId,
    staleTime: 20_000,
  });
}

function useDismiss() {
  const { company } = useCompany();
  const qc = useQueryClient();
  return {
    dismiss: async (a: AlertRow) => {
      if (!company || !a.dismissible) return;
      await dismissAlert(company.id, a.id, a.fingerprint);
      await qc.invalidateQueries({ queryKey: ["alerts"] });
      await qc.invalidateQueries({ queryKey: ["dismissed-count"] });
    },
    restore: async () => {
      if (!company) return;
      await restoreAlerts(company.id);
      await qc.invalidateQueries({ queryKey: ["alerts"] });
      await qc.invalidateQueries({ queryKey: ["dismissed-count"] });
    },
  };
}

const TONE = {
  danger: "bg-dangerbg text-danger border-danger/25",
  warn: "bg-warnbg text-warn border-warn/25",
  info: "bg-infobg text-info border-info/25",
} as const;

export function AlertBell() {
  const [open, setOpen] = useState(false);
  const { company } = useCompany();
  const q = useAlerts();
  const { dismiss, restore } = useDismiss();
  const nav = useNavigate();

  const hiddenQ = useQuery({
    queryKey: ["dismissed-count", company?.id],
    queryFn: () => dismissedAlertCount(company!.id),
    enabled: !!company,
  });

  const alerts = q.data ?? [];
  const urgent = alerts.filter((a) => a.severity !== "info").length;
  const hidden = hiddenQ.data ?? 0;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`Notifications: ${alerts.length}`}
        className="relative rounded-xl border border-line bg-card px-2.5 py-1.5 text-sm transition-colors duration-200 hover:bg-canvas"
      >
        <span aria-hidden>🔔</span>
        {alerts.length > 0 && (
          <span
            className={`absolute -top-1.5 -right-1.5 min-w-[18px] rounded-full px-1 text-[10px] leading-[18px] font-bold text-white ${
              urgent > 0 ? "bg-danger" : "bg-muted"
            }`}
          >
            {alerts.length}
          </span>
        )}
      </button>

      {open && (
        <>
          <button
            className="fixed inset-0 z-20 cursor-default"
            aria-label="Close notifications"
            onClick={() => setOpen(false)}
          />
          <div className="absolute right-0 z-30 mt-2 max-h-[70vh] w-[min(25rem,calc(100vw-2rem))] overflow-y-auto rounded-2xl border border-line bg-card shadow-lg">
            <div className="sticky top-0 border-b border-line bg-card px-4 py-3">
              <p className="text-sm font-bold text-ink">What needs attention</p>
              <p className="text-xs text-muted">
                {alerts.length === 0
                  ? "Nothing right now."
                  : "Tap one to go straight to it, or clear it with ×."}
              </p>
            </div>

            {alerts.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-muted">
                Your books are clean and nothing is overdue.
              </p>
            ) : (
              alerts.map((a) => (
                <div key={a.id} className="flex items-start gap-1 border-b border-line last:border-0">
                  <button
                    className="min-w-0 flex-1 px-4 py-3 text-left hover:bg-canvas"
                    onClick={() => {
                      setOpen(false);
                      void nav({ to: a.href });
                    }}
                  >
                    <span className="block text-sm font-bold text-ink">{a.title}</span>
                    <span className="mt-0.5 block text-xs text-muted">{a.body}</span>
                    {a.amount && (
                      <span className="mt-1 block text-xs font-bold text-navy tnum">
                        {inr(toPaise(a.amount))}
                      </span>
                    )}
                  </button>
                  <span className="flex shrink-0 flex-col items-end gap-1 py-3 pr-3">
                    <span
                      className={`rounded-full border px-1.5 py-0.5 text-[10px] font-bold ${TONE[a.severity]}`}
                    >
                      {a.severity === "danger" ? "fix now" : a.severity === "warn" ? "soon" : "note"}
                    </span>
                    {a.dismissible ? (
                      <button
                        aria-label={`Clear: ${a.title}`}
                        title="Clear this until the amount changes"
                        onClick={() => void dismiss(a)}
                        className="px-1 text-base leading-none text-muted hover:text-danger"
                      >
                        ×
                      </button>
                    ) : (
                      <span
                        title="This cannot be cleared — it means the accounts are wrong. It goes away when fixed."
                        className="px-1 text-xs text-muted"
                      >
                        🔒
                      </span>
                    )}
                  </span>
                </div>
              ))
            )}

            {hidden > 0 && (
              <button
                onClick={() => void restore()}
                className="w-full border-t border-line px-4 py-2.5 text-xs font-semibold text-navy hover:bg-canvas"
              >
                Show {hidden} cleared {hidden === 1 ? "notice" : "notices"} again
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------------------
   The pop-up.

   A number on a bell is easy to walk past. When something new turns up that
   actually needs doing, it slides in, and tapping it takes you to the fix and
   puts it away.

   It only ever pops for something NEW in this session, and only for danger or
   warn. A pop-up that reappears on every screen change teaches you to ignore
   pop-ups, which is the opposite of the point.
   -------------------------------------------------------------------------- */
export function AlertToaster() {
  const q = useAlerts();
  const { dismiss } = useDismiss();
  const nav = useNavigate();
  const seen = useRef<Set<string> | null>(null);
  const [toasts, setToasts] = useState<AlertRow[]>([]);

  const alerts = q.data;

  useEffect(() => {
    if (!alerts) return;
    const important = alerts.filter((a) => a.severity !== "info");

    // First load is not "new" — arriving to three pop-ups is just noise.
    if (seen.current === null) {
      seen.current = new Set(important.map((a) => a.id + a.fingerprint));
      return;
    }

    const fresh = important.filter((a) => !seen.current!.has(a.id + a.fingerprint));
    if (fresh.length === 0) return;
    fresh.forEach((a) => seen.current!.add(a.id + a.fingerprint));
    setToasts((t) => [...fresh, ...t].slice(0, 2));
  }, [alerts]);

  // Warnings fade themselves out. A danger stays until it is acknowledged,
  // because "your books do not add up" should not vanish while you look away.
  useEffect(() => {
    if (toasts.length === 0) return;
    const soft = toasts.filter((t) => t.severity !== "danger");
    if (soft.length === 0) return;
    const timer = setTimeout(() => {
      setToasts((t) => t.filter((x) => x.severity === "danger"));
    }, 9000);
    return () => clearTimeout(timer);
  }, [toasts]);

  if (toasts.length === 0) return null;

  const close = (a: AlertRow) => setToasts((t) => t.filter((x) => x.id !== a.id));

  return (
    <div className="no-print pointer-events-none fixed inset-x-0 bottom-20 z-40 flex flex-col items-center gap-2 px-4 md:right-4 md:bottom-4 md:left-auto md:items-end">
      {toasts.map((a) => (
        <div
          key={a.id}
          role="status"
          className={`toast-in pointer-events-auto flex w-full max-w-sm items-start gap-2 rounded-2xl border p-3 shadow-lg ${TONE[a.severity]} bg-card`}
        >
          <button
            className="min-w-0 flex-1 text-left"
            onClick={() => {
              close(a);
              void nav({ to: a.href });
            }}
          >
            <span className="block text-sm font-bold">{a.title}</span>
            <span className="mt-0.5 block text-xs opacity-90">{a.body}</span>
            {a.amount && (
              <span className="mt-1 block text-xs font-bold tnum">{inr(toPaise(a.amount))}</span>
            )}
            <span className="mt-1 block text-xs font-semibold underline underline-offset-2">
              Take me there →
            </span>
          </button>
          <button
            aria-label="Close"
            onClick={() => {
              // Closing a warning also clears it from the bell; a danger only
              // leaves the screen, because it is not allowed to be hidden.
              if (a.dismissible) void dismiss(a);
              close(a);
            }}
            className="shrink-0 rounded-lg px-1.5 text-lg leading-none opacity-60 hover:opacity-100"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

/** The same alerts, laid out for the Home screen. */
export function AlertList({ limit }: { limit?: number }) {
  const q = useAlerts();
  const { dismiss } = useDismiss();
  const alerts = (q.data ?? []).slice(0, limit);

  if (q.isLoading) return null;
  if (alerts.length === 0) {
    return (
      <div className="rounded-2xl border border-ok/25 bg-okbg p-4">
        <p className="text-sm font-bold text-ok">Nothing needs your attention</p>
        <p className="mt-0.5 text-sm text-ok/90">
          The books add up, the audit trail is intact and nothing is overdue.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {alerts.map((a) => (
        <div key={a.id} className={`rounded-2xl border ${TONE[a.severity]}`}>
          <div className="flex items-start gap-2 p-4">
            <Link to={a.href} className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-bold">{a.title}</span>
                {a.amount && (
                  <Badge
                    tone={
                      a.severity === "danger" ? "danger" : a.severity === "warn" ? "warn" : "info"
                    }
                  >
                    {inr(toPaise(a.amount))}
                  </Badge>
                )}
              </div>
              <p className="mt-0.5 text-sm opacity-90">{a.body}</p>
              <p className="mt-1 text-xs font-semibold underline underline-offset-2">
                Go and fix this →
              </p>
            </Link>
            {a.dismissible && (
              <button
                aria-label={`Clear: ${a.title}`}
                title="Clear this until the amount changes"
                onClick={() => void dismiss(a)}
                className="shrink-0 rounded-lg px-2 py-1 text-lg leading-none opacity-60 hover:opacity-100"
              >
                ×
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
