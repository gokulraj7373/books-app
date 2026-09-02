/* ============================================================================
   Reuse the party you already have, or say plainly that a new one is coming.

   A duplicate party is quietly expensive: half of Sushant's history sits under
   "Sushant" and half under "Sushant Civil Contractor", so his balance is wrong
   on both and nobody notices until a reconciliation. Merging afterwards is a
   privileged operation that rewrites posted history.

   So the rule here is deliberately timid: reuse only when the answer is
   obvious, ask when there is more than one candidate, and never silently pick
   one of several. Being asked once is cheaper than merging later.
   ========================================================================= */

import type { DuplicateParty } from "./queries";

export type PartyResolution =
  | { kind: "none" }
  | { kind: "loading" }
  | { kind: "existing"; party: DuplicateParty }
  | { kind: "ambiguous"; options: DuplicateParty[] }
  | { kind: "new"; name: string };

/** Case and punctuation carry no meaning in a party name. */
export const normalizeName = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Decide what to do with a typed name, given the candidates the database
 * returned.
 *
 * NOTE ON REACH: the candidate list comes from `possible_duplicate_parties`,
 * which matches on a normalised PREFIX. That catches "sushant" -> "Sushant
 * Civil Contractor" and "sushanth" -> "Sushant..." but NOT a typo in the middle
 * ("susant"), because such a row is never returned to compare against. Closing
 * that needs trigram matching in Postgres; it is not something this function
 * can fake, and pretending otherwise would be worse than the gap.
 */
export function resolveParty(typed: string, candidates: DuplicateParty[]): PartyResolution {
  const key = normalizeName(typed);
  if (!key) return { kind: "none" };

  // An exact normalised match is unambiguous however many others came back.
  const exact = candidates.find((c) => normalizeName(c.name) === key);
  if (exact) return { kind: "existing", party: exact };

  if (candidates.length === 1) return { kind: "existing", party: candidates[0] };
  if (candidates.length > 1) return { kind: "ambiguous", options: candidates };
  return { kind: "new", name: typed };
}
