/* ============================================================================
   A party's name, wherever it appears, is a way IN to their history.

   The party ledger already existed and already showed everything — every
   debit, credit and advance with a running balance. What was missing was any
   route to it: you could read "Sushant Civil Contractor" on a voucher and have
   no way to ask "what else have I done with him?" other than remembering a
   separate screen existed and hunting down the name by hand.

   One component, used everywhere a party name is printed, closes that. It is
   deliberately styled as an underlined link rather than a button so it reads
   as somewhere to GO, and it prints as plain text (`no-underline` under print
   styles is unnecessary — a paper voucher has no links to follow, and the name
   still reads correctly).
   ========================================================================= */

import { Link } from "@tanstack/react-router";

export function PartyLink({
  partyId,
  name,
  className = "",
}: {
  partyId: string | null | undefined;
  name: string | null | undefined;
  className?: string;
}) {
  if (!name) return null;
  // A party recorded before this had an id, or a line with no party tagged,
  // still shows the name — it just has nowhere to point.
  if (!partyId) return <span className={className}>{name}</span>;

  return (
    <Link
      to="/parties"
      search={{ party: partyId }}
      className={`underline decoration-navy/30 underline-offset-2 transition-colors hover:decoration-navy ${className}`}
      title={`See everything recorded with ${name}`}
    >
      {name}
    </Link>
  );
}
