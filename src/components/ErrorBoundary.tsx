import { Component, type ErrorInfo, type ReactNode } from "react";
import { errorMessage } from "../lib/errors";

/* ============================================================================
   What the user sees when a screen throws.

   There was nothing here before. Any render error — a report with an
   unexpected shape, a null where a number was assumed — unmounted the whole
   tree and left a white page. On a phone, with no console open, that is
   indistinguishable from the app being broken or the data being gone.

   Nothing about this screen touches the ledger. It says what happened, offers
   the two things that actually help, and makes clear that the books are safe:
   an entry is either posted in the database or it is not, and a screen falling
   over cannot change which.
   ========================================================================= */

function Fallback({ error, reset }: { error: unknown; reset?: () => void }) {
  return (
    <div className="flex min-h-full items-center justify-center bg-canvas px-4 py-10">
      <div className="w-full max-w-sm space-y-4 text-center">
        <div className="text-2xl font-extrabold tracking-tight text-navy">
          Books<span className="text-gold">.</span>
        </div>
        <h1 className="text-lg font-bold text-ink">This screen ran into a problem</h1>
        <p className="text-sm text-muted">
          Your books are not affected. Nothing was changed by this — an entry is either saved in the
          database or it is not, and a screen failing cannot alter that.
        </p>
        <p className="rounded-xl border border-line bg-card px-3 py-2 text-left text-xs break-words text-muted">
          {errorMessage(error)}
        </p>
        <div className="flex flex-col gap-2">
          {reset && (
            <button
              type="button"
              onClick={reset}
              className="w-full rounded-xl bg-navy px-4 py-3 text-sm font-semibold text-white"
            >
              Try this screen again
            </button>
          )}
          <button
            type="button"
            onClick={() => window.location.assign("/")}
            className="w-full rounded-xl border border-line bg-card px-4 py-3 text-sm font-semibold text-ink"
          >
            Back to the start
          </button>
        </div>
      </div>
    </div>
  );
}

/** Route-level error component, wired into the router's `defaultErrorComponent`. */
export function RouteError({ error, reset }: { error: unknown; reset?: () => void }) {
  return <Fallback error={error} reset={reset} />;
}

/**
 * The outermost net. The router's own error component covers anything thrown
 * inside a route; this catches the rest — the providers, the shell, and the
 * router itself.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: unknown }> {
  state: { error: unknown } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // No telemetry service here, and deliberately so — a bookkeeping app should
    // not ship its users' data anywhere by default. The console is what a
    // developer sitting with the user can actually read.
    console.error("Unhandled render error", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return <Fallback error={this.state.error} reset={() => this.setState({ error: null })} />;
    }
    return this.props.children;
  }
}
