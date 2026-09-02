import { describe, expect, it } from "vitest";
import { buildBuckets } from "./Capex";
import type { Balance } from "../../lib/reports";
import { toPaise } from "../../lib/money";

/* ============================================================================
   Every rupee raised has to land in exactly one bucket.

   The old screen summed four `capex_role` tiles and showed nothing else, so any
   account without one of those roles was invisible. On the live company that
   hid ₹1,17,000 of ₹10,17,000 while the headline above it still claimed
   ₹6,17,000 "has been put to work" — a breakdown that did not add up to its own
   total, with nothing pointing at the difference.

   These tests use a full, realistic set of balances, so they fail if the bucket
   is ever narrowed back into a fixed list of roles.
   ========================================================================= */

let n = 0;
function bal(p: Partial<Balance> & { net: string }): Balance {
  n += 1;
  return {
    account_id: `acc-${n}`,
    code: "0000",
    name: `Account ${n}`,
    account_type: "asset",
    account_group: null,
    sub_group: null,
    capex_role: null,
    is_bank_or_cash: false,
    opening_debit: "0",
    opening_credit: "0",
    period_debit: "0",
    period_credit: "0",
    closing_debit: "0",
    closing_credit: "0",
    ...p,
  };
}

/** An example set of balances, shaped exactly like a real one. */
const LIVE: Balance[] = [
  bal({ name: "Cash in Hand (internal only)", is_bank_or_cash: true, net: "400000.00" }),
  bal({ name: "Advance to Related Party (Returnable)", net: "90000.00" }),
  bal({ name: "Other Advances Recoverable", net: "2500.00" }),
  bal({ name: "Capital Work in Progress - Building", capex_role: "cwip", net: "15000.00" }),
  bal({ name: "Capital Work in Progress - Fit-out", capex_role: "cwip", net: "125000.00" }),
  bal({ name: "Capital Advance - Furniture", capex_role: "capital_advance", net: "60000.00" }),
  bal({ name: "Advance for Premises Lease", capex_role: "deposit", net: "300000.00" }),
  bal({ name: "Partners / Shareholders Capital", account_type: "equity", capex_role: "capital", net: "-1017000.00" }),
  bal({ name: "Professional & Legal Fees", account_type: "expense", net: "20000.00" }),
  bal({ name: "Licences, Permits & Statutory Fees", account_type: "expense", net: "4500.00" }),
];

const CAPITAL = toPaise("1017000.00");
const CASH = toPaise("400000.00");
const sum = (bs: ReturnType<typeof buildBuckets>) => bs.reduce((t, b) => t + b.paise, 0);

describe("where the money went", () => {
  const buckets = buildBuckets(LIVE);

  it("accounts for every rupee deployed — nothing invisible", () => {
    expect(sum(buckets) + CASH).toBe(CAPITAL);
  });

  it("shows real expenses, which have no capex_role and never will", () => {
    const spent = buckets.find((b) => b.key === "expense");
    expect(spent?.paise).toBe(toPaise("24500.00"));
    expect(spent?.rows.map((r) => r.name)).toContain("Professional & Legal Fees");
  });

  it("catches recoverable advances that carry no role", () => {
    const other = buckets.find((b) => b.key === "other");
    expect(other?.paise).toBe(toPaise("92500.00"));
  });

  it("never counts an account twice", () => {
    const ids = buckets.flatMap((b) => b.rows.map((r) => r.account_id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps cash and capital out of the buckets", () => {
    const names = buckets.flatMap((b) => b.rows.map((r) => r.name));
    expect(names).not.toContain("Cash in Hand (internal only)");
    expect(names).not.toContain("Partners / Shareholders Capital");
  });

  it("hides buckets that are empty rather than showing a row of zeroes", () => {
    expect(buckets.every((b) => b.rows.length > 0)).toBe(true);
    expect(buckets.find((b) => b.key === "ppe")).toBeUndefined();
  });

  // The whole point of the catch-all. An account shape nobody has thought of
  // yet must still show up somewhere.
  it("swallows an account type that did not exist when this was written", () => {
    const withOddball = [...LIVE, bal({ name: "Something New", sub_group: "Who Knows", net: "5000.00" })];
    const b2 = buildBuckets(withOddball);
    expect(sum(b2) + CASH).toBe(CAPITAL + toPaise("5000.00"));
    expect(b2.flatMap((b) => b.rows.map((r) => r.name))).toContain("Something New");
  });
});
