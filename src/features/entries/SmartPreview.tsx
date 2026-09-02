/* ============================================================================
   "What I understood" — shown BEFORE anything is filled in, let alone posted.

   The owner's requirement was blunt: it must be extremely smart, it must never
   post something wrong, and it must say out loud when it is about to create a
   new party rather than reusing an existing one.

   The safety design that makes this possible:
     1. Nothing here writes. It fills a form in; the form still validates and
        the database still has the final say.
     2. Everything understood is shown as a separate, correctable chip. There
        is no hidden inference.
     3. Anything NOT understood is listed just as plainly. Silence about a
        missing amount is how a wrong entry gets posted confidently.
     4. The party is resolved against the real chart of parties over the wire
        BEFORE the form opens, so "will create NEW" is a statement of fact, not
        a guess.
   ========================================================================= */

import { useQuery } from "@tanstack/react-query";
import { inr } from "../../lib/money";
import { possibleDuplicateParties } from "../../lib/queries";
import { CONFIRM_THRESHOLD, type ParsedEntry } from "../../lib/parseEntry";
import { resolveParty, type PartyResolution } from "../../lib/partyMatch";
import { Alert, Button } from "../../components/ui";

const Chip = ({ label, value, tone = "plain" }: { label: string; value: string; tone?: "plain" | "warn" }) => (
  <span
    className={`inline-flex flex-col rounded-xl border px-3 py-1.5 ${
      tone === "warn" ? "border-warn/40 bg-warnbg" : "border-line bg-canvas"
    }`}
  >
    <span className="text-[10px] font-bold tracking-wide text-muted uppercase">{label}</span>
    <span className="text-sm font-semibold text-ink tnum">{value}</span>
  </span>
);

export function SmartPreview({
  parsed,
  companyId,
  todayIso,
  onUse,
  onDismiss,
}: {
  parsed: ParsedEntry;
  companyId: string;
  todayIso: string;
  /** Called with the party name to use — the resolved existing name, or the new one. */
  onUse: (partyName: string | null) => void;
  onDismiss: () => void;
}) {
  // Resolved over the wire so "will create NEW" is a fact about the real chart
  // of parties, not an assumption. Skipped entirely when no name was typed.
  const dupQ = useQuery({
    queryKey: ["party-match", companyId, parsed.partyName],
    queryFn: () => possibleDuplicateParties(companyId, parsed.partyName!),
    enabled: !!parsed.partyName,
  });

  const resolution: PartyResolution = !parsed.partyName
    ? { kind: "none" }
    : dupQ.isLoading
      ? { kind: "loading" }
      : resolveParty(parsed.partyName, dupQ.data ?? []);

  if (!parsed.recipe) return null;

  const backdated = parsed.date !== todayIso;
  const missing: string[] = [];
  if (parsed.amountPaise === null) missing.push("the amount");
  if (!parsed.partyName && parsed.recipe.fields.some((f) => f.key === "party")) {
    missing.push("who it was with");
  }

  const chosenName =
    resolution.kind === "existing" ? resolution.party.name : (parsed.partyName ?? null);

  return (
    <div className="mt-3 rounded-2xl border border-navy/25 bg-card p-4 shadow-sm fade-in">
      <p className="text-xs font-bold tracking-wide text-muted uppercase">What I understood</p>

      <p className="mt-1.5 text-base font-bold text-navy">{parsed.recipe.title}</p>
      <p className="text-sm text-muted">{parsed.recipe.blurb}</p>

      {/* Every understood value, separately correctable. Nothing inferred is
          hidden — if it is going into the form, it is on screen first. */}
      <div className="mt-3 flex flex-wrap gap-2">
        {parsed.amountPaise !== null && <Chip label="Amount" value={inr(parsed.amountPaise)} />}
        <Chip
          label={backdated ? "Date (backdated)" : "Date"}
          value={parsed.date}
          tone={backdated ? "warn" : "plain"}
        />
        {chosenName && <Chip label="Party" value={chosenName} />}
        {parsed.note && <Chip label="Note" value={parsed.note} />}
      </div>

      {/* Backdating is allowed and normal — you record Tuesday's spend on
          Friday. It is flagged only so it is never a surprise. The recorded-at
          stamp and who recorded it are set by the server and cannot be edited
          from here, which is what makes the trail worth anything. */}
      {backdated && (
        <p className="mt-2 text-xs text-muted">
          This will be dated {parsed.date}, not today. The record of when you entered it, and that
          it was you, is stamped separately and cannot be changed.
        </p>
      )}

      {/* The owner's specific worry: silent duplicate parties. */}
      {resolution.kind === "loading" && (
        <p className="mt-3 text-sm text-muted">Checking whether this party already exists…</p>
      )}
      {resolution.kind === "existing" && (
        <p className="mt-3 text-sm text-ok">
          Using the party you already have: <strong>{resolution.party.name}</strong>
          {resolution.party.entry_count > 0 && ` · ${resolution.party.entry_count} entries so far`}
        </p>
      )}
      {resolution.kind === "ambiguous" && (
        <div className="mt-3">
          <Alert tone="warn" title="Which one did you mean?">
            More than one existing party matches “{parsed.partyName}”. Pick the right one on the next
            screen — creating a second copy would split their history in two.
            <span className="mt-1 block font-medium">
              {resolution.options.map((o) => o.name).join(" · ")}
            </span>
          </Alert>
        </div>
      )}
      {resolution.kind === "new" && (
        <div className="mt-3">
          <Alert tone="warn" title="This will create a NEW party">
            No existing party matches “{parsed.partyName}”. If they are already in your books under
            a slightly different spelling, go back and type that spelling instead — two records for
            one person splits their ledger.
          </Alert>
        </div>
      )}

      {parsed.ambiguity && (
        <div className="mt-3">
          <Alert tone="warn" title="Which way round?">
            {parsed.ambiguity}
          </Alert>
        </div>
      )}

      {missing.length > 0 && (
        <p className="mt-3 text-sm text-muted">
          Still needed: {missing.join(" and ")}. You will fill that in on the next screen.
        </p>
      )}

      {parsed.confidence < CONFIRM_THRESHOLD && parsed.alternatives.length > 0 && (
        <p className="mt-3 text-sm text-muted">
          Not certain — it could also be{" "}
          {parsed.alternatives.map((a) => `“${a.title}”`).join(" or ")}. Check before posting.
        </p>
      )}

      {/* Full-width and stacked on a phone so either action is a thumb away;
          inline on a laptop where a full-width button looks broken. */}
      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <Button onClick={() => onUse(chosenName)} className="sm:w-auto">
          Continue — I'll check it
        </Button>
        <Button variant="secondary" onClick={onDismiss} className="sm:w-auto">
          No, show all the tiles
        </Button>
      </div>
    </div>
  );
}
