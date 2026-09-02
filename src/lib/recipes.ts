/* ============================================================================
   Plain-language transactions -> correct double entries.

   The owner is not an accountant and should never be asked "which account do I
   debit?". Zoho, QuickBooks, Vyapar and Xero all work this way: the user says
   WHAT HAPPENED, the software derives the debit and the credit. The ledger
   underneath stays fully double-entry and CA-acceptable — only the question
   changes.

   Every recipe is a pure function so the generated entries can be unit-tested
   without a database or a browser. If a recipe is wrong, the test fails here,
   not three months later in a trial balance.
   ========================================================================= */

import type { Account } from "./queries";

export type RecipeField =
  | { key: "amount"; label: string; kind: "amount"; hint?: string }
  | { key: "date"; label: string; kind: "date" }
  | { key: "party"; label: string; kind: "party"; hint?: string; partyType?: string }
  // `moneyAccount` is the bank/cash side by default. When a filter is given it
  // becomes a normal account picker — used by "goods arrived", where the credit
  // side is the advance being used up rather than a bank account.
  | { key: "moneyAccount"; label: string; kind: "moneyAccount"; hint?: string; filter?: AccountFilter }
  | { key: "targetAccount"; label: string; kind: "account"; hint?: string; filter: AccountFilter }
  | { key: "note"; label: string; kind: "text"; hint?: string }
  | { key: "dueDate"; label: string; kind: "date"; hint?: string };

/* ----------------------------------------------------------------------------
   Which accounts a picker offers.

   SEMANTICS, stated once because getting this wrong is silent and expensive:
     - every predicate present must hold          (AND across predicates)
     - values inside one predicate are alternatives (OR within a predicate)
     - `anyOf` is a single predicate that holds when ANY child filter matches
     - `not` removes matches, whatever the rest says

   The original version ORed the predicates, so `{ capexRole: [...], subGroup:
   [...] }` quietly meant "either", and every call site had been written
   assuming "both". Rather than flip everything to AND — two call sites really
   do mean "either", e.g. a bill can be for an asset OR a cost — the meaning is
   now written down at each call site instead of being inherited by accident.
---------------------------------------------------------------------------- */
export type AccountFilter = {
  /** capex_role values that qualify */
  capexRole?: string[];
  /** account_type values that qualify */
  type?: Account["account_type"][];
  /** sub_group values that qualify */
  subGroup?: string[];
  /** holds when any one of these sub-filters matches — an explicit OR */
  anyOf?: AccountFilter[];
  /** anything matching this is removed, whatever the rest of the filter says */
  not?: AccountFilter;
  excludeBankCash?: boolean;
  /**
   * System accounts (Suspense, Exchange Rate Difference, the internal-only cash
   * account) are hidden by default. They exist for the app's own postings, and
   * offering "Exchange Rate Difference" as somewhere to book the electricity
   * bill is how a chart of accounts turns to soup. Set this only where a system
   * account is genuinely the right answer — the internal cash account is.
   */
  allowSystem?: boolean;
  /**
   * This picker is choosing a bank/cash account and must respect the book being
   * written to, exactly like the money picker does. Used by the bank↔cash
   * transfer, whose "to where?" side is a money account too — offering an
   * official bank account for an internal-book entry only fails at submit.
   */
  bookScopedMoney?: boolean;
};

/* ----------------------------------------------------------------------------
   What a recipe actually produces.

   This used to be `{ debitAccountId, creditAccountId }` — exactly two sides,
   with a separate heuristic guessing which of them carried the party. Two sides
   cannot express GST (cost + input credit against one payment), TDS (cost
   against a payment plus tax withheld), payroll, an EMI split, or a set-off
   between two balances of the same supplier. Those transactions were not
   missing from the app; they were INEXPRESSIBLE.

   Lines carry paise — integers — never a float or a typed string. `party: true`
   marks the line the party belongs on, which the recipe now states outright
   instead of the engine inferring it from which side happens to be a bank
   account. A set-off tags BOTH of the supplier's lines, and they correctly
   cancel: the set-off does not change what you and the supplier owe each other
   on net, it only shrinks both sides of it.
---------------------------------------------------------------------------- */
export type BuiltLine = {
  accountId: string;
  debitPaise: number;
  creditPaise: number;
  /** tag this line to the party the form collected */
  party?: boolean;
  /**
   * The line holding the value of the thing bought. GST input credit is split
   * OUT of this line, because the tax is not part of what the asset or cost is
   * worth — when it can be claimed back.
   */
  value?: boolean;
  /**
   * The line that settles it — the money paid, or the payable created. TDS is
   * split out of this one: you owe the full amount, you hand over less, and the
   * difference is owed to the government instead.
   */
  settlement?: boolean;
  note?: string;
};

export type Recipe = {
  id: string;
  /** When set, the tile opens this screen instead of the simple form. */
  redirectTo?: string;
  /** what the user sees on the button */
  title: string;
  /** one line of plain English under the title */
  blurb: string;
  icon: string;
  /** Other words a person might actually type looking for this. Searching for
      "loan", "lend", "borrow" must find the same tile — the title alone is a
      guess about which word came to mind first. */
  keywords?: string[];
  /** shown only in these lifecycle phases; undefined = always */
  phases?: ("capex" | "transition" | "operations")[];
  /** hidden unless the company has this feature switched on */
  feature?: string;
  /**
   * Which tax boxes this transaction can carry. They appear only if the company
   * is set up for that tax as well — a business that is not registered never
   * sees the letters GST.
   */
  tax?: { gst?: boolean; tds?: boolean };
  voucherType: string;
  fields: RecipeField[];
  /** human sentence describing the effect, shown before posting */
  explain: (ctx: ExplainCtx) => string;
  /** the plain lines, before tax is split out of them */
  build: (ctx: BuildCtx) => BuiltLine[];
  /** default narration if the user writes nothing */
  narration: (ctx: ExplainCtx) => string;
};

type ExplainCtx = {
  amountText: string;
  partyName?: string;
  targetName?: string;
  moneyName?: string;
  note?: string;
};

export type BuildCtx = {
  /** the whole transaction, in paise, exactly as it appears on the document */
  paise: number;
  moneyAccountId?: string;
  targetAccountId?: string;
  capitalAccountId: string;
  payablesAccountId: string;
};

/** One debit line. */
export const dr = (accountId: string, paise: number, rest: Partial<BuiltLine> = {}): BuiltLine => ({
  accountId,
  debitPaise: paise,
  creditPaise: 0,
  ...rest,
});

/** One credit line. */
export const cr = (accountId: string, paise: number, rest: Partial<BuiltLine> = {}): BuiltLine => ({
  accountId,
  debitPaise: 0,
  creditPaise: paise,
  ...rest,
});

/** Recipes that create or settle a supplier liability rather than moving money. */
export const CREDIT_RECIPE_IDS = ["bill_received", "bill_paid", "advance_against_bill"] as const;

export const RECIPES: Recipe[] = [
  // ---------------------------------------------------------------- money in
  {
    id: "investor_in",
    title: "An investor put money in",
    blurb: "Capital from a partner or shareholder arriving in your bank or cash",
    icon: "↓",
    keywords: [
      "capital", "share capital", "investment", "partner money", "shareholder",
      "money in", "contribution", "funding", "invested", "deposit from investor",
    ],
    voucherType: "receipt",
    fields: [
      { key: "party", label: "Which investor?", kind: "party", partyType: "investor",
        hint: "Type a new name to add them" },
      { key: "amount", label: "How much?", kind: "amount" },
      { key: "moneyAccount", label: "Where did it arrive?", kind: "moneyAccount" },
      { key: "date", label: "When?", kind: "date" },
      { key: "note", label: "Note (optional)", kind: "text" },
    ],
    explain: (c) =>
      `${c.moneyName} goes up by ${c.amountText}, and ${c.partyName ?? "the investor"}'s capital in the business goes up by the same amount.`,
    build: (c) => [
      dr(c.moneyAccountId!, c.paise),
      cr(c.capitalAccountId, c.paise, { party: true }),
    ],
    narration: (c) => c.note || `Capital contribution received from ${c.partyName ?? "investor"}`,
  },
  {
    id: "money_back",
    title: "Someone paid us back",
    blurb: "Recovering an advance or a loan you gave out earlier",
    icon: "↩",
    // "refund" is here because money coming BACK to you is what this tile does.
    // A refund you give a customer is money out and is not this tile — see
    // `AMBIGUOUS_WORDS`, which makes the search screen ask which way round it is
    // rather than quietly picking one.
    keywords: [
      "repaid", "repayment", "returned", "recovered", "refund", "refund received",
      "got money back", "loan repaid", "advance returned", "settled", "came back",
    ],
    voucherType: "receipt",
    fields: [
      { key: "party", label: "Who paid you back?", kind: "party" },
      { key: "amount", label: "How much?", kind: "amount" },
      { key: "targetAccount", label: "What is being repaid?", kind: "account",
        hint: "The advance or receivable this settles",
        filter: { subGroup: ["Loans & Advances (Current)", "Trade Receivables"], excludeBankCash: true } },
      { key: "moneyAccount", label: "Where did it arrive?", kind: "moneyAccount" },
      { key: "date", label: "When?", kind: "date" },
      { key: "note", label: "Note (optional)", kind: "text" },
    ],
    explain: (c) =>
      `${c.moneyName} goes up by ${c.amountText}, and what ${c.partyName ?? "they"} owe you drops by the same amount.`,
    build: (c) => [
      dr(c.moneyAccountId!, c.paise),
      cr(c.targetAccountId!, c.paise, { party: true }),
    ],
    narration: (c) => c.note || `Repayment received from ${c.partyName ?? "party"}`,
  },

  // --------------------------------------------------------------- money out
  {
    // The gap the owner hit: money going to a sister business, a friend, or a
    // staff member that is expected BACK. It is not a cost and not an advance
    // against goods — it is a receivable, and putting it anywhere else quietly
    // understates both the profit and what the company is owed.
    id: "lend_out",
    title: "I lent money out, to be returned",
    blurb: "To another business you run, a partner, or staff — money you expect back",
    icon: "⇢",
    // NOTE the words that are deliberately absent: a bare "loan" or "borrow".
    // Someone typing "loan" is at least as likely to mean money the business
    // RECEIVED, and this tile posts the exact inverse — money out, recorded as
    // an asset. A confident wrong answer is worse than no answer, so the
    // direction has to be in the words: "loan given", "lent", "money lent".
    keywords: [
      "lend", "lent", "loan given", "loan to", "money lent", "gave money",
      "sister concern", "related party", "other business", "my other business",
      "cafe", "temporary", "temporarily", "returnable", "recoverable",
      "transfer to another company", "inter company", "friend",
      "staff loan", "salary advance", "hand loan",
    ],
    voucherType: "payment",
    fields: [
      { key: "party", label: "Who received the money?", kind: "party",
        hint: "The business or person who has to return it — type a new name to add them" },
      { key: "amount", label: "How much?", kind: "amount" },
      { key: "targetAccount", label: "What kind of lending is this?", kind: "account",
        hint: "Another business you are involved in = related party. Staff = staff advance.",
        filter: { subGroup: ["Loans & Advances (Current)"], excludeBankCash: true } },
      { key: "moneyAccount", label: "Paid from where?", kind: "moneyAccount" },
      { key: "date", label: "When?", kind: "date" },
      { key: "note", label: "Note (optional)", kind: "text",
        hint: "Worth writing when it is due back" },
    ],
    explain: (c) =>
      `${c.moneyName} drops by ${c.amountText}, and ${c.partyName ?? "they"} now owe the company that amount. This is NOT a cost — your profit does not change, the money has simply moved from cash into "owed to us". When it comes back, use "Someone paid us back".`,
    build: (c) => [
      dr(c.targetAccountId!, c.paise, { party: true }),
      cr(c.moneyAccountId!, c.paise),
    ],
    narration: (c) => c.note || `Returnable amount lent to ${c.partyName ?? "related party"}`,
  },
  {
    id: "advance_supplier",
    title: "I paid an advance to a supplier",
    blurb: "Money paid up front, before the goods or work arrive",
    icon: "→",
    keywords: [
      "advance", "token", "booking amount", "paid up front", "deposit to vendor",
      "supplier advance", "part payment before",
    ],
    phases: ["capex", "transition", "operations"],
    voucherType: "payment",
    fields: [
      { key: "party", label: "Paid to whom?", kind: "party", partyType: "vendor",
        hint: "Type a new name to add them" },
      { key: "amount", label: "How much?", kind: "amount" },
      { key: "targetAccount", label: "Advance for what?", kind: "account",
        hint: "Pick the closest match — you can change it later",
        // Either a capital advance / deposit, or one of the current-asset
        // advance accounts. Written as anyOf because "either" is what is meant
        // here — the two groups have nothing in common.
        filter: { anyOf: [
          { capexRole: ["capital_advance", "deposit"] },
          { subGroup: ["Loans & Advances (Current)"] },
        ] } },
      { key: "moneyAccount", label: "Paid from where?", kind: "moneyAccount" },
      { key: "date", label: "When?", kind: "date" },
      { key: "note", label: "Note (optional)", kind: "text" },
    ],
    explain: (c) =>
      `${c.moneyName} drops by ${c.amountText}. This is NOT a cost yet — it is money ${c.partyName ?? "the supplier"} owes you in goods or work, so it stays on your balance sheet until they deliver.`,
    build: (c) => [
      dr(c.targetAccountId!, c.paise, { party: true }),
      cr(c.moneyAccountId!, c.paise),
    ],
    narration: (c) => c.note || `Advance paid to ${c.partyName ?? "supplier"}`,
  },
  {
    id: "construction_spend",
    title: "I paid for building or fit-out work",
    blurb: "Construction, interiors, wiring, plumbing — work on the premises",
    icon: "⌂",
    keywords: [
      "building", "construction", "civil", "interior", "fit out",
      "fitout", "renovation", "wiring", "plumbing", "carpenter",
      "painting", "tiles", "mason", "site work", "cwip",
    ],
    phases: ["capex", "transition"],
    feature: "capex",
    tax: { gst: true, tds: true },
    voucherType: "payment",
    fields: [
      { key: "party", label: "Paid to whom?", kind: "party", partyType: "vendor" },
      { key: "amount", label: "How much?", kind: "amount" },
      { key: "targetAccount", label: "Which work?", kind: "account",
        filter: { capexRole: ["cwip"] } },
      { key: "moneyAccount", label: "Paid from where?", kind: "moneyAccount" },
      { key: "date", label: "When?", kind: "date" },
      { key: "note", label: "Note (optional)", kind: "text" },
    ],
    explain: (c) =>
      `${c.moneyName} drops by ${c.amountText}, and the value of the work you are building up goes up by the same amount. This is an asset, not a cost — it will NOT show as a loss on your profit and loss.`,
    build: (c) => [
      dr(c.targetAccountId!, c.paise, { party: true, value: true }),
      cr(c.moneyAccountId!, c.paise, { settlement: true }),
    ],
    narration: (c) => c.note || `Building / fit-out work paid to ${c.partyName ?? "contractor"}`,
  },
  {
    id: "buy_asset",
    title: "I bought equipment or furniture",
    blurb: "Something you will use for years — a fridge, chairs, a computer",
    icon: "▣",
    keywords: [
      "equipment", "furniture", "machine", "asset", "purchase machine",
      "fridge", "oven", "ac", "chairs", "tables",
      "kitchen equipment", "fixed asset",
    ],
    tax: { gst: true },
    voucherType: "payment",
    fields: [
      { key: "party", label: "Bought from whom?", kind: "party", partyType: "vendor" },
      { key: "amount", label: "How much?", kind: "amount" },
      { key: "targetAccount", label: "What kind of thing?", kind: "account",
        filter: { capexRole: ["ppe"] } },
      { key: "moneyAccount", label: "Paid from where?", kind: "moneyAccount" },
      { key: "date", label: "When?", kind: "date" },
      { key: "note", label: "Note (optional)", kind: "text" },
    ],
    explain: (c) =>
      `${c.moneyName} drops by ${c.amountText}, and you now own an asset worth that much. It is not a cost today; it wears out gradually as depreciation.`,
    build: (c) => [
      dr(c.targetAccountId!, c.paise, { party: true, value: true }),
      cr(c.moneyAccountId!, c.paise, { settlement: true }),
    ],
    narration: (c) => c.note || `Purchased from ${c.partyName ?? "supplier"}`,
  },
  {
    id: "pay_expense",
    title: "I paid a running cost",
    blurb: "Rent, salary, electricity, fees — money spent and gone",
    icon: "−",
    keywords: [
      "expense", "rent", "salary", "wages", "electricity",
      "phone", "internet", "fees", "running cost", "cost",
      "paid for", "professional fee", "auditor fee", "petrol", "travel",
      "tea",
    ],
    tax: { gst: true, tds: true },
    voucherType: "payment",
    fields: [
      { key: "amount", label: "How much?", kind: "amount" },
      { key: "targetAccount", label: "What was it for?", kind: "account",
        // Depreciation is an expense that never touches cash — it is written
        // off against the asset, not paid to anyone. Offering it here invites
        // `Dr Depreciation / Cr Bank`, which is wrong twice over.
        filter: { type: ["expense"], not: { subGroup: ["Depreciation & Amortisation"] } } },
      { key: "party", label: "Paid to whom? (optional)", kind: "party" },
      { key: "moneyAccount", label: "Paid from where?", kind: "moneyAccount" },
      { key: "date", label: "When?", kind: "date" },
      { key: "note", label: "Note (optional)", kind: "text" },
    ],
    explain: (c) =>
      `${c.moneyName} drops by ${c.amountText} and this shows as a cost on your profit and loss. Money spent and gone.`,
    build: (c) => [
      dr(c.targetAccountId!, c.paise, { party: true, value: true }),
      cr(c.moneyAccountId!, c.paise, { settlement: true }),
    ],
    narration: (c) => c.note || `${c.targetName ?? "Expense"}${c.partyName ? ` — ${c.partyName}` : ""}`,
  },

  // ------------------------------------------------------- buy now, pay later
  {
    id: "bill_received",
    // handled by the full bill screen at /bills/new — see GuidedEntry
    redirectTo: "/bills/new",
    title: "I got a bill",
    blurb: "Paid now or later. Any advance with them is set against it automatically.",
    icon: "🧾",
    keywords: [
      "bill", "invoice", "credit purchase", "payable", "due",
      "30 days", "received a bill", "unpaid bill", "tax invoice", "supplier bill",
    ],
    feature: "purchases_credit",
    tax: { gst: true, tds: true },
    voucherType: "purchase",
    fields: [
      { key: "party", label: "Bill from whom?", kind: "party", partyType: "vendor",
        hint: "Type a new name to add them" },
      { key: "amount", label: "Bill amount", kind: "amount" },
      { key: "targetAccount", label: "What is the bill for?", kind: "account",
        hint: "Something you will keep is an asset; something used up is a cost",
        // Genuinely "either": a bill can be for a fixed asset, for work in
        // progress, or for a running cost. Nothing is all three.
        filter: {
          anyOf: [{ capexRole: ["ppe", "cwip"] }, { type: ["expense"] }],
          not: { subGroup: ["Depreciation & Amortisation"] },
        } },
      { key: "date", label: "Bill date", kind: "date" },
      { key: "dueDate", label: "Payment due by", kind: "date",
        hint: "Leave blank if there is no agreed date" },
      { key: "note", label: "Bill number / note", kind: "text" },
    ],
    explain: (c) =>
      `No money moves yet. You now owe ${c.partyName ?? "the supplier"} ${c.amountText}, and it will show under what you owe until you pay it.`,
    build: (c) => [
      dr(c.targetAccountId!, c.paise, { value: true }),
      cr(c.payablesAccountId, c.paise, { party: true, settlement: true }),
    ],
    narration: (c) => c.note || `Bill from ${c.partyName ?? "supplier"}`,
  },
  {
    id: "bill_paid",
    redirectTo: "/bills",
    title: "I paid a bill I owed",
    blurb: "Settling a bill you had already received",
    icon: "✔",
    keywords: [
      "pay bill", "settle bill", "clear dues", "pay supplier", "paid the invoice",
      "payment against bill", "outstanding paid",
    ],
    feature: "purchases_credit",
    voucherType: "payment",
    fields: [
      { key: "party", label: "Paid whom?", kind: "party", partyType: "vendor" },
      { key: "amount", label: "How much did you pay?", kind: "amount",
        hint: "Part payments are fine — the rest stays outstanding" },
      { key: "moneyAccount", label: "Paid from where?", kind: "moneyAccount" },
      { key: "date", label: "When?", kind: "date" },
      { key: "note", label: "Note (optional)", kind: "text" },
    ],
    explain: (c) =>
      `${c.moneyName} drops by ${c.amountText} and what you owe ${c.partyName ?? "them"} drops by the same amount. This is not a new cost — the cost was recorded when the bill arrived.`,
    build: (c) => [
      dr(c.payablesAccountId, c.paise, { party: true }),
      cr(c.moneyAccountId!, c.paise),
    ],
    narration: (c) => c.note || `Paid ${c.partyName ?? "supplier"}`,
  },
  {
    id: "advance_against_bill",
    redirectTo: "/bills/new",
    title: "Set my advance against their bill",
    blurb: "You paid up front, the bill has arrived — use the advance to reduce it",
    icon: "⊖",
    keywords: [
      "adjust advance", "set off", "against bill", "knock off", "apply advance",
      "agst ref", "adjust against",
    ],
    feature: "purchases_credit",
    voucherType: "journal",
    fields: [
      { key: "party", label: "Which supplier?", kind: "party", partyType: "vendor" },
      { key: "amount", label: "How much of the advance to use?", kind: "amount" },
      { key: "moneyAccount", label: "Which advance is being used up?", kind: "moneyAccount",
        hint: "The advance you paid earlier",
        filter: {
          anyOf: [
            { capexRole: ["capital_advance", "deposit"] },
            { subGroup: ["Loans & Advances (Current)"] },
          ],
          excludeBankCash: true,
        } },
      { key: "date", label: "When?", kind: "date" },
      { key: "note", label: "Note (optional)", kind: "text" },
    ],
    explain: (c) =>
      `No money moves. ${c.amountText} of the advance sitting with ${c.partyName ?? "the supplier"} is used to reduce their bill. Only the remaining balance is left to pay.`,
    build: (c) => [
      dr(c.payablesAccountId, c.paise, { party: true }),
      cr(c.moneyAccountId!, c.paise, { party: true }),
    ],
    narration: (c) => c.note || `Advance set against bill from ${c.partyName ?? "supplier"}`,
  },

  // ------------------------------------------------------------ no money moves
  {
    id: "advance_becomes_asset",
    title: "Goods arrived — turn my advance into the asset",
    blurb: "The supplier delivered what you already paid for. No money moves.",
    icon: "⇄",
    keywords: [
      "goods arrived", "delivered", "received goods", "convert advance", "capitalise",
      "capitalize", "material received",
    ],
    voucherType: "journal",
    fields: [
      { key: "party", label: "Which supplier?", kind: "party", partyType: "vendor" },
      { key: "amount", label: "Value delivered", kind: "amount" },
      { key: "targetAccount", label: "What did you receive?", kind: "account",
        filter: { capexRole: ["ppe"] } },
      { key: "moneyAccount", label: "Which advance is being used up?", kind: "moneyAccount",
        hint: "The advance account you paid into earlier",
        filter: { capexRole: ["capital_advance", "deposit"], excludeBankCash: true } },
      { key: "date", label: "When?", kind: "date" },
      { key: "note", label: "Note (optional)", kind: "text" },
    ],
    explain: (c) =>
      `No money moves. The ${c.amountText} you had sitting as an advance becomes a real asset you own.`,
    build: (c) => [
      dr(c.targetAccountId!, c.paise),
      cr(c.moneyAccountId!, c.paise, { party: true }),
    ],
    narration: (c) => c.note || `Advance to ${c.partyName ?? "supplier"} converted on delivery`,
  },
  {
    id: "bank_to_cash",
    title: "I moved money between bank and cash",
    blurb: "Cash withdrawal or deposit — your total money does not change",
    icon: "⇋",
    keywords: [
      "withdraw", "withdrawal", "deposit", "atm", "cash withdrawal",
      "transfer", "bank to cash", "cash to bank", "contra",
    ],
    voucherType: "contra",
    fields: [
      { key: "amount", label: "How much?", kind: "amount" },
      { key: "moneyAccount", label: "From where?", kind: "moneyAccount" },
      // BOTH sides of a transfer are money accounts, so the destination has to
      // obey the same book rule as the source. Filtering on `sub_group` alone
      // offered the official bank accounts for an internal-book entry (rejected
      // at submit) and hid the internal cash account (a system account).
      { key: "targetAccount", label: "To where?", kind: "account",
        filter: { bookScopedMoney: true } },
      { key: "date", label: "When?", kind: "date" },
      { key: "note", label: "Note (optional)", kind: "text" },
    ],
    explain: (c) =>
      `${c.amountText} moves from ${c.moneyName} to ${c.targetName}. Your total money is unchanged.`,
    build: (c) => [
      dr(c.targetAccountId!, c.paise),
      cr(c.moneyAccountId!, c.paise),
    ],
    narration: (c) => c.note || `Transfer between ${c.moneyName} and ${c.targetName}`,
  },
];

export function recipesForPhase(phase: "capex" | "transition" | "operations"): Recipe[] {
  return RECIPES.filter((r) => !r.phases || r.phases.includes(phase));
}

export function getRecipe(id: string): Recipe | undefined {
  return RECIPES.find((r) => r.id === id);
}

/**
 * Find the right tile from whatever words came to mind.
 *
 * Scored rather than filtered, so "loan" puts lending at the top instead of
 * returning four tiles in list order and making the user read all of them.
 * Every word typed must match something — otherwise "loan to cafe" would match
 * every tile that merely contains "to".
 */
export function searchRecipes(recipes: Recipe[], query: string): Recipe[] {
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (words.length === 0) return recipes;

  const scored = recipes.map((r) => {
    const title = r.title.toLowerCase();
    const blurb = r.blurb.toLowerCase();
    const keys = (r.keywords ?? []).map((k) => k.toLowerCase());
    const keyText = keys.join(" ");
    let score = 0;
    for (const w of words) {
      if (title.includes(w)) score += 5;
      // An exact keyword beats appearing inside a longer one, so typing "loan"
      // lands on lending rather than on "loan repaid" further down the list.
      else if (keys.includes(w)) score += 4;
      else if (keyText.includes(w)) score += 3;
      else if (blurb.includes(w)) score += 1;
      else return { r, score: -1 }; // this word matched nothing at all
    }
    return { r, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.r);
}

/* ----------------------------------------------------------------------------
   Words that do not say which way the money went.

   "loan" is the dangerous one: lending ₹75,000 out and receiving a ₹75,000 loan
   are opposite entries, and a search that silently picks one of them will be
   wrong half the time — with a balanced, hash-chained, perfectly plausible
   entry to show for it. So the search screen asks instead of guessing.
---------------------------------------------------------------------------- */
const LEND_OR_BORROW =
  "Do you mean money you LENT OUT, or money the business BORROWED? Only lending out has a tile so far — a loan the business received goes through the accountant's screen.";

const AMBIGUOUS_WORDS: Record<string, string> = {
  loan: LEND_OR_BORROW,
  loans: LEND_OR_BORROW,
  borrow: LEND_OR_BORROW,
  borrowed: LEND_OR_BORROW,
  borrowing: LEND_OR_BORROW,
  refund:
    "A refund coming BACK to you is “Someone paid us back”. A refund you GIVE someone is money out — record it as the reverse of whatever it refunds.",
  transfer:
    "Between your own bank and cash is “I moved money between bank and cash”. Money going to someone else is a payment, a lending, or a bill.",
  advance:
    "An advance you PAID is “I paid an advance to a supplier”. An advance you RECEIVED is money you owe, not money owed to you.",
  deposit:
    "Cash going into your own bank is “I moved money between bank and cash”. A deposit lodged with a landlord or the electricity board is “I paid an advance to a supplier”.",
};

/**
 * A one-line "which direction did you mean?" note for a search query, or null.
 * The results are still shown underneath it — refusing to answer is its own
 * kind of unhelpful.
 */
export function directionNote(query: string): string | null {
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  // Only when the query is JUST the ambiguous word. "loan given to cafe" has
  // already said which way round it is and does not need second-guessing.
  if (words.length !== 1) return null;
  return AMBIGUOUS_WORDS[words[0]] ?? null;
}

/** Does one account satisfy one filter? AND across predicates, OR within one. */
function matchesFilter(a: Account, f: AccountFilter): boolean {
  if (f.capexRole?.length && !(a.capex_role && f.capexRole.includes(a.capex_role))) return false;
  if (f.type?.length && !f.type.includes(a.account_type)) return false;
  if (f.subGroup?.length && !(a.sub_group && f.subGroup.includes(a.sub_group))) return false;
  if (f.anyOf?.length && !f.anyOf.some((sub) => matchesFilter(a, sub))) return false;
  if (f.not && matchesFilter(a, f.not)) return false;
  return true;
}

/**
 * Which accounts a given field will offer. Keeps the 90-account chart out of
 * the way.
 *
 * Returns an EMPTY array when the chart genuinely has no matching account. It
 * used to fall back to the entire chart in that case, on the reasoning that
 * offering everything beats a dead end. It does not: combined with the form
 * auto-selecting the first option, "I paid for building work" on a chart with
 * no work-in-progress account pre-filled a bank account on both sides and let
 * the user post `Dr Bank / Cr Bank`. An empty list the caller must handle is
 * the safe answer; the caller says what is missing and how to add it.
 */
export function accountsFor(accounts: Account[], filter?: AccountFilter): Account[] {
  let out = accounts.filter((a) => !a.is_group && a.is_active);
  if (!filter?.allowSystem) out = out.filter((a) => !a.is_system);
  if (!filter) return out;
  out = out.filter((a) => matchesFilter(a, filter));
  if (filter.excludeBankCash) out = out.filter((a) => !a.is_bank_or_cash);
  return out;
}

export function moneyAccounts(accounts: Account[]): Account[] {
  return accounts.filter((a) => a.is_bank_or_cash && !a.is_group && a.is_active);
}

/**
 * Which money accounts are usable in the book being written to.
 *
 * Statutory cash and bank must reconcile to a real bank statement, so an
 * internal-only entry cannot touch them. The database enforces this; offering
 * them here and failing at submit is the wrong place to find out.
 */
export function moneyAccountsForBook(
  accounts: Account[],
  bookId: string | null,
  internal: boolean,
): Account[] {
  return moneyAccounts(accounts).filter((a) =>
    internal ? a.restricted_to_book_id === bookId : !a.restricted_to_book_id,
  );
}

/* ============================================================================
   Tax, split out of the lines the recipe already built.

   Doing this in one place rather than inside each recipe is the point: the
   arithmetic that decides how much of a payment is cost, how much is
   reclaimable tax, and how much never leaves the building is written once and
   tested once.

   TWO RULES, AND THEY ARE NOT SYMMETRICAL.

   GST reduces the VALUE line. You paid Rs 11,800 for something worth Rs 10,000
   plus Rs 1,800 of tax you will get back — so the asset or the cost is
   Rs 10,000, and Rs 1,800 is money the government owes you.

   TDS reduces the SETTLEMENT line. The cost is the whole Rs 50,000 and the
   supplier has earned all of it; you simply hand Rs 45,000 to them and Rs 5,000
   to the government on their behalf. Netting it off the cost instead would
   understate the expense and overstate the profit.

   WHEN GST IS **NOT** RECLAIMABLE IT IS NOT SPLIT AT ALL. A composition dealer
   and a restaurant on the 5% scheme both charge GST and neither may claim it
   back on what they buy, so for them the tax IS part of the cost. This had to
   be a rule read from the company's own registration rather than an assumption
   about what most businesses do — it comes from `tax_posting_setup(company)`.
   ========================================================================= */

export type TaxSetup = {
  /** null when the chart has no account carrying that role */
  gstInputAccountId: string | null;
  gstOutputAccountId: string | null;
  tdsPayableAccountId: string | null;
  /** false for unregistered, for composition, and for blocked schemes */
  itcClaimable: boolean;
};

export type TaxInput = {
  /** GST contained in the amount the user typed, in paise */
  gstPaise?: number;
  /** withheld from the supplier and owed to the government, in paise */
  tdsPaise?: number;
};

export function applyTaxes(lines: BuiltLine[], tax: TaxInput, setup: TaxSetup): BuiltLine[] {
  const out = lines.map((l) => ({ ...l }));

  const gst = tax.gstPaise ?? 0;
  if (gst > 0 && setup.itcClaimable && setup.gstInputAccountId) {
    const value = out.find((l) => l.value);
    if (!value) throw new Error("This transaction has no line for the GST to come out of.");
    const side = value.debitPaise > 0 ? "debitPaise" : "creditPaise";
    if (value[side] <= gst) {
      throw new Error("The GST cannot be the whole amount — there would be nothing left to record.");
    }
    value[side] -= gst;
    out.push(
      side === "debitPaise"
        ? dr(setup.gstInputAccountId, gst, { note: "Input credit" })
        : cr(setup.gstInputAccountId, gst, { note: "Input credit" }),
    );
  }

  const tds = tax.tdsPaise ?? 0;
  if (tds > 0) {
    if (!setup.tdsPayableAccountId) {
      throw new Error("Your chart has no TDS Payable account, so the deduction has nowhere to go.");
    }
    const settle = out.find((l) => l.settlement);
    if (!settle) throw new Error("This transaction has no line for the TDS to come out of.");
    const side = settle.creditPaise > 0 ? "creditPaise" : "debitPaise";
    if (settle[side] <= tds) {
      throw new Error("The TDS cannot be the whole amount — nothing would be left to pay them.");
    }
    settle[side] -= tds;
    out.push(
      side === "creditPaise"
        ? cr(setup.tdsPayableAccountId, tds, { note: "TDS withheld" })
        : dr(setup.tdsPayableAccountId, tds, { note: "TDS withheld" }),
    );
  }

  return out;
}

/* ----------------------------------------------------------------------------
   The last gate before anything is sent.

   `save_journal_entry` enforces all of this as well, and that is the
   enforcement that counts. This exists so the user is told in their own words
   BEFORE they press the button, instead of being handed a Postgres error after.

   The net-per-account rule generalises the old two-line "same account on both
   sides" guard. It is deliberately STRICTER than the database, which only
   insists that *some* account moves: in an entry the app itself generated, an
   account that nets to zero is always a mistake.
---------------------------------------------------------------------------- */
export function validateLines(
  lines: BuiltLine[],
  accounts: Pick<Account, "id" | "name" | "is_bank_or_cash">[],
): string | null {
  if (lines.length < 2) return "An entry needs at least two sides.";

  for (const l of lines) {
    if (!l.accountId) return "One of the lines has no account chosen.";
    if (l.debitPaise < 0 || l.creditPaise < 0) return "An amount cannot be negative.";
    if (l.debitPaise > 0 && l.creditPaise > 0) {
      return "A line cannot be a debit and a credit at the same time.";
    }
    if (l.debitPaise === 0 && l.creditPaise === 0) return "One of the lines is for nothing.";
  }

  const debits = lines.reduce((n, l) => n + l.debitPaise, 0);
  const credits = lines.reduce((n, l) => n + l.creditPaise, 0);
  if (debits !== credits) return "The two sides do not match.";

  const net = new Map<string, number>();
  for (const l of lines) {
    net.set(l.accountId, (net.get(l.accountId) ?? 0) + l.debitPaise - l.creditPaise);
  }
  for (const [id, n] of net) {
    if (n === 0) {
      const name = accounts.find((a) => a.id === id)?.name ?? "That account";
      return `${name} is on both sides for the same amount, so its balance would not change. Pick two different accounts.`;
    }
  }

  // The party belongs to your relationship with them, never to the bank line —
  // whose counterparty is the bank, not the supplier.
  for (const l of lines) {
    if (l.party && accounts.find((a) => a.id === l.accountId)?.is_bank_or_cash) {
      return "A bank or cash line cannot be tagged to a party.";
    }
  }

  return null;
}

/** Recipes this company can see: right lifecycle phase, and the feature is on. */
export function recipesFor(
  phase: "capex" | "transition" | "operations",
  features: Record<string, boolean> | undefined,
): Recipe[] {
  return recipesForPhase(phase).filter((r) => !r.feature || features?.[r.feature] !== false);
}

/** Which tax boxes to actually show for a recipe, given how the company is set up. */
export function taxFieldsFor(
  recipe: Recipe,
  features: Record<string, boolean> | undefined,
  setup: TaxSetup | null,
): { gst: boolean; tds: boolean } {
  return {
    gst: !!recipe.tax?.gst && features?.gst === true && !!setup?.itcClaimable && !!setup.gstInputAccountId,
    tds: !!recipe.tax?.tds && features?.tds === true && !!setup?.tdsPayableAccountId,
  };
}
