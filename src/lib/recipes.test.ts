import { describe, expect, it } from "vitest";
import {
  RECIPES,
  accountsFor,
  directionNote,
  getRecipe,
  applyTaxes,
  moneyAccounts,
  recipesFor,
  recipesForPhase,
  searchRecipes,
  taxFieldsFor,
  validateLines,
  type BuiltLine,
  type TaxSetup,
} from "./recipes";
import type { Account } from "./queries";

const acct = (
  code: string,
  name: string,
  account_type: Account["account_type"],
  extra: Partial<Account> = {},
): Account => ({
  id: `id-${code}`,
  code,
  name,
  account_type,
  account_group: null,
  sub_group: null,
  normal_balance: account_type === "asset" || account_type === "expense" ? "D" : "C",
  is_group: false,
  is_bank_or_cash: false,
  is_active: true,
  is_system: false,
  capex_role: null,
  restricted_to_book_id: null,
  ...extra,
});

const CHART: Account[] = [
  acct("1010", "Bank - Current A/c", "asset", { is_bank_or_cash: true, sub_group: "Cash & Bank" }),
  acct("1020", "Cash in Hand", "asset", { is_bank_or_cash: true, sub_group: "Cash & Bank" }),
  acct("1220", "Advance to Related Party (Returnable)", "asset", {
    sub_group: "Loans & Advances (Current)",
  }),
  acct("1440", "Furniture & Fixtures", "asset", { capex_role: "ppe" }),
  acct("1510", "Capital Work in Progress - Building", "asset", { capex_role: "cwip" }),
  acct("1610", "Capital Advance - Furniture", "asset", { capex_role: "capital_advance" }),
  acct("1710", "Advance for Premises Lease", "asset", { capex_role: "deposit" }),
  acct("3010", "Partners / Shareholders Capital", "equity"),
  acct("5110", "Salaries & Wages", "expense"),
  acct("5810", "Depreciation", "expense", { sub_group: "Depreciation & Amortisation" }),
  acct("9000", "Assets (heading)", "asset", { is_group: true }),
  acct("9001", "Retired account", "expense", { is_active: false }),
  acct("9910", "Exchange Rate Difference", "expense", { is_system: true }),
];

const byCode = (c: string) => CHART.find((a) => a.code === c)!.id;

/** ₹1,000, in paise. Every recipe now needs the amount to build its lines. */
const AMT = 100_000;

const ctx = {
  paise: AMT,
  capitalAccountId: byCode("3010"),
  payablesAccountId: "payables",
};

/* A recipe returns lines, not two named sides. For the plain two-line recipes
   these read the one debit and the one credit, so the assertions below stay
   about accounting rather than about array indices. */
const drOf = (ls: BuiltLine[]) => ls.find((l) => l.debitPaise > 0)!.accountId;
const crOf = (ls: BuiltLine[]) => ls.find((l) => l.creditPaise > 0)!.accountId;

describe("every recipe is well-formed", () => {
  it("has a unique id, an amount field and a date field", () => {
    const ids = RECIPES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of RECIPES) {
      expect(r.fields.some((f) => f.key === "amount"), `${r.id} needs an amount`).toBe(true);
      expect(r.fields.some((f) => f.key === "date"), `${r.id} needs a date`).toBe(true);
    }
  });

  it("never asks the user the words debit or credit", () => {
    for (const r of RECIPES) {
      const words = [r.title, r.blurb, ...r.fields.map((f) => f.label)].join(" ").toLowerCase();
      expect(words, `${r.id} leaks accounting jargon`).not.toMatch(/debit|credit|ledger a\/c|journal/);
    }
  });

  it("produces two different accounts, never the same one on both sides", () => {
    for (const r of RECIPES) {
      const built = r.build({
        ...ctx,
        moneyAccountId: byCode("1010"),
        targetAccountId: byCode("1440"),
      });
      expect(drOf(built), `${r.id}`).toBeTruthy();
      expect(crOf(built), `${r.id}`).toBeTruthy();
      expect(drOf(built), `${r.id} posts to the same account twice`).not.toBe(
        crOf(built),
      );
    }
  });
});

describe("the entries are accounting-correct", () => {
  it("investor money in: bank up, capital up", () => {
    const b = getRecipe("investor_in")!.build({ ...ctx, moneyAccountId: byCode("1010") });
    expect(drOf(b)).toBe(byCode("1010")); // asset increases
    expect(crOf(b)).toBe(byCode("3010")); // equity increases
  });

  it("supplier advance: the advance is an ASSET, not an expense", () => {
    const b = getRecipe("advance_supplier")!.build({
      ...ctx,
      moneyAccountId: byCode("1010"),
      targetAccountId: byCode("1610"),
    });
    expect(drOf(b)).toBe(byCode("1610"));
    expect(crOf(b)).toBe(byCode("1010"));
    // the debited account must not be an expense — this is the mistake that
    // makes a pre-revenue business look like it is losing money
    const debited = CHART.find((a) => a.id === drOf(b))!;
    expect(debited.account_type).toBe("asset");
  });

  it("construction spend goes to CWIP, never to profit and loss", () => {
    const b = getRecipe("construction_spend")!.build({
      ...ctx,
      moneyAccountId: byCode("1010"),
      targetAccountId: byCode("1510"),
    });
    const debited = CHART.find((a) => a.id === drOf(b))!;
    expect(debited.capex_role).toBe("cwip");
    expect(debited.account_type).not.toBe("expense");
  });

  it("a running cost DOES hit profit and loss", () => {
    const b = getRecipe("pay_expense")!.build({
      ...ctx,
      moneyAccountId: byCode("1010"),
      targetAccountId: byCode("5110"),
    });
    expect(CHART.find((a) => a.id === drOf(b))!.account_type).toBe("expense");
  });

  it("goods arriving moves an advance into an asset, with no bank involved", () => {
    const b = getRecipe("advance_becomes_asset")!.build({
      ...ctx,
      moneyAccountId: byCode("1610"), // the advance being used up
      targetAccountId: byCode("1440"), // the asset received
    });
    expect(drOf(b)).toBe(byCode("1440"));
    expect(crOf(b)).toBe(byCode("1610"));
    const bothSides = [drOf(b), crOf(b)].map(
      (id) => CHART.find((a) => a.id === id)!.is_bank_or_cash,
    );
    expect(bothSides).toEqual([false, false]); // no money actually moved
  });

  it("bank to cash keeps total money unchanged (both sides are money accounts)", () => {
    const b = getRecipe("bank_to_cash")!.build({
      ...ctx,
      moneyAccountId: byCode("1010"),
      targetAccountId: byCode("1020"),
    });
    const sides = [drOf(b), crOf(b)].map(
      (id) => CHART.find((a) => a.id === id)!.is_bank_or_cash,
    );
    expect(sides).toEqual([true, true]);
  });
});

describe("account pickers hide the 90-account chart", () => {
  it("never offers group headings or retired accounts", () => {
    const offered = accountsFor(CHART);
    expect(offered.some((a) => a.is_group)).toBe(false);
    expect(offered.some((a) => !a.is_active)).toBe(false);
  });

  it("a supplier advance offers only advance and deposit accounts", () => {
    const f = getRecipe("advance_supplier")!.fields.find((x) => x.key === "targetAccount")!;
    const offered = accountsFor(CHART, "filter" in f ? f.filter : undefined);
    expect(offered.map((a) => a.code).sort()).toEqual(["1220", "1610", "1710"]);
  });

  it("construction offers only work-in-progress accounts", () => {
    const f = getRecipe("construction_spend")!.fields.find((x) => x.key === "targetAccount")!;
    const offered = accountsFor(CHART, "filter" in f ? f.filter : undefined);
    expect(offered.map((a) => a.code)).toEqual(["1510"]);
  });

  /* --------------------------------------------------------------------------
     This test used to assert the OPPOSITE — that a filter matching nothing
     falls back to the entire chart, "rather than showing an empty picker".
     That fallback is what let "I paid for building work", on a chart with no
     work-in-progress account, pre-fill a bank account on both sides. An empty
     list is the correct answer; the form says what is missing and refuses.
  -------------------------------------------------------------------------- */
  it("returns nothing when the chart has no matching account, and does NOT fall back", () => {
    const offered = accountsFor(CHART, { capexRole: ["nonexistent_role"] });
    expect(offered).toEqual([]);
  });

  it("ANDs its predicates — an account must satisfy all of them", () => {
    // 1440 is capex ppe; 5110 is an expense. Nothing is both.
    expect(accountsFor(CHART, { capexRole: ["ppe"], type: ["expense"] })).toEqual([]);
    // and the OR that some recipes genuinely want has to be asked for
    expect(
      accountsFor(CHART, { anyOf: [{ capexRole: ["ppe"] }, { type: ["expense"] }] })
        .map((a) => a.code)
        .sort(),
    ).toEqual(["1440", "5110", "5810"]);
  });

  it("hides system accounts unless the recipe asks for them", () => {
    expect(accountsFor(CHART).some((a) => a.code === "9910")).toBe(false);
    expect(accountsFor(CHART, { allowSystem: true }).some((a) => a.code === "9910")).toBe(true);
  });

  it("a running cost offers neither the system account nor depreciation", () => {
    const f = getRecipe("pay_expense")!.fields.find((x) => x.key === "targetAccount")!;
    const codes = accountsFor(CHART, "filter" in f ? f.filter : undefined).map((a) => a.code);
    expect(codes).toContain("5110");
    // depreciation is an expense that never touches cash
    expect(codes).not.toContain("5810");
    expect(codes).not.toContain("9910");
  });

  it("money accounts are only bank and cash", () => {
    expect(moneyAccounts(CHART).map((a) => a.code)).toEqual(["1010", "1020"]);
  });
});

describe("the action list adapts to the business phase", () => {
  it("offers construction while building, and hides it once trading", () => {
    expect(recipesForPhase("capex").map((r) => r.id)).toContain("construction_spend");
    expect(recipesForPhase("operations").map((r) => r.id)).not.toContain("construction_spend");
  });

  it("always offers the basics", () => {
    for (const phase of ["capex", "transition", "operations"] as const) {
      const ids = recipesForPhase(phase).map((r) => r.id);
      expect(ids).toContain("investor_in");
      expect(ids).toContain("pay_expense");
      expect(ids).toContain("bank_to_cash");
    }
  });
});

describe("each line says for itself whether it belongs to the party", () => {
  const partyLines = (ls: BuiltLine[]) => ls.filter((l) => l.party).map((l) => l.accountId);

  it("never tags the bank line — that is what makes every party net to zero", () => {
    const bank = byCode("1010");
    for (const [id, extra] of [
      ["advance_supplier", { moneyAccountId: bank, targetAccountId: byCode("1610") }],
      ["investor_in", { moneyAccountId: bank }],
      ["money_back", { moneyAccountId: bank, targetAccountId: byCode("1220") }],
      ["pay_expense", { moneyAccountId: bank, targetAccountId: byCode("5110") }],
    ] as const) {
      const lines = getRecipe(id)!.build({ ...ctx, ...extra });
      expect(partyLines(lines), id).not.toContain(bank);
      expect(validateLines(lines, CHART), id).toBeNull();
    }
  });

  it("leaves a real party balance instead of cancelling out", () => {
    const lines = getRecipe("advance_supplier")!.build({
      ...ctx,
      paise: 4_000_000, // ₹40,000 furniture advance
      moneyAccountId: byCode("1010"),
      targetAccountId: byCode("1610"),
    });
    const balance = lines
      .filter((l) => l.party)
      .reduce((n, l) => n + l.debitPaise - l.creditPaise, 0);
    expect(balance).toBe(4_000_000); // 40,000 outstanding, NOT zero
  });

  it("tags nobody on a bank-to-cash transfer", () => {
    const lines = getRecipe("bank_to_cash")!.build({
      ...ctx,
      moneyAccountId: byCode("1010"),
      targetAccountId: byCode("1020"),
    });
    expect(partyLines(lines)).toEqual([]);
  });

  /* --------------------------------------------------------------------------
     The case the old single-side heuristic could not express. Setting an
     advance against that supplier's bill touches TWO of their balances, and
     both belong to them. The two tags cancel — correctly: the set-off shrinks
     what each of you owes the other without changing the net between you.
  -------------------------------------------------------------------------- */
  it("tags both of the supplier's lines in a set-off, and they net to zero", () => {
    const lines = getRecipe("advance_against_bill")!.build({
      ...ctx,
      moneyAccountId: byCode("1610"),
    });
    expect(partyLines(lines).length).toBe(2);
    const net = lines
      .filter((l) => l.party)
      .reduce((n, l) => n + l.debitPaise - l.creditPaise, 0);
    expect(net).toBe(0);
  });

  it("refuses a party tag on a bank line", () => {
    const bad: BuiltLine[] = [
      { accountId: byCode("1010"), debitPaise: AMT, creditPaise: 0, party: true },
      { accountId: byCode("5110"), debitPaise: 0, creditPaise: AMT },
    ];
    expect(validateLines(bad, CHART)).toMatch(/bank or cash line cannot be tagged/i);
  });
});

describe("the lines are checked before anything is sent", () => {
  it("passes a normal entry", () => {
    expect(
      validateLines(
        [
          { accountId: byCode("5110"), debitPaise: AMT, creditPaise: 0 },
          { accountId: byCode("1010"), debitPaise: 0, creditPaise: AMT },
        ],
        CHART,
      ),
    ).toBeNull();
  });

  it("catches sides that do not match", () => {
    expect(
      validateLines(
        [
          { accountId: byCode("5110"), debitPaise: AMT, creditPaise: 0 },
          { accountId: byCode("1010"), debitPaise: 0, creditPaise: AMT - 1 },
        ],
        CHART,
      ),
    ).toMatch(/do not match/i);
  });

  it("catches an entry that changes no balance at all", () => {
    // the bank↔bank entry that used to post in one click, balanced and hashed
    expect(
      validateLines(
        [
          { accountId: byCode("1010"), debitPaise: AMT, creditPaise: 0 },
          { accountId: byCode("1010"), debitPaise: 0, creditPaise: AMT },
        ],
        CHART,
      ),
    ).toMatch(/would not change/i);
  });

  it("allows the same account twice when it genuinely moves", () => {
    // ₹1,000 debited and ₹400 credited to one account nets ₹600 — a real move
    expect(
      validateLines(
        [
          { accountId: byCode("1220"), debitPaise: AMT, creditPaise: 0 },
          { accountId: byCode("1220"), debitPaise: 0, creditPaise: 40_000 },
          { accountId: byCode("1010"), debitPaise: 0, creditPaise: AMT - 40_000 },
        ],
        CHART,
      ),
    ).toBeNull();
  });

  it("catches a line that is both a debit and a credit, and one that is neither", () => {
    expect(
      validateLines(
        [
          { accountId: byCode("5110"), debitPaise: AMT, creditPaise: AMT },
          { accountId: byCode("1010"), debitPaise: 0, creditPaise: AMT },
        ],
        CHART,
      ),
    ).toMatch(/debit and a credit/i);
    expect(
      validateLines(
        [
          { accountId: byCode("5110"), debitPaise: 0, creditPaise: 0 },
          { accountId: byCode("1010"), debitPaise: 0, creditPaise: AMT },
        ],
        CHART,
      ),
    ).toMatch(/for nothing/i);
  });

  it("refuses a one-sided entry", () => {
    expect(
      validateLines([{ accountId: byCode("5110"), debitPaise: AMT, creditPaise: 0 }], CHART),
    ).toMatch(/two sides/i);
  });
});

/* ============================================================================
   GST and TDS — the two splits, and the rule that decides whether GST is one.
   ========================================================================= */
describe("GST and TDS split the right line", () => {
  const GST_IN = "id-gst-input";
  const TDS = "id-tds-payable";
  const CHART_TAX = [
    ...CHART,
    acct("1310", "GST Input Credit (ITC)", "asset", { id: GST_IN } as Partial<Account>),
    acct("2120", "TDS Payable", "liability", { id: TDS } as Partial<Account>),
  ];

  const claimable: TaxSetup = {
    gstInputAccountId: GST_IN,
    gstOutputAccountId: null,
    tdsPayableAccountId: TDS,
    itcClaimable: true,
  };
  const blocked: TaxSetup = { ...claimable, itcClaimable: false };

  // ₹11,800 paid, of which ₹1,800 is GST
  const rent = () =>
    getRecipe("pay_expense")!.build({
      ...ctx,
      paise: 1_180_000,
      moneyAccountId: byCode("1010"),
      targetAccountId: byCode("5110"),
    });

  it("takes GST out of the COST, not out of the payment", () => {
    const lines = applyTaxes(rent(), { gstPaise: 180_000 }, claimable);
    expect(validateLines(lines, CHART_TAX)).toBeNull();

    const cost = lines.find((l) => l.accountId === byCode("5110"))!;
    const bank = lines.find((l) => l.accountId === byCode("1010"))!;
    const itc = lines.find((l) => l.accountId === GST_IN)!;

    expect(cost.debitPaise).toBe(1_000_000); // the expense is ₹10,000
    expect(itc.debitPaise).toBe(180_000); // ₹1,800 is owed back to you
    expect(bank.creditPaise).toBe(1_180_000); // the whole ₹11,800 left the bank
  });

  /* --------------------------------------------------------------------------
     The rule the plan insisted must be a rule. A restaurant on the 5% scheme
     charges GST and cannot claim it back, so ₹1,800 of tax is part of what the
     rent COST — booking it as an asset would overstate both the profit and
     what the government owes them.
  -------------------------------------------------------------------------- */
  it("does NOT split GST when the scheme blocks input credit — the tax is part of the cost", () => {
    const lines = applyTaxes(rent(), { gstPaise: 180_000 }, blocked);
    expect(lines.length).toBe(2);
    expect(lines.find((l) => l.accountId === byCode("5110"))!.debitPaise).toBe(1_180_000);
    expect(lines.some((l) => l.accountId === GST_IN)).toBe(false);
  });

  it("takes TDS out of the PAYMENT, never out of the cost", () => {
    // ₹50,000 rent, ₹5,000 withheld
    const lines = applyTaxes(
      getRecipe("pay_expense")!.build({
        ...ctx,
        paise: 5_000_000,
        moneyAccountId: byCode("1010"),
        targetAccountId: byCode("5110"),
      }),
      { tdsPaise: 500_000 },
      claimable,
    );
    expect(validateLines(lines, CHART_TAX)).toBeNull();
    expect(lines.find((l) => l.accountId === byCode("5110"))!.debitPaise).toBe(5_000_000);
    expect(lines.find((l) => l.accountId === byCode("1010"))!.creditPaise).toBe(4_500_000);
    expect(lines.find((l) => l.accountId === TDS)!.creditPaise).toBe(500_000);
  });

  it("handles both at once and still balances", () => {
    const lines = applyTaxes(rent(), { gstPaise: 180_000, tdsPaise: 100_000 }, claimable);
    expect(validateLines(lines, CHART_TAX)).toBeNull();
    expect(lines.length).toBe(4);
    const debits = lines.reduce((n, l) => n + l.debitPaise, 0);
    const credits = lines.reduce((n, l) => n + l.creditPaise, 0);
    expect(debits).toBe(1_180_000);
    expect(credits).toBe(1_180_000);
  });

  it("refuses tax that swallows the whole amount", () => {
    expect(() => applyTaxes(rent(), { gstPaise: 1_180_000 }, claimable)).toThrow(/whole amount/i);
    expect(() => applyTaxes(rent(), { tdsPaise: 1_180_000 }, claimable)).toThrow(/whole amount/i);
  });

  it("refuses TDS when the chart has nowhere to put it", () => {
    expect(() =>
      applyTaxes(rent(), { tdsPaise: 100_000 }, { ...claimable, tdsPayableAccountId: null }),
    ).toThrow(/TDS Payable/i);
  });

  it("leaves an untaxed entry exactly as the recipe built it", () => {
    const plain = rent();
    expect(applyTaxes(plain, {}, claimable)).toEqual(plain);
  });
});

describe("a business never sees a tax it is not registered for", () => {
  const setup: TaxSetup = {
    gstInputAccountId: "gst",
    gstOutputAccountId: null,
    tdsPayableAccountId: "tds",
    itcClaimable: true,
  };
  const rent = getRecipe("pay_expense")!;

  it("shows nothing when the features are off", () => {
    expect(taxFieldsFor(rent, { gst: false, tds: false }, setup)).toEqual({
      gst: false,
      tds: false,
    });
    expect(taxFieldsFor(rent, undefined, setup)).toEqual({ gst: false, tds: false });
  });

  it("shows each box only when that tax is switched on", () => {
    expect(taxFieldsFor(rent, { gst: true, tds: false }, setup).gst).toBe(true);
    expect(taxFieldsFor(rent, { gst: true, tds: false }, setup).tds).toBe(false);
    expect(taxFieldsFor(rent, { gst: false, tds: true }, setup).tds).toBe(true);
  });

  it("hides the GST box when input credit cannot be claimed anyway", () => {
    expect(taxFieldsFor(rent, { gst: true }, { ...setup, itcClaimable: false }).gst).toBe(false);
  });

  it("hides a box when the chart has no account for it", () => {
    expect(taxFieldsFor(rent, { gst: true }, { ...setup, gstInputAccountId: null }).gst).toBe(false);
    expect(taxFieldsFor(rent, { tds: true }, { ...setup, tdsPayableAccountId: null }).tds).toBe(
      false,
    );
  });

  it("never offers a tax box on a transaction that cannot carry one", () => {
    for (const id of ["investor_in", "bank_to_cash", "lend_out", "money_back"]) {
      expect(taxFieldsFor(getRecipe(id)!, { gst: true, tds: true }, setup), id).toEqual({
        gst: false,
        tds: false,
      });
    }
  });
});

describe("switching a feature off removes its tiles entirely", () => {
  it("hides the bill tiles when the business does not buy on credit", () => {
    const ids = recipesFor("operations", { purchases_credit: false }).map((r) => r.id);
    expect(ids).not.toContain("bill_received");
    expect(ids).not.toContain("bill_paid");
    expect(ids).not.toContain("advance_against_bill");
    expect(ids).toContain("pay_expense"); // and leaves the rest alone
  });

  it("keeps everything when the features are on, or unknown", () => {
    const on = recipesFor("capex", { purchases_credit: true, capex: true }).map((r) => r.id);
    expect(on).toContain("bill_received");
    expect(on).toContain("construction_spend");
    // an unknown feature map must not silently empty the screen
    expect(recipesFor("capex", undefined).length).toBe(recipesForPhase("capex").length);
  });
});

describe("buy now, pay later — the payables gap that made the balance sheet wrong", () => {
  const PAY = "payables";
  const c = { ...ctx, payablesAccountId: PAY };

  it("a bill creates a liability without any money moving", () => {
    const b = getRecipe("bill_received")!.build({ ...c, targetAccountId: byCode("1440") });
    expect(drOf(b)).toBe(byCode("1440")); // the asset you received
    expect(crOf(b)).toBe(PAY);           // what you now owe
    // no bank account on either side
    const money = [drOf(b), crOf(b)]
      .map((id) => CHART.find((a) => a.id === id)?.is_bank_or_cash ?? false);
    expect(money).toEqual([false, false]);
  });

  it("paying a bill reduces the liability, and is NOT a second cost", () => {
    const b = getRecipe("bill_paid")!.build({ ...c, moneyAccountId: byCode("1010") });
    expect(drOf(b)).toBe(PAY);            // liability down
    expect(crOf(b)).toBe(byCode("1010")); // bank down
    // crucially, no expense account is touched — the cost was booked at bill time
    expect(CHART.find((a) => a.id === drOf(b))?.account_type).toBeUndefined();
  });

  it("an advance can be set against a bill with no money moving", () => {
    const b = getRecipe("advance_against_bill")!.build({ ...c, moneyAccountId: byCode("1610") });
    expect(drOf(b)).toBe(PAY);
    expect(crOf(b)).toBe(byCode("1610"));
    expect(CHART.find((a) => a.id === crOf(b))!.is_bank_or_cash).toBe(false);
  });

  it("the full real-world chain nets out correctly", () => {
    // advance 40,000 -> bill 100,000 -> set advance off -> pay balance 60,000
    let advance = 0, payable = 0, asset = 0, bank = 0;
    advance += 40000; bank -= 40000;              // advance paid
    asset += 100000; payable += 100000;           // bill received
    payable -= 40000; advance -= 40000;           // advance set against bill
    payable -= 60000; bank -= 60000;              // balance paid

    expect(advance).toBe(0);        // advance fully used
    expect(payable).toBe(0);        // supplier fully settled
    expect(asset).toBe(100000);     // you own the asset at full value
    expect(bank).toBe(-100000);     // total cash out equals the bill
  });

  it("a bill can carry a due date so it can be chased", () => {
    const f = getRecipe("bill_received")!.fields.find((x) => x.key === "dueDate");
    expect(f).toBeTruthy();
    expect(f!.label.toLowerCase()).toContain("due");
  });
});

describe("lending money out", () => {
  const c = {
    paise: AMT,
    capitalAccountId: "id-3010",
    payablesAccountId: "id-2010",
    moneyAccountId: "id-1010",
    targetAccountId: "id-1220",
  };

  it("is a receivable, not a cost — profit must not move", () => {
    const b = getRecipe("lend_out")!.build(c);
    expect(drOf(b)).toBe("id-1220"); // what they owe us goes up
    expect(crOf(b)).toBe("id-1010"); // bank goes down
    const debited = CHART.find((a) => a.id === drOf(b))!;
    expect(debited.account_type).toBe("asset");
    expect(debited.account_type).not.toBe("expense");
  });

  it("offers only recoverable accounts, never bank or cash", () => {
    const f = getRecipe("lend_out")!.fields.find((x) => x.key === "targetAccount")!;
    const opts = accountsFor(CHART, "filter" in f ? f.filter : undefined);
    expect(opts.map((a) => a.code)).toContain("1220");
    expect(opts.every((a) => !a.is_bank_or_cash)).toBe(true);
  });

  it("lending out then being paid back nets to zero", () => {
    const out = getRecipe("lend_out")!.build(c);
    const back = getRecipe("money_back")!.build(c);
    // the same account is debited going out and credited coming back
    expect(drOf(out)).toBe(crOf(back));
    expect(crOf(out)).toBe(drOf(back));
  });
});

describe("finding the right entry by typing", () => {
  const ALL = RECIPES;

  it("finds lending from the words a person would actually use", () => {
    for (const q of ["lend", "lent money", "loan given", "my other business", "returnable", "cafe"]) {
      expect(searchRecipes(ALL, q)[0]?.id, q).toBe("lend_out");
    }
  });

  /* --------------------------------------------------------------------------
     A bare "loan" used to land straight on "I lent money out". Someone
     recording a loan the business RECEIVED would have posted the exact inverse
     — money out, booked as an asset — and it would have balanced, hashed and
     looked entirely normal. The app now says it does not know which way round
     the money went, which is the truth.
  -------------------------------------------------------------------------- */
  it("refuses to guess the direction of a bare “loan”", () => {
    expect(directionNote("loan")).toBeTruthy();
    expect(directionNote("borrow")).toBeTruthy();
    expect(directionNote("refund")).toBeTruthy();
    // once the direction is in the words, it stops second-guessing
    expect(directionNote("loan given")).toBeNull();
    expect(directionNote("lent")).toBeNull();
    expect(directionNote("rent")).toBeNull();
  });

  it("finds the common ones too", () => {
    expect(searchRecipes(ALL, "rent")[0]!.id).toBe("pay_expense");
    expect(searchRecipes(ALL, "invoice")[0]!.id).toBe("bill_received");
    expect(searchRecipes(ALL, "withdraw")[0]!.id).toBe("bank_to_cash");
    expect(searchRecipes(ALL, "share capital")[0]!.id).toBe("investor_in");
  });

  it("an empty search shows everything", () => {
    expect(searchRecipes(ALL, "").length).toBe(ALL.length);
    expect(searchRecipes(ALL, "   ").length).toBe(ALL.length);
  });

  it("a word that matches nothing returns nothing, rather than everything", () => {
    expect(searchRecipes(ALL, "xyzzy")).toEqual([]);
    // every word must match: "lend" alone hits, "lend xyzzy" must not
    expect(searchRecipes(ALL, "lend xyzzy")).toEqual([]);
  });

  it("every recipe is reachable by its own title", () => {
    for (const r of ALL) {
      const hit = searchRecipes(ALL, r.title);
      expect(hit.map((x) => x.id), r.title).toContain(r.id);
    }
  });
});
