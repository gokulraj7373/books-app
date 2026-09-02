import { useEffect, useState, type ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { useAuth } from "../features/auth/AuthProvider";
import { useCompany } from "../features/company/CompanyProvider";
import { Badge } from "./ui";
import { AlertBell, AlertToaster } from "./Alerts";

/* ============================================================================
   Navigation.

   Everything used to sit under one "Reports" heading — including Settings and
   Import/export, which are not reports. Grouped now by WHAT YOU ARE DOING, in
   the order a day actually runs: record something, look at who owes what, read
   a report, change how things are set up.

   Mobile keeps five bottom tabs (more than that stops being tappable); the full
   grouped menu appears on the left rail from `md` up, and on a "More" screen
   below it.
   ========================================================================= */

/* Four destinations plus Record. Five is the practical ceiling for a thumb bar;
   everything else lives in the drawer, reachable from the header on every
   screen rather than only from a separate "More" page. */
const TABS = [
  { to: "/", label: "Home", icon: "◆" },
  { to: "/entries", label: "Entries", icon: "≡" },
  { to: "/entry/new", label: "Record", icon: "+", primary: true },
  { to: "/bills", label: "Bills", icon: "🧾" },
  { to: "/reports", label: "Reports", icon: "▤" },
] as const;

export type NavItem = { to: string; label: string; hint?: string };
export type NavGroup = { title: string; items: NavItem[] };

/* The rail shows headings; a heading opens, only the open one lists its pages.
   Eighteen links stacked flat gave every screen the same weight and made the
   group headings look like links themselves — which is what made this hard to
   read. `to` on a group is where the heading itself goes.

   The "Unified" group is appended conditionally by buildNavGroups() below,
   never listed here directly — it is the one place both books show merged,
   and it should not be reachable while looking at the official books alone. */
const BASE_NAV_GROUPS: (NavGroup & { to?: string; icon: string })[] = [
  {
    title: "Day to day",
    icon: "◆",
    to: "/",
    items: [
      { to: "/", label: "Home", hint: "What needs doing next" },
      { to: "/site", label: "Site expense", hint: "Fewer taps — for recording on site" },
      { to: "/entry/new", label: "Record something", hint: "Money in, money out" },
      { to: "/entries", label: "All entries", hint: "Everything recorded so far" },
    ],
  },
  {
    title: "Purchases & payables",
    icon: "🧾",
    to: "/bills",
    items: [
      { to: "/bills", label: "Bills to pay", hint: "What you owe, and how overdue it is" },
      { to: "/parties", label: "Party ledger", hint: "Pick anyone by name — suppliers, investors, contractors" },
      { to: "/capex", label: "Building / CapEx", hint: "Where the money has gone" },
    ],
  },
  {
    title: "Money & people",
    icon: "◎",
    to: "/investors",
    items: [
      { to: "/investors", label: "Investors", hint: "Who committed what, and what has arrived" },
      { to: "/accounts", label: "Chart of accounts", hint: "Every ledger you post to" },
    ],
  },
  {
    title: "Reports",
    icon: "▤",
    to: "/reports",
    items: [
      { to: "/reports", label: "All reports", hint: "View, print or save as PDF" },
      { to: "/reports/trial-balance", label: "Trial balance" },
      { to: "/reports/profit-loss", label: "Profit & loss" },
      { to: "/reports/balance-sheet", label: "Balance sheet" },
      { to: "/reports/ledger", label: "General ledger" },
      { to: "/reports/cash-book", label: "Cash & bank book" },
    ],
  },
  {
    title: "Set up",
    icon: "⚙",
    to: "/settings",
    items: [
      { to: "/settings", label: "Settings & people", hint: "Access, and your PIN" },
      {
        to: "/opening-balances",
        label: "Opening balances",
        hint: "What you already had on day one — only if you traded before",
      },
      { to: "/data", label: "Backup & export", hint: "Keep your own copy of everything" },
      { to: "/health", label: "Book health", hint: "Checks, and what can or cannot be changed" },
      { to: "/activity", label: "Activity log", hint: "Every correction and removal, and who did it" },
    ],
  },
];

/** Adds "Unified" only while looking at the internal book — see the comment above. */
function buildNavGroups(showUnified: boolean) {
  if (!showUnified) return BASE_NAV_GROUPS;
  return [
    ...BASE_NAV_GROUPS,
    {
      title: "Unified",
      icon: "⊕",
      to: "/unified",
      items: [
        { to: "/unified", label: "Unified overview", hint: "Both books merged, and investor accountability" },
        { to: "/unified/balance-sheet", label: "Balance sheet — unified" },
        { to: "/unified/profit-loss", label: "Profit & loss — unified" },
        { to: "/unified/trial-balance", label: "Trial balance — unified" },
        { to: "/unified/cash-book", label: "Cash & bank book — unified" },
      ],
    },
  ];
}

export const ROLE_LABEL: Record<string, string> = {
  owner: "CEO / Owner",
  accountant: "Accountant",
  project_coordinator: "Coordinator",
  cashier: "Cashier",
  investor: "Investor",
  auditor: "Auditor",
};

/* ----------------------------------------------------------------------------
   Internal-book mode.

   Modelled on a browser's incognito window, because the failure it prevents is
   the same one: working in a mode you have forgotten you are in. Three rules
   make it safe rather than merely convenient —

     1. it applies to the WHOLE app, so what you see and what you post always
        agree. (Before this, only report screens followed the selected book,
        while Home, Bills, CapEx and notifications silently showed the official
        book — which is how 15 real entries could look like they vanished.)
     2. it is impossible to miss: a permanent amber bar, everywhere.
     3. it ends when the app is closed. A fresh open is always on the official
        books, so nobody carries on in internal mode the next morning.
   -------------------------------------------------------------------------- */
function BookModeBar() {
  const { managementBook, internalMode, setInternalMode, can } = useCompany();
  if (!managementBook || !can("view_management_book")) return null;
  if (!internalMode) return null;

  return (
    <div className="no-print flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-warn/30 bg-warn px-4 py-2 text-white">
      <span aria-hidden className="text-sm">
        🔒
      </span>
      <span className="text-sm font-bold">Internal book</span>
      <span className="min-w-0 flex-1 text-xs opacity-90">
        Anything you record now stays out of the official books. Reports here show the internal
        book on its own — for both books together, use Unified in the menu.
      </span>
      <button
        onClick={() => setInternalMode(false)}
        className="rounded-lg bg-white/20 px-3 py-1 text-xs font-bold hover:bg-white/30"
      >
        Back to official books
      </button>
    </div>
  );
}

function BookModeToggle() {
  const { managementBook, internalMode, setInternalMode, can } = useCompany();
  if (!managementBook || !can("view_management_book")) return null;

  return (
    <button
      type="button"
      role="switch"
      aria-checked={internalMode}
      onClick={() => setInternalMode(!internalMode)}
      title={
        internalMode
          ? "You are in the internal book. Click to go back to the official books."
          : "Switch to the internal book — nothing recorded there reaches the official books."
      }
      className={`flex items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-xs font-bold transition-colors duration-200 ${
        internalMode
          ? "border-warn bg-warn text-white"
          : "border-line bg-card text-muted hover:bg-canvas"
      }`}
    >
      <span aria-hidden>{internalMode ? "🔒" : "🏛"}</span>
      <span className="hidden sm:inline">{internalMode ? "Internal" : "Official"}</span>
    </button>
  );
}

/**
 * The rail.
 *
 * One group open at a time, chosen by where you actually are. A heading is a
 * button that both navigates to the group's main screen and reveals its pages,
 * so headings never look like dead labels sitting above a list of links.
 */
function SideNav({ path }: { path: string }) {
  const { managementBook, internalMode, can } = useCompany();
  const groups = buildNavGroups(internalMode && !!managementBook && can("view_management_book"));
  const active = groups.find((g) => g.items.some((n) => n.to === path));
  const [open, setOpen] = useState<string | null>(active?.title ?? groups[0].title);

  // Following a link from elsewhere in the app should open its group too.
  useEffect(() => {
    if (active && active.title !== open) setOpen(active.title);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  return (
    <>
      {groups.map((g) => {
        const isOpen = open === g.title;
        const holdsCurrent = g.items.some((n) => n.to === path);
        return (
          <div key={g.title} className="mb-1">
            <button
              onClick={() => setOpen(isOpen ? null : g.title)}
              className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-bold transition-colors duration-200 ${
                holdsCurrent ? "text-navy" : "text-ink hover:bg-canvas"
              }`}
            >
              <span aria-hidden className="w-4 text-center">
                {g.icon}
              </span>
              <span className="flex-1">{g.title}</span>
              <span aria-hidden className="text-xs text-muted">
                {isOpen ? "▾" : "▸"}
              </span>
            </button>

            {isOpen && (
              <div className="mt-0.5 mb-2 ml-4 border-l border-line pl-2">
                {g.items.map((n) => (
                  <Link
                    key={n.to}
                    to={n.to}
                    className={`mb-0.5 block rounded-lg px-3 py-1.5 text-sm transition-colors duration-200 ${
                      path === n.to
                        ? "bg-navy font-semibold text-white"
                        : "font-medium text-muted hover:bg-canvas hover:text-ink"
                    }`}
                  >
                    {n.label}
                  </Link>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

/** The full menu as a slide-over, so every screen is one tap away on a phone. */
function MobileDrawer({ open, onClose, path }: { open: boolean; onClose: () => void; path: string }) {
  const { signOut, user } = useAuth();
  const { company, companies, setCompanyId, role } = useCompany();

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="no-print fixed inset-0 z-50 md:hidden">
      <button
        aria-label="Close menu"
        onClick={onClose}
        className="fade-in absolute inset-0 cursor-default bg-ink/50 backdrop-blur-sm"
      />
      <div className="slide-in-left pt-safe absolute inset-y-0 left-0 flex w-[85%] max-w-xs flex-col bg-card shadow-2xl">
        <div className="flex items-center justify-between border-b border-line px-4 py-4">
          <span className="text-xl font-extrabold tracking-tight text-navy">
            Books<span className="text-gold">.</span>
          </span>
          <button
            onClick={onClose}
            aria-label="Close menu"
            className="rounded-lg px-2 py-1 text-xl leading-none text-muted hover:bg-canvas"
          >
            ×
          </button>
        </div>

        {companies.length > 1 && (
          <div className="border-b border-line p-3">
            <label className="mb-1 block text-xs font-bold tracking-wide text-muted uppercase">
              Company
            </label>
            <select
              value={company?.id ?? ""}
              onChange={(e) => setCompanyId(e.target.value)}
              className="w-full truncate rounded-xl border border-line bg-card px-3 py-2 text-sm font-semibold text-ink"
            >
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <nav className="flex-1 overflow-y-auto p-2" onClick={onClose}>
          <SideNav path={path} />
        </nav>

        <div className="pb-safe border-t border-line p-3">
          {role && (
            <div className="mb-1.5">
              <Badge tone="gold">{ROLE_LABEL[role] ?? role}</Badge>
            </div>
          )}
          <p className="truncate px-1 text-xs text-muted">{user?.email}</p>
          <button
            onClick={signOut}
            className="mt-1.5 w-full rounded-lg px-1 py-1.5 text-left text-sm font-semibold text-muted hover:text-danger"
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const { signOut, user } = useAuth();
  const { company, companies, setCompanyId, role, internalMode } = useCompany();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const [drawer, setDrawer] = useState(false);

  // Any navigation closes the drawer — otherwise it stays open over the page
  // you just moved to.
  useEffect(() => setDrawer(false), [path]);

  return (
    <div className={`min-h-full md:flex ${internalMode ? "ring-warn/60 md:ring-2" : ""}`}>
      <aside className="no-print hidden w-60 shrink-0 flex-col border-r border-line bg-card md:flex">
        <div className="border-b border-line px-4 py-4">
          <div className="text-xl font-extrabold tracking-tight text-navy">
            Books<span className="text-gold">.</span>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto p-2">
          <SideNav path={path} />
        </nav>

        <div className="border-t border-line p-3">
          {role && (
            <div className="mb-1.5">
              <Badge tone="gold">{ROLE_LABEL[role] ?? role}</Badge>
            </div>
          )}
          <p className="truncate px-1 text-xs text-muted">{user?.email}</p>
          <button
            onClick={signOut}
            className="mt-1 w-full rounded-lg px-1 py-1 text-left text-xs font-semibold text-muted hover:text-danger"
          >
            Sign out
          </button>
        </div>
      </aside>

      <MobileDrawer open={drawer} onClose={() => setDrawer(false)} path={path} />

      <div className="flex min-w-0 flex-1 flex-col">
        <BookModeBar />
        <header className="pt-safe no-print sticky top-0 z-30 flex items-center gap-2 border-b border-line bg-card px-3 py-2.5 md:px-4 md:py-3">
          <button
            onClick={() => setDrawer(true)}
            aria-label="Open menu"
            className="-ml-1 rounded-xl px-2.5 py-2 text-lg leading-none text-ink hover:bg-canvas md:hidden"
          >
            ☰
          </button>
          <div className="text-lg font-extrabold tracking-tight text-navy md:hidden">
            Books<span className="text-gold">.</span>
          </div>
          {role && (
            <span className="hidden md:inline">
              <Badge tone="gold">{ROLE_LABEL[role] ?? role}</Badge>
            </span>
          )}

          <span className="ml-auto flex items-center gap-1.5 md:gap-2">
            <BookModeToggle />
            <AlertBell />
          </span>

          {/* The company switcher is in the drawer on a phone — four controls
              across a 375px header left nothing readable. */}
          {companies.length > 0 && (
            <select
              value={company?.id ?? ""}
              onChange={(e) => setCompanyId(e.target.value)}
              className="hidden max-w-[40%] truncate rounded-xl border border-line bg-card px-3 py-1.5 text-sm font-semibold text-ink md:block"
              aria-label="Select company"
            >
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
        </header>

        <main className="min-w-0 flex-1 px-3 py-4 pb-28 md:px-4 md:pb-8">{children}</main>

        <AlertToaster />

        <nav className="pb-safe no-print fixed inset-x-0 bottom-0 z-30 flex border-t border-line bg-card md:hidden">
          {TABS.map((n) => {
            const active = path === n.to;
            const primary = "primary" in n && n.primary;
            return (
              <Link
                key={n.to}
                to={n.to}
                className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] font-semibold transition-colors duration-200 ${
                  active ? "text-navy" : "text-muted"
                }`}
              >
                <span
                  aria-hidden
                  className={
                    primary
                      ? "-mt-0.5 flex h-8 w-8 items-center justify-center rounded-full bg-navy text-lg leading-none text-white shadow-sm"
                      : "text-base leading-none"
                  }
                >
                  {n.icon}
                </span>
                {n.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}

/** Everything that does not fit into five mobile tabs. */
export function More() {
  const { signOut, user } = useAuth();
  const { role, managementBook, internalMode, can } = useCompany();
  const groups = buildNavGroups(internalMode && !!managementBook && can("view_management_book"));
  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div>
        <h1 className="text-xl font-extrabold text-navy">Everything else</h1>
        <p className="mt-0.5 text-sm text-muted">{user?.email}</p>
        {role && (
          <div className="mt-2">
            <Badge tone="gold">{ROLE_LABEL[role] ?? role}</Badge>
          </div>
        )}
      </div>

      {groups.map((g) => (
        <section key={g.title}>
          <h2 className="mb-2 text-sm font-bold tracking-wide text-muted uppercase">{g.title}</h2>
          <div className="space-y-2">
            {g.items.map((n) => (
              <Link
                key={n.to}
                to={n.to}
                className="block rounded-2xl border border-line bg-card p-4 shadow-sm transition-[border-color,transform] duration-200 hover:border-navy active:scale-[0.99]"
              >
                <span className="block text-sm font-bold text-ink">{n.label}</span>
                {n.hint && <span className="mt-0.5 block text-xs text-muted">{n.hint}</span>}
              </Link>
            ))}
          </div>
        </section>
      ))}

      <button
        onClick={signOut}
        className="w-full rounded-xl border border-line px-4 py-3 text-sm font-semibold text-danger"
      >
        Sign out
      </button>
    </div>
  );
}
