/* ============================================================================
   Turning an error into something a human can act on.

   Supabase returns a plain object ({ message, details, hint, code }), NOT an
   Error. So the common `err instanceof Error ? err.message : String(err)` fell
   through to String({}) and printed a literal "[object Object]" on screen —
   which tells the user nothing at all about what went wrong.
   ========================================================================= */

export function errorMessage(err: unknown): string {
  if (err == null) return "Something went wrong. Please try again.";
  if (typeof err === "string") return err;
  if (err instanceof Error && err.message) return clean(err.message);

  if (typeof err === "object") {
    const e = err as Record<string, unknown>;
    const parts = [e.message, e.details, e.hint]
      .filter((v): v is string => typeof v === "string" && v.trim() !== "")
      .map(clean);
    if (parts.length) return [...new Set(parts)].join(" ");
    try {
      const j = JSON.stringify(err);
      if (j && j !== "{}") return j;
    } catch {
      /* circular — fall through */
    }
  }
  return "Something went wrong. Please try again.";
}

/** Strips Postgres prefixes so the message reads as plain English. */
function clean(m: string): string {
  return m
    .replace(/^(new row for relation|error:|ERROR:)\s*/i, "")
    .replace(/^P\d{4}:\s*/, "")
    .trim();
}
