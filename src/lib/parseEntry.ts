/* ============================================================================
   One typed sentence -> a filled-in entry form.

   "paid 25000 to sushant for cement"  ->  amount Rs 25,000, party "sushant",
   note "cement", recipe "I paid a running cost", date today.

   WHAT THIS IS NOT: it does not post anything. It fills the form in and the
   user reads a plain-English sentence describing the effect before pressing
   anything. Every guard that already exists still runs underneath —
   `validateLines`, then `save_journal_entry` in the database. So the worst a
   parsing mistake can do is suggest something wrong that the user rejects; it
   can never write a wrong entry. That is the whole reason this is allowed to
   guess at all.

   NO AI, DELIBERATELY. `PROGRESS.md` defers AI to Phase 5, and for this job it
   would be the wrong tool anyway: the vocabulary is small and known (the
   recipes' own keywords), the arithmetic must be exact, and an LLM key cannot
   live in a static frontend without shipping to every browser. Everything here
   is a pure function, so a wrong guess is a failing test rather than a bill.
   ========================================================================= */

import { toPaise } from "./money";
import { searchRecipes, type Recipe } from "./recipes";

export type ParsedEntry = {
  /** best-matching recipe, or null when nothing scored above zero */
  recipe: Recipe | null;
  /** other plausible recipes, best first — offered when confidence is low */
  alternatives: Recipe[];
  /** the whole transaction in paise, or null when no amount was found */
  amountPaise: number | null;
  /** ISO yyyy-mm-dd */
  date: string;
  /** true when the date came from the text rather than defaulting to today */
  dateWasTyped: boolean;
  /** the name as typed — matching it to an existing party happens over the wire */
  partyName: string | null;
  /** whatever was left after amount, date and party were taken out */
  note: string | null;
  /**
   * Set when the sentence names a direction-ambiguous word on its own terms
   * ("loan", "advance"). The UI must show this and must NOT auto-pick.
   */
  ambiguity: string | null;
  /** 0-1. Below `CONFIRM_THRESHOLD` the UI should present alternatives. */
  confidence: number;
};

/** Below this, show the alternatives rather than committing to one reading. */
export const CONFIRM_THRESHOLD = 0.5;

/* ----------------------------------------------------------------------------
   Amounts, written the way people in India actually write them.

   "1,25,000" is Indian digit grouping and is NOT parseable by a naive
   thousands-separator strip that assumes groups of three. "25k", "1.5 lakh"
   and "2cr" all appear in real messages. Getting this wrong is the most
   expensive possible failure in this file, so each form is tested.
---------------------------------------------------------------------------- */
const MULTIPLIERS: Array<{ re: RegExp; factor: number }> = [
  { re: /\b(\d+(?:\.\d+)?)\s*(?:crores?|cr)\b/i, factor: 10_000_000 },
  { re: /\b(\d+(?:\.\d+)?)\s*(?:lakhs?|lacs?|lakh|lac|l)\b/i, factor: 100_000 },
  { re: /\b(\d+(?:\.\d+)?)\s*k\b/i, factor: 1_000 },
];

/** A bare number, allowing Indian or Western grouping and optional decimals. */
const BARE_AMOUNT = /(?:₹|rs\.?|inr)?\s*(\d[\d,]*(?:\.\d{1,2})?)/i;

export type AmountHit = { paise: number; text: string };

export function findAmount(text: string): AmountHit | null {
  // Suffixed forms first: "25k" must not be read as the bare number 25.
  for (const { re, factor } of MULTIPLIERS) {
    const m = re.exec(text);
    if (m) {
      const n = Number(m[1]);
      if (!Number.isFinite(n) || n <= 0) continue;
      // Multiply in rupees, then convert once — `toPaise` does the rounding.
      return { paise: toPaise(String(n * factor)), text: m[0] };
    }
  }

  const m = BARE_AMOUNT.exec(text);
  if (!m) return null;
  const cleaned = m[1].replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n <= 0) return null;
  return { paise: toPaise(cleaned), text: m[0].trim() };
}

/* ----------------------------------------------------------------------------
   Dates. Only forms that are unambiguous in Indian usage.

   Bare "12/08" is read as DAY/MONTH, which is what every Indian invoice means.
   An American reading would silently book December 8th, so the format is
   pinned rather than guessed.
---------------------------------------------------------------------------- */
const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};

const iso = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export type DateHit = { date: string; text: string };

export function findDate(text: string, today: Date): DateHit | null {
  const lower = text.toLowerCase();

  const rel: Array<[RegExp, number]> = [
    [/\bday before yesterday\b/, -2],
    [/\byesterday\b/, -1],
    [/\btoday\b/, 0],
  ];
  for (const [re, delta] of rel) {
    const m = re.exec(lower);
    if (m) {
      const d = new Date(today);
      d.setDate(d.getDate() + delta);
      return { date: iso(d), text: m[0] };
    }
  }

  // "12 aug", "12 august 2026", "aug 12"
  const dm = /\b(\d{1,2})\s*(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?\s*(\d{4})?\b/i.exec(text);
  if (dm) {
    const mon = MONTHS[dm[2].toLowerCase().slice(0, 4)] ?? MONTHS[dm[2].toLowerCase().slice(0, 3)];
    if (mon !== undefined) {
      const day = Number(dm[1]);
      const year = dm[3] ? Number(dm[3]) : today.getFullYear();
      if (day >= 1 && day <= 31) return { date: iso(new Date(year, mon, day)), text: dm[0].trim() };
    }
  }
  const md = /\b([a-z]{3,9})\.?\s+(\d{1,2})\s*(?:st|nd|rd|th)?\s*(\d{4})?\b/i.exec(text);
  if (md) {
    const mon = MONTHS[md[1].toLowerCase().slice(0, 4)] ?? MONTHS[md[1].toLowerCase().slice(0, 3)];
    if (mon !== undefined) {
      const day = Number(md[2]);
      const year = md[3] ? Number(md[3]) : today.getFullYear();
      if (day >= 1 && day <= 31) return { date: iso(new Date(year, mon, day)), text: md[0].trim() };
    }
  }

  // 12/08, 12-08-2026, 12.08.26 — always day first.
  const num = /\b(\d{1,2})[/\-.](\d{1,2})(?:[/\-.](\d{2,4}))?\b/.exec(text);
  if (num) {
    const day = Number(num[1]);
    const mon = Number(num[2]) - 1;
    if (day >= 1 && day <= 31 && mon >= 0 && mon <= 11) {
      let year = today.getFullYear();
      if (num[3]) {
        const y = Number(num[3]);
        year = y < 100 ? 2000 + y : y;
      }
      return { date: iso(new Date(year, mon, day)), text: num[0] };
    }
  }

  return null;
}

/* ----------------------------------------------------------------------------
   The party.

   People write "to sushant", "from ramesh traders", "paid sushant". The name
   runs until a word that starts a new clause — "for cement", "on 12 aug".
   Deliberately conservative: a missed name costs one tap in the form, an
   invented one risks creating a duplicate party, which the owner specifically
   does not want.
---------------------------------------------------------------------------- */
const CLAUSE_BREAKS = new Set([
  "for", "on", "at", "via", "by", "through", "against", "towards", "toward",
  "from", "to", "in", "with", "as", "and", "cash", "bank", "upi", "cheque",
  "neft", "rtgs", "imps", "today", "yesterday",
]);

/**
 * Words that introduce a party but are not part of the name.
 *
 * "for" is deliberately NOT here. "paid 50000 for plumbing work" names a
 * PURPOSE, not a person — reading it as a party swallowed the very words that
 * identify the transaction and left the sentence meaningless. "for" introduces
 * the note; only "to", "from" and a bare "paid <name>" introduce a party.
 */
const PARTY_LEADS = ["to", "from", "paid"];

export function findParty(words: string[]): { name: string; used: number[] } | null {
  for (const lead of PARTY_LEADS) {
    const i = words.indexOf(lead);
    if (i === -1 || i === words.length - 1) continue;
    const taken: number[] = [];
    const parts: string[] = [];
    for (let j = i + 1; j < words.length; j++) {
      const w = words[j];
      if (CLAUSE_BREAKS.has(w)) break;
      // A number is never part of a name — it is the amount or a date.
      if (/^\d/.test(w)) break;
      parts.push(w);
      taken.push(j);
      // Names are short. Three words is "Sushant Civil Contractor".
      if (parts.length >= 3) break;
    }
    if (parts.length > 0) {
      taken.push(i); // consume the lead word too
      return { name: parts.join(" "), used: taken };
    }
  }
  return null;
}

/* ----------------------------------------------------------------------------
   Which recipe the sentence means.

   `searchRecipes` requires EVERY word to match something, which is right for a
   search box and wrong here: a typed sentence carries names, amounts and filler
   that match nothing. So this scores by how many words landed, and ignores the
   rest.
---------------------------------------------------------------------------- */
export function scoreRecipes(recipes: Recipe[], words: string[]): Array<{ recipe: Recipe; score: number }> {
  const split = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

  const scored = recipes.map((r) => {
    const keys = (r.keywords ?? []).map((k) => k.toLowerCase());
    // Match on WHOLE WORDS, never substrings. A raw `keyText.includes(w)` let
    // "paid" match the "repaid" inside "loan repaid", which scored a repayment
    // recipe for an ordinary payment — a confident wrong answer, the worst kind.
    const keyWords = new Set(keys.flatMap(split));
    const titleWords = new Set(split(r.title));
    const blurbWords = new Set(split(r.blurb));

    let score = 0;
    for (const w of words) {
      if (w.length < 3) continue; // "to", "a", "i" carry no signal
      if (keys.includes(w)) score += 5; // the whole keyword, exactly
      else if (titleWords.has(w)) score += 4;
      else if (keyWords.has(w)) score += 3;
      else if (blurbWords.has(w)) score += 1;
    }
    return { recipe: r, score };
  });
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
}

/* ----------------------------------------------------------------------------
   Direction-ambiguous words, reused from the recipe layer's own list so the
   two cannot drift apart. `directionNote` there only fires when the query is
   JUST the ambiguous word; in a full sentence we still want the warning, so
   the check is on any word present.
---------------------------------------------------------------------------- */
const AMBIGUOUS: Record<string, string> = {
  loan: "This could be money you LENT OUT or money the business BORROWED — they are opposite entries. Check the tile below is the one you meant.",
  loans: "This could be money you LENT OUT or money the business BORROWED — they are opposite entries. Check the tile below is the one you meant.",
  borrow: "Money the business BORROWED has no tile yet — only lending out does. Check carefully.",
  borrowed: "Money the business BORROWED has no tile yet — only lending out does. Check carefully.",
  advance: "An advance you PAID and an advance you RECEIVED are opposite entries. Check the tile below.",
  refund: "A refund coming BACK to you and one you GIVE are opposite entries. Check the tile below.",
  transfer: "Between your own bank and cash is a contra. Money to someone else is a payment. Check the tile below.",
  deposit: "Cash into your own bank is a contra. A deposit lodged with a landlord is an advance. Check the tile below.",
};

/* ========================================================================= */

export function parseEntry(
  text: string,
  recipes: Recipe[],
  today: Date = new Date(),
): ParsedEntry {
  const raw = text.trim();

  const amount = findAmount(raw);
  const dateHit = findDate(raw, today);

  // Take the amount and date out before looking for words, so "25000" and
  // "12 aug" cannot be mistaken for a name or a keyword.
  let rest = raw;
  if (amount) rest = rest.replace(amount.text, " ");
  if (dateHit) rest = rest.replace(dateHit.text, " ");

  const words = rest.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

  const party = findParty(words);
  const partyWords = new Set(party?.used ?? []);
  const remaining = words.filter((_, i) => !partyWords.has(i));

  const ranked = scoreRecipes(recipes, remaining);
  const best = ranked[0] ?? null;

  // Confidence: how far clear of the runner-up the winner is. A clear leader
  // is trustworthy; two tiles scoring the same means the sentence genuinely
  // did not say which, and the UI must ask rather than pick.
  let confidence = 0;
  if (best) {
    const second = ranked[1]?.score ?? 0;
    const spread = best.score === 0 ? 0 : (best.score - second) / best.score;
    // A high absolute score with a clear lead is the confident case.
    confidence = Math.min(1, (best.score / 10) * 0.5 + spread * 0.5);
  }

  const ambiguity = words.map((w) => AMBIGUOUS[w]).find(Boolean) ?? null;

  // Anything not claimed by amount, date, party or a recipe keyword is the
  // user's own description — worth keeping as the narration.
  const claimed = new Set<string>();
  if (best) {
    for (const k of best.recipe.keywords ?? []) claimed.add(k.toLowerCase());
    for (const w of best.recipe.title.toLowerCase().split(/[^a-z0-9]+/)) claimed.add(w);
  }
  const noteWords = remaining.filter(
    (w) => w.length > 2 && !claimed.has(w) && !CLAUSE_BREAKS.has(w),
  );

  return {
    recipe: best?.recipe ?? null,
    alternatives: ranked.slice(1, 4).map((r) => r.recipe),
    amountPaise: amount?.paise ?? null,
    date: dateHit?.date ?? iso(today),
    dateWasTyped: !!dateHit,
    partyName: party?.name ?? null,
    note: noteWords.length ? noteWords.join(" ") : null,
    ambiguity,
    confidence,
  };
}

/**
 * Re-exported so a caller can offer the plain search behaviour ("show me tiles
 * matching what I typed") from the same box, without importing two modules.
 */
export { searchRecipes };
