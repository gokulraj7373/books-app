import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useAuth } from "./AuthProvider";
import {
  clearPinAfterPassword,
  isUnlocked,
  knownToHavePin,
  pinIsSet,
  rememberHasPin,
  verifyPin,
} from "../../lib/pinLock";
import { errorMessage } from "../../lib/errors";
import { Skeleton } from "../../components/ui";

/* ============================================================================
   The lock screen.

   Sits between sign-in and the app. It re-locks when the tab has been hidden
   past the timeout — leaving the phone on the desk is exactly the case this
   guards, so returning to a still-open tab must not be a free pass.

   IT FAILS CLOSED.

   It used to `.catch(() => setLocked(false))`: any error from `has_user_pin`
   rendered the entire app. Blocking that one named request in DevTools was a
   permanent skeleton key, which made the lock decorative. Now a failed check
   falls back to what we already learned about this user (see `knownToHavePin`),
   and where we have learned nothing it says so plainly instead of guessing —
   because guessing "no PIN" is the one answer that can be exploited, and
   guessing "PIN" would strand a user who has never set one.
   ========================================================================= */

type Gate =
  | { state: "checking" }
  | { state: "open" }
  | { state: "locked" }
  | { state: "unreachable"; error: string };

export function PinGate({ children }: { children: ReactNode }) {
  const { signOut, user } = useAuth();
  const userId = user?.id ?? "";
  const [gate, setGate] = useState<Gate>({ state: "checking" });
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  /** null = not asked yet; "stale" = asked, but the sign-in was too long ago. */
  const [forgot, setForgot] = useState<null | "stale" | "trying">(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const check = useCallback(async (): Promise<Gate> => {
    if (!userId) return { state: "checking" };
    try {
      const set = await pinIsSet();
      rememberHasPin(userId, set);
      return set && !isUnlocked(userId) ? { state: "locked" } : { state: "open" };
    } catch (err) {
      // Cannot ask the server. If we already know this user has a PIN, the only
      // safe answer is to demand it — the PIN itself is verified server-side, so
      // an offline attacker gains nothing by reaching this screen.
      if (knownToHavePin(userId)) return { state: "locked" };
      // We have never had an answer for this user. Locking would trap someone
      // who has no PIN to type; opening would hand the app to anyone who can
      // make one request fail. Neither — say what is wrong and offer a way out.
      return { state: "unreachable", error: errorMessage(err) };
    }
  }, [userId]);

  useEffect(() => {
    let alive = true;
    void check().then((g) => alive && setGate(g));
    return () => {
      alive = false;
    };
  }, [check]);

  // Re-lock once the unlock window has passed, so a device left on the desk
  // does not stay open.
  useEffect(() => {
    if (gate.state !== "open" || !userId) return;
    const t = setInterval(() => {
      if (isUnlocked(userId)) return;
      if (knownToHavePin(userId)) {
        setGate({ state: "locked" });
        return;
      }
      void pinIsSet()
        .then((set) => {
          rememberHasPin(userId, set);
          if (set) setGate({ state: "locked" });
        })
        // Unreachable mid-session with no record of a PIN: leave the app open.
        // The user is already inside, and every write is authorised server-side
        // regardless of this screen.
        .catch(() => {});
    }, 30_000);
    return () => clearInterval(t);
  }, [gate.state, userId]);

  useEffect(() => {
    if (gate.state === "locked") inputRef.current?.focus();
  }, [gate.state]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setChecking(true);
    setError(null);
    try {
      if (await verifyPin(pin, userId)) {
        setPin("");
        setGate({ state: "open" });
        return;
      }
      setPin("");
      // The server counts the failures and locks the PIN itself after five, so
      // there is no client-side tally to keep — and none to bypass.
      setError("That PIN is not right.");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setChecking(false);
    }
  }

  async function forgetPin() {
    setForgot("trying");
    setError(null);
    try {
      if (await clearPinAfterPassword(userId)) {
        setGate({ state: "open" });
        return;
      }
      // Too long since the password was typed. Say what to do, rather than
      // showing an error for something the user has not done wrong.
      setForgot("stale");
    } catch (err) {
      setError(errorMessage(err));
      setForgot(null);
    }
  }

  if (gate.state === "checking") return <Skeleton rows={4} />;
  if (gate.state === "open") return <>{children}</>;

  if (gate.state === "unreachable") {
    return (
      <Frame>
        <p className="text-sm font-semibold text-ink">Cannot reach the server</p>
        <p className="text-xs text-muted">
          Your books need a connection to open, and the app will not guess whether this device
          should be unlocked. Check your connection and try again.
        </p>
        <p className="rounded-xl border border-line bg-card px-3 py-2 text-left text-xs break-words text-muted">
          {gate.error}
        </p>
        <button
          type="button"
          onClick={() => {
            setGate({ state: "checking" });
            void check().then(setGate);
          }}
          className="w-full rounded-xl bg-navy px-4 py-3 text-sm font-semibold text-white"
        >
          Try again
        </button>
        <SignOutLink onClick={() => void signOut()} />
      </Frame>
    );
  }

  return (
    <Frame onSubmit={submit}>
      <p className="text-sm font-semibold text-ink">Enter your PIN</p>
      <input
        ref={inputRef}
        type="password"
        inputMode="numeric"
        autoComplete="off"
        maxLength={8}
        value={pin}
        onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
        className="w-full rounded-2xl border border-line bg-card px-4 py-3 text-center text-2xl tracking-[0.5em] tnum"
        aria-label="PIN"
      />
      {error && <p className="text-sm font-semibold text-danger">{error}</p>}
      <button
        type="submit"
        disabled={checking || pin.length < 4}
        className="w-full rounded-xl bg-navy px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
      >
        {checking ? "Checking…" : "Unlock"}
      </button>

      {forgot === "stale" ? (
        <p className="text-xs text-muted">
          Sign out below, sign in with your email and password, and you can clear the PIN from
          this screen for the next five minutes.
        </p>
      ) : (
        <button
          type="button"
          onClick={() => void forgetPin()}
          disabled={forgot === "trying"}
          className="w-full text-xs font-semibold text-navy underline underline-offset-2 disabled:opacity-50"
        >
          {forgot === "trying" ? "Checking…" : "Forgotten your PIN?"}
        </button>
      )}

      <SignOutLink onClick={() => void signOut()} />
    </Frame>
  );
}

function SignOutLink({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-xs font-semibold text-muted hover:text-danger"
    >
      Sign out
    </button>
  );
}

function Frame({
  children,
  onSubmit,
}: {
  children: ReactNode;
  onSubmit?: (e: React.FormEvent) => void;
}) {
  const inner = (
    <>
      <div className="text-2xl font-extrabold tracking-tight text-navy">
        Books<span className="text-gold">.</span>
      </div>
      {children}
    </>
  );
  return (
    <div className="flex min-h-full items-center justify-center bg-canvas px-4 py-10">
      {onSubmit ? (
        <form onSubmit={onSubmit} className="w-full max-w-xs space-y-4 text-center">
          {inner}
        </form>
      ) : (
        <div className="w-full max-w-xs space-y-4 text-center">{inner}</div>
      )}
    </div>
  );
}
