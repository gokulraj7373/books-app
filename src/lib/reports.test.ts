import { describe, expect, it } from "vitest";
import { balanceSheet, profitAndLoss, trialBalanceTotals, type Balance } from "./reports";
import { inr } from "./money";

/**
 * The closing balances produced by the 16 example opening transactions in
 * supabase/tests/workbook_parity.sql. The two fixtures must agree: if this
 * file stops matching that one, the reporting engine has drifted.
 */
const b = (
  code: string,
  name: string,
  account_type: Balance["account_type"],
  sub_group: string,
  net: string,
  extra: Partial<Balance> = {},
): Balance => {
  const n = Number(net);
  return {
    account_id: code,
    code,
    name,
    account_type,
    account_group: null,
    sub_group,
    capex_role: null,
    is_bank_or_cash: false,
    opening_debit: "0",
    opening_credit: "0",
    period_debit: n > 0 ? net : "0",
    period_credit: n < 0 ? String(-n) : "0",
    closing_debit: n > 0 ? net : "0",
    closing_credit: n < 0 ? String(-n) : "0",
    net,
    ...extra,
  };
};

const WORKBOOK: Balance[] = [
  b("1010", "Bank - Current A/c", "asset", "Cash & Bank", "160000", { is_bank_or_cash: true }),
  b("1220", "Advance to Related Party (Returnable)", "asset", "Loans & Advances (Current)", "90000"),
  b("1510", "Capital Work in Progress - Building", "asset", "Capital Work in Progress", "510000"),
  b("1610", "Capital Advance - Furniture", "asset", "Capital Advances", "60000"),
  b("1710", "Advance for Premises Lease", "asset", "Deposits", "150000"),
  b("3010", "Partners / Shareholders Capital", "equity", "Partners Capital", "-1000000"),
  b("5910", "Incorporation & Registration Fees", "expense", "Preliminary & Pre-operative", "30000"),
];

describe("workbook parity — the figures must match the Excel file exactly", () => {
  it("trial balance tallies at 10,00,000", () => {
    const t = trialBalanceTotals(WORKBOOK);
    expect(t.tallies).toBe(true);
    expect(inr(t.dr, { paise: false })).toBe("₹10,00,000");
    expect(inr(t.cr, { paise: false })).toBe("₹10,00,000");
  });

  it("balance sheet totals 9,70,000 on both sides", () => {
    const bs = balanceSheet(WORKBOOK);
    expect(inr(bs.totalAssets, { paise: false })).toBe("₹9,70,000");
    expect(inr(bs.totalEquityAndLiabilities, { paise: false })).toBe("₹9,70,000");
    expect(bs.tallies).toBe(true);
  });

  it("shows a net loss of 30,000 — only the incorporation fee is an expense", () => {
    const pl = profitAndLoss(WORKBOOK);
    expect(pl.totalIncome).toBe(0);
    expect(inr(pl.totalExpense, { paise: false })).toBe("₹30,000");
    expect(inr(pl.profit, { paise: false })).toBe("-₹30,000");
  });

  it("keeps capital spending OFF the profit & loss", () => {
    const pl = profitAndLoss(WORKBOOK);
    const labels = pl.expenses.map((e) => e.label);
    // 5,10,000 of building work is an asset, not a cost — this is the single
    // thing that most confuses people reading a pre-revenue P&L.
    expect(labels).not.toContain("Capital Work in Progress");
    expect(labels).not.toContain("Capital Advances");
    expect(labels).toEqual(["Preliminary & Pre-operative"]);
  });

  it("reports the CapEx position that Tally and Zoho have no concept of", () => {
    const bs = balanceSheet(WORKBOOK);
    const find = (l: string) => bs.assets.find((a) => a.label === l)?.paise ?? 0;
    expect(inr(find("Capital Work in Progress"), { paise: false })).toBe("₹5,10,000");
    expect(inr(find("Capital Advances"), { paise: false })).toBe("₹60,000");
    expect(inr(find("Deposits"), { paise: false })).toBe("₹1,50,000");
    expect(inr(find("Cash & Bank"), { paise: false })).toBe("₹1,60,000");
  });
});

describe("balance sheet identity", () => {
  it("detects a set of books that does not tally", () => {
    const broken = [...WORKBOOK, b("9999", "Rogue", "asset", "Other", "1")];
    expect(balanceSheet(broken).tallies).toBe(false);
    expect(trialBalanceTotals(broken).tallies).toBe(false);
  });

  it("treats a credit balance on an asset as negative, not as a liability", () => {
    const overdrawn = [b("1010", "Bank", "asset", "Cash & Bank", "-5000", { is_bank_or_cash: true })];
    expect(balanceSheet(overdrawn).totalAssets).toBe(-500000);
  });
});
