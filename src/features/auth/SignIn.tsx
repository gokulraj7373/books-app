import { useState } from "react";
import { supabase } from "../../lib/supabase";
import { useAuth } from "./AuthProvider";
import { Alert, Button, Card, Field, inputClass } from "../../components/ui";
import { errorMessage } from "../../lib/errors";

type Mode = "signin" | "signup" | "forgot";

export function SignIn() {
  const { signedOutReason } = useAuth();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function go(next: Mode) {
    setMode(next);
    setError(null);
    setNotice(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { full_name: fullName || email.split("@")[0] } },
        });
        if (error) throw error;
        if (!data.session) {
          setNotice("Check your email to confirm your address, then sign in.");
          setMode("signin");
        }
      } else if (mode === "forgot") {
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/`,
        });
        if (error) throw error;
        // Deliberately the same message whether or not the address is
        // registered. Saying "no such account" turns this box into a way to
        // find out who banks here.
        setNotice(
          "If that address has an account, a reset link is on its way. Open it on this device and you will be asked to choose a new password.",
        );
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
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
          <p className="text-sm text-muted">
            Double-entry books for businesses that start by building something.
          </p>
        </div>

        {/* A session that expires mid-entry used to drop the user here with no
            explanation at all, which reads exactly like the app losing their
            work. It has not — nothing was saved that was not already saved. */}
        {signedOutReason && mode === "signin" && (
          <div className="mb-3">
            <Alert tone="warn" title="You were signed out">
              {signedOutReason} Nothing you had already recorded is affected.
            </Alert>
          </div>
        )}

        <Card className="p-5">
          <form onSubmit={submit} className="space-y-4">
            {mode === "forgot" && (
              <p className="text-sm text-muted">
                Enter the email address you sign in with and we will send a link to set a new
                password.
              </p>
            )}

            {mode === "signup" && (
              <Field label="Your name">
                <input
                  className={inputClass}
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  autoComplete="name"
                  placeholder="Tharun"
                />
              </Field>
            )}

            <Field label="Email" required>
              <input
                className={inputClass}
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                placeholder="you@company.com"
              />
            </Field>

            {mode !== "forgot" && (
              <Field
                label="Password"
                required
                hint={mode === "signup" ? "At least 8 characters." : undefined}
              >
                <input
                  className={inputClass}
                  type="password"
                  required
                  /* Only enforced when CHOOSING a password. On the sign-in form
                     it locked out anyone whose existing password was shorter
                     than the rule we adopted later — the browser refused to
                     submit and gave a validation bubble, not an error the user
                     could act on. The server is what judges an existing
                     password; the form's job is not to second-guess it. */
                  minLength={mode === "signup" ? 8 : undefined}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={mode === "signup" ? "new-password" : "current-password"}
                />
              </Field>
            )}

            {error && <Alert tone="danger">{error}</Alert>}
            {notice && <Alert tone="info">{notice}</Alert>}

            <Button type="submit" disabled={busy} className="w-full">
              {busy
                ? "Working…"
                : mode === "signin"
                  ? "Sign in"
                  : mode === "signup"
                    ? "Create account"
                    : "Send the reset link"}
            </Button>
          </form>

          {mode === "signin" && (
            <div className="mt-3 text-center">
              <button
                type="button"
                className="text-sm font-semibold text-navy underline underline-offset-2"
                onClick={() => go("forgot")}
              >
                Forgotten your password?
              </button>
            </div>
          )}

          <div className="mt-4 border-t border-line pt-4 text-center text-sm text-muted">
            {mode === "signin" ? (
              <>
                New here?{" "}
                <button
                  className="font-semibold text-navy underline underline-offset-2"
                  onClick={() => go("signup")}
                >
                  Create an account
                </button>
              </>
            ) : (
              <>
                {mode === "forgot" ? "Remembered it?" : "Already have an account?"}{" "}
                <button
                  className="font-semibold text-navy underline underline-offset-2"
                  onClick={() => go("signin")}
                >
                  Sign in
                </button>
              </>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
