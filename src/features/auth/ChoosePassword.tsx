import { useState } from "react";
import { supabase } from "../../lib/supabase";
import { useAuth } from "./AuthProvider";
import { Alert, Button, Card, Field, inputClass } from "../../components/ui";
import { errorMessage } from "../../lib/errors";

/* ============================================================================
   Setting a new password after following a reset link.

   Before this existed there was no password reset at all — and the lock screen
   told people that signing out and using their email was the way back in, which
   was a route to nowhere. Someone who forgot their password lost their books.

   The reset link creates a real session, so this screen has to stand in front
   of the app until the new password is actually saved. Otherwise the app simply
   opens and the old password — forgotten, or known to someone else — stays
   valid.
   ========================================================================= */

export function ChoosePassword() {
  const { recoveryDone, signOut } = useAuth();
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (password.length < 8) throw new Error("Use at least 8 characters.");
      if (password !== again) throw new Error("The two passwords do not match.");
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      recoveryDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="mb-2 text-3xl font-extrabold tracking-tight text-navy">
            Books<span className="text-gold">.</span>
          </div>
          <p className="text-sm text-muted">Choose a new password</p>
        </div>

        <Card className="p-5">
          <form onSubmit={submit} className="space-y-4">
            <Field label="New password" required hint="At least 8 characters.">
              <input
                className={inputClass}
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                autoFocus
              />
            </Field>

            <Field label="Type it again" required>
              <input
                className={inputClass}
                type="password"
                required
                value={again}
                onChange={(e) => setAgain(e.target.value)}
                autoComplete="new-password"
              />
            </Field>

            {error && <Alert tone="danger">{error}</Alert>}

            <Button type="submit" disabled={busy} className="w-full">
              {busy ? "Saving…" : "Save and continue"}
            </Button>
          </form>

          <p className="mt-4 border-t border-line pt-4 text-center text-xs text-muted">
            Your PIN is separate and has not changed.{" "}
            <button
              type="button"
              onClick={() => void signOut()}
              className="font-semibold text-navy underline underline-offset-2"
            >
              Sign out instead
            </button>
          </p>
        </Card>
      </div>
    </div>
  );
}
