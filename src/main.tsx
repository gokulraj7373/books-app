import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";

import "./index.css";
import { supabase } from "./lib/supabase";
import { lockNow } from "./lib/pinLock";
import { ErrorBoundary, RouteError } from "./components/ErrorBoundary";
import { AuthProvider, useAuth } from "./features/auth/AuthProvider";
import { CompanyProvider } from "./features/company/CompanyProvider";
import { SignIn } from "./features/auth/SignIn";
import { ChoosePassword } from "./features/auth/ChoosePassword";
import { PinGate } from "./features/auth/PinGate";
import { Shell, More } from "./components/Shell";
import { Home } from "./features/home/Home";
import { NewCompany } from "./features/company/NewCompany";
import { NewEntry } from "./features/entries/NewEntry";
import { GuidedEntry } from "./features/entries/GuidedEntry";
import { SiteExpense } from "./features/site/SiteExpense";
import { Parties } from "./features/parties/Parties";
import { Capex } from "./features/capex/Capex";
import { Bills } from "./features/bills/Bills";
import { BillEntry } from "./features/bills/BillEntry";
import { Investors } from "./features/investors/Investors";
import { Settings } from "./features/settings/Settings";
import { ReportHub } from "./features/reports/ReportHub";
import { ImportExport } from "./features/data/ImportExport";
import { OpeningBalances } from "./features/data/OpeningBalances";
import { EntryList } from "./features/entries/EntryList";
import { VoucherOverlayProvider } from "./features/entries/VoucherOverlay";
import { AccountList } from "./features/accounts/AccountList";
import { BookHealth } from "./features/health/BookHealth";
import { ActivityLog } from "./features/health/ActivityLog";
import { UnifiedHub } from "./features/reports/UnifiedHub";
import { TrialBalance } from "./features/reports/TrialBalance";
import { ProfitAndLoss } from "./features/reports/ProfitAndLoss";
import { BalanceSheet } from "./features/reports/BalanceSheet";
import { GeneralLedger } from "./features/reports/GeneralLedger";
import { CashBook } from "./features/reports/CashBook";
import { Skeleton } from "./components/ui";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false },
  },
  // A dead session shows up as a 401 on whichever query happens to run next,
  // and every screen would render its own "failed to load" in its own way. One
  // place to notice it means the lock closes and the cache empties the moment
  // the session is gone, wherever it is discovered.
  queryCache: new QueryCache({
    onError: (error) => {
      const status = (error as { status?: number; code?: string })?.status;
      const code = (error as { code?: string })?.code;
      if (status === 401 || code === "PGRST301") {
        lockNow();
        queryClient.clear();
        void supabase.auth.signOut();
      }
    },
  }),
});

/** Everything sits behind auth. Signed-out users only ever see the sign-in screen. */
function Gate() {
  const { session, loading, recovering } = useAuth();
  if (loading) return <Skeleton rows={5} />;
  if (!session) return <SignIn />;
  // A reset link produces a valid session, so this has to come BEFORE the app —
  // otherwise the person who came to change their password lands straight in
  // their books and never changes it.
  if (recovering) return <ChoosePassword />;
  return (
    <PinGate>
      <CompanyProvider>
        <VoucherOverlayProvider>
          <Shell>
            <Outlet />
          </Shell>
        </VoucherOverlayProvider>
      </CompanyProvider>
    </PinGate>
  );
}


const rootRoute = createRootRoute({ component: Gate, errorComponent: RouteError });

const routes = [
  createRoute({ getParentRoute: () => rootRoute, path: "/", component: Home }),
  createRoute({ getParentRoute: () => rootRoute, path: "/entries", component: EntryList }),
  createRoute({ getParentRoute: () => rootRoute, path: "/entry/new", component: GuidedEntry }),
  createRoute({ getParentRoute: () => rootRoute, path: "/entry/advanced", component: NewEntry }),
  createRoute({ getParentRoute: () => rootRoute, path: "/parties", component: Parties }),
  createRoute({ getParentRoute: () => rootRoute, path: "/investors", component: Investors }),
  createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: Settings }),
  createRoute({ getParentRoute: () => rootRoute, path: "/reports", component: ReportHub }),
  createRoute({ getParentRoute: () => rootRoute, path: "/more", component: More }),
  createRoute({ getParentRoute: () => rootRoute, path: "/data", component: ImportExport }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/opening-balances",
    component: OpeningBalances,
  }),
  createRoute({ getParentRoute: () => rootRoute, path: "/bills", component: Bills }),
  createRoute({ getParentRoute: () => rootRoute, path: "/bills/new", component: BillEntry }),
  createRoute({ getParentRoute: () => rootRoute, path: "/accounts", component: AccountList }),
  createRoute({ getParentRoute: () => rootRoute, path: "/health", component: BookHealth }),
  createRoute({ getParentRoute: () => rootRoute, path: "/activity", component: ActivityLog }),
  createRoute({ getParentRoute: () => rootRoute, path: "/company/new", component: NewCompany }),
  createRoute({ getParentRoute: () => rootRoute, path: "/reports/trial-balance", component: TrialBalance }),
  createRoute({ getParentRoute: () => rootRoute, path: "/reports/profit-loss", component: ProfitAndLoss }),
  createRoute({ getParentRoute: () => rootRoute, path: "/reports/balance-sheet", component: BalanceSheet }),
  createRoute({ getParentRoute: () => rootRoute, path: "/reports/ledger", component: GeneralLedger }),
  createRoute({ getParentRoute: () => rootRoute, path: "/reports/cash-book", component: CashBook }),
  // referenced by the Next Action engine; screen lands in a later increment
  createRoute({ getParentRoute: () => rootRoute, path: "/capex", component: Capex }),
  // The fast way to record fit-out spend on site. Renders the same RecipeForm
  // as /entry/new — a different door, not a different room.
  createRoute({ getParentRoute: () => rootRoute, path: "/site", component: SiteExpense }),
  // Unified: the one place both books are shown merged together. See
  // UnifiedHub.tsx for why this is deliberately kept apart from /reports/*.
  createRoute({ getParentRoute: () => rootRoute, path: "/unified", component: UnifiedHub }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/unified/trial-balance",
    component: () => <TrialBalance unified />,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/unified/profit-loss",
    component: () => <ProfitAndLoss unified />,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/unified/balance-sheet",
    component: () => <BalanceSheet unified />,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/unified/cash-book",
    component: () => <CashBook unified />,
  }),
];

const router = createRouter({
  routeTree: rootRoute.addChildren(routes),
  defaultErrorComponent: RouteError,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <RouterProvider router={router} />
        </AuthProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
