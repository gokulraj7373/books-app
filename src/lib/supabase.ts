import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!url || !key) {
  throw new Error(
    "Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY. Copy .env.example to .env and fill it in.",
  );
}

/**
 * The one Supabase client for the app.
 *
 * This uses the PUBLISHABLE key, which is safe to ship to browsers: it carries
 * no privileges of its own, so every read and write is still decided by RLS and
 * by `save_journal_entry`. The service-role key bypasses RLS entirely and must
 * never appear in frontend code, in `.env` files that get committed, or in any
 * bundle.
 */
export const supabase = createClient(url, key, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    /**
     * PKCE rather than the implicit flow.
     *
     * The implicit flow returns the access token in the URL FRAGMENT, so it
     * passes through the address bar, browser history, and anything that reads
     * the referrer. PKCE returns a single-use code that is worthless without
     * the verifier this browser generated and kept to itself. It matters most
     * for the password-reset link, which arrives by email and is therefore
     * already sitting in a mailbox somewhere.
     */
    flowType: "pkce",
  },
});
