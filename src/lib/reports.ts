import { supabase } from "./supabase";

export type Balance = {
  account_id: string;
  code: string;
  name: string;
  account_type: "asset" | "liability" | "equity" | "income" | "expense";
  account_group: string | null;
  sub_group: string | null;
  capex_role: string | null;
  is_bank_or_cash: boolean;
  opening_debit: string;
  opening_credit: string;
  period_debit: string;
  period_credit: string;
  closing_debit: string;
  closing_credit: string;
  net: string;
};

export type LedgerRow = {
  entry_date: string;
  voucher_no: string;
  voucher_type: string;
  narration: string;
  counter_accounts: string | null;
  debit: string;
  credit: string;
  running: string;
  entry_id: string;
  book_code: string;
};

export type CashRow = {
  entry_date: string;
  voucher_no: string;
  account_name: string;
  contra: string | null;
  money_in: string;
  money_out: string;
  running: string;
  entry_id: string;
};

/* `solo` picks which book a report actually reads:
     true  (the default everywhere in the app) -> exactly the book passed in,
           nothing else. Official mode reads statutory alone; internal mode
           now reads the management book ALONE — no official figures mixed in.
     false -> the true merge: management book's own entries PLUS the official
           ones underneath it. Used only by the Unified section, which exists
           precisely to be the one place that shows both together. */
export async function accountBalances(
  companyId: string,
  bookId: string,
  asOn?: string,
  from?: string,
  solo = true,
): Promise<Balance[]> {
  const { data, error } = await supabase.rpc("account_balances", {
    p_company: companyId,
    p_book: bookId,
    p_as_on: asOn ?? null,
    p_from: from ?? null,
    p_solo: solo,
  });
  if (error) throw error;
  return (data ?? []) as Balance[];
}

export async function generalLedger(
  companyId: string,
  bookId: string,
  accountId: string,
  from?: string,
  to?: string,
  solo = true,
): Promise<LedgerRow[]> {
  const { data, error } = await supabase.rpc("general_ledger", {
    p_company: companyId,
    p_book: bookId,
    p_account: accountId,
    p_from: from ?? null,
    p_to: to ?? null,
    p_solo: solo,
  });
  if (error) throw error;
  return (data ?? []) as LedgerRow[];
}

export async function cashBook(
  companyId: string,
  bookId: string,
  from?: string,
  to?: string,
  solo = true,
): Promise<CashRow[]> {
  const { data, error } = await supabase.rpc("cash_book", {
    p_company: companyId,
    p_book: bookId,
    p_from: from ?? null,
    p_to: to ?? null,
    p_solo: solo,
  });
  if (error) throw error;
  return (data ?? []) as CashRow[];
}

/* ============================================================================
   Statement shaping. Kept in plain functions (not components) so the numbers
   are unit-testable without rendering anything.

   Sign convention: `net` is Dr-positive, so a credit balance is negative.
   Liabilities, equity and income are displayed as positive by negating.
   ========================================================================= */

import { toPaise } from "./money";

/**
 * Negating a zero total in JS yields -0, which Intl formats as "-₹0". On a
 * profit & loss that reads as a bug, so every figure that gets sign-flipped for
 * display is normalised here.
 */
const z = (n: number) => (n === 0 ? 0 : n);

const sumNet = (rows: Balance[], pred: (b: Balance) => boolean) =>
  z(rows.filter(pred).reduce((n, b) => n + toPaise(b.net), 0));

export type StatementLine = { label: string; paise: number; indent?: boolean };

/** Profit & Loss. Income and expenses only — capital spend never appears here. */
export function profitAndLoss(rows: Balance[]) {
  const bySub = (type: Balance["account_type"], sub: string) =>
    sumNet(rows, (b) => b.account_type === type && b.sub_group === sub);

  const incomeSubs = [...new Set(rows.filter((b) => b.account_type === "income").map((b) => b.sub_group ?? "Other"))];
  const expenseSubs = [...new Set(rows.filter((b) => b.account_type === "expense").map((b) => b.sub_group ?? "Other"))];

  const income: StatementLine[] = incomeSubs
    .map((s) => ({ label: s, paise: z(-bySub("income", s)), indent: true }))
    .filter((l) => l.paise !== 0);
  const expenses: StatementLine[] = expenseSubs
    .map((s) => ({ label: s, paise: bySub("expense", s), indent: true }))
    .filter((l) => l.paise !== 0);

  const totalIncome = z(-sumNet(rows, (b) => b.account_type === "income"));
  const totalExpense = sumNet(rows, (b) => b.account_type === "expense");

  return { income, expenses, totalIncome, totalExpense, profit: z(totalIncome - totalExpense) };
}

/** Balance Sheet. Assets on one side; equity + liabilities + profit on the other. */
export function balanceSheet(rows: Balance[]) {
  const group = (type: Balance["account_type"], sign: 1 | -1) => {
    const subs = [...new Set(rows.filter((b) => b.account_type === type).map((b) => b.sub_group ?? "Other"))];
    return subs
      .map((s) => ({
        label: s,
        paise: z(sign * sumNet(rows, (b) => b.account_type === type && (b.sub_group ?? "Other") === s)),
        indent: true,
      }))
      .filter((l) => l.paise !== 0);
  };

  const assets = group("asset", 1);
  const liabilities = group("liability", -1);
  const equity = group("equity", -1);

  const totalAssets = sumNet(rows, (b) => b.account_type === "asset");
  const totalLiabilities = z(-sumNet(rows, (b) => b.account_type === "liability"));
  const totalEquity = z(-sumNet(rows, (b) => b.account_type === "equity"));
  const profit = z(
    -sumNet(rows, (b) => b.account_type === "income") - sumNet(rows, (b) => b.account_type === "expense"),
  );

  return {
    assets,
    liabilities,
    equity,
    totalAssets,
    totalLiabilities,
    totalEquity,
    profit,
    totalEquityAndLiabilities: z(totalEquity + totalLiabilities + profit),
    tallies: totalAssets === totalEquity + totalLiabilities + profit,
  };
}

/** Trial balance totals — the arithmetic proof that the books hold together. */
export function trialBalanceTotals(rows: Balance[]) {
  const dr = rows.reduce((n, b) => n + toPaise(b.closing_debit), 0);
  const cr = rows.reduce((n, b) => n + toPaise(b.closing_credit), 0);
  return { dr, cr, tallies: dr === cr };
}
