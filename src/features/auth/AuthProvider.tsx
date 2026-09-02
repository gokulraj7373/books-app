import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "../../lib/supabase";
import { lockNow } from "../../lib/pinLock";

type AuthState = {
  session: Session | null;
  user: User | null;
  loading: boolean;
  signOut: () => Promise<void>;
  /** Set when the session ended on its own — an expired or revoked refresh token. */
  signedOutReason: string | null;
  /**
   * True between clicking a password-reset link and choosing the new password.
   * The session is real at that point, so without this the app would simply
   * open — and the user who came to change their password would never be asked
   * for one.
   */
  recovering: boolean;
  recoveryDone: () => void;
};

const Ctx = createContext<AuthState>({
  session: null,
  user: null,
  loading: true,
  signOut: async () => {},
  signedOutReason: null,
  recovering: false,
  recoveryDone: () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [signedOutReason, setSignedOutReason] = useState<string | null>(null);
  const [recovering, setRecovering] = useState(false);
  const qc = useQueryClient();

  useEffect(() => {
    let alive = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!alive) return;
      setSession(data.session);
      setLoading(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      if (!alive) return;

      // SIGNED_OUT arrives both when the user asks and when the refresh token
      // is rejected — expired, revoked, or the password was changed elsewhere.
      // Untreated, the second case dumped whoever was mid-entry at the login
      // screen with no explanation. Whatever the cause, the lock closes and the
      // cache is emptied: nothing the previous session loaded may outlive it.
      if (event === "SIGNED_OUT") {
        lockNow();
        qc.clear();
        setSignedOutReason("Your session ended. Please sign in again.");
      }
      if (event === "SIGNED_IN") setSignedOutReason(null);

      // The reset link produces a genuine, fully-privileged session. Left
      // alone, the app would just open and the person who came to set a new
      // password would never be asked for one — leaving a password they have
      // already forgotten, or that someone else may know, still valid.
      if (event === "PASSWORD_RECOVERY") {
        setRecovering(true);
        setSignedOutReason(null);
      }

      setSession(s);
      setLoading(false);
    });

    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, [qc]);

  return (
    <Ctx.Provider
      value={{
        session,
        user: session?.user ?? null,
        loading,
        signedOutReason,
        recovering,
        recoveryDone: () => setRecovering(false),
        signOut: async () => {
          // Order matters only in that all three must happen. `onAuthStateChange`
          // does the same work when SIGNED_OUT fires, but doing it here too means
          // a failed network round trip cannot leave the previous user's data on
          // screen: the lock and the cache are ours to clear regardless.
          lockNow();
          qc.clear();
          await supabase.auth.signOut();
        },
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  return useContext(Ctx);
}
