/**
 * SheetJS is loaded ON DEMAND, not at import time.
 *
 * It is by far the largest dependency in the app, and a static import chained
 * it from the entry point — so every visitor downloaded the whole spreadsheet
 * library before the sign-in screen could render, including the many who never
 * export anything. Now it arrives only when someone actually asks for a file.
 *
 * The promise is cached, so exporting twice does not fetch it twice.
 */
let xlsxModule: Promise<typeof import("xlsx")> | null = null;
const loadXLSX = () => (xlsxModule ??= import("xlsx"));
import { supabase } from "./supabase";
import {
  accountBalances,
  balanceSheet,
  cashBook,
  profitAndLoss,
  trialBalanceTotals,
} from "./reports";
import { investorMaster, openBills, partyBalances, type Company } from "./queries";
import { toPaise } from "./money";

/* ============================================================================
   Export the whole book to one Excel file.

   This is the owner's escape hatch. If this app disappears tomorrow, the books
   must still exist in a form any accountant can open — so the export is not a
   marketing feature, it is the thing that makes depending on this app safe.

   Deliberately uses the MAINTAINED SheetJS build from their own CDN, not the
   `xlsx` package on npm: that one is a stale fork with unfixed prototype
   pollution and ReDoS advisories.
   ========================================================================= */

type Row = Record<string, string | number | null>;

const n = (v: string | null | undefined) => (v == null ? 0 : toPaise(v) / 100);

async function fetchLedger(companyId: string) {
  const { data, error } = await supabase
    .from("journal_entries")
    .select(
      "id,voucher_no,voucher_type,entry_date,narration,status,due_date,payment_terms," +
        "reference_no,payment_mode,proof_url,created_by_name,posted_by_name,seq," +
        "books(code,name),journal_lines(line_no,debit,credit,line_narration,qty,unit,hsn_sac," +
        "accounts(code,name,account_type,sub_group),parties(name))",
    )
    .eq("company_id", companyId)
    .eq("status", "posted")
    .order("entry_date")
    .order("seq");
  if (error) throw error;
  return data ?? [];
}

export async function exportWorkbook(company: Company, bookId: string): Promise<Blob> {
  const [entries, balances, cash, parties, bills, investors] = await Promise.all([
    fetchLedger(company.id),
    accountBalances(company.id, bookId),
    cashBook(company.id, bookId),
    partyBalances(company.id, bookId),
    openBills(company.id, bookId),
    investorMaster(company.id),
  ]);

  const XLSX = await loadXLSX();
  const wb = XLSX.utils.book_new();

  // ---- Journal: one row per line, which is what an accountant wants to see ---
  type LedgerEntry = Record<string, string | null> & {
    books: { code: string } | null;
    journal_lines: (Record<string, string | null> & {
      accounts: Record<string, string> | null;
      parties: Record<string, string> | null;
    })[];
  };

  const journal: Row[] = [];
  for (const ent of entries as unknown as LedgerEntry[]) {
    for (const l of ent.journal_lines ?? []) {
      const acc = l.accounts;
      const pty = l.parties;
      journal.push({
        Book: ent.books?.code ?? "",
        Date: ent.entry_date,
        Voucher: ent.voucher_no,
        Type: ent.voucher_type,
        "Account code": acc?.code ?? "",
        Account: acc?.name ?? "",
        Party: pty?.name ?? "",
        Narration: ent.narration,
        "Line note": l.line_narration ?? "",
        Qty: l.qty ?? "",
        Unit: l.unit ?? "",
        "HSN/SAC": l.hsn_sac ?? "",
        Debit: n(l.debit),
        Credit: n(l.credit),
        "Bill / ref": ent.reference_no ?? "",
        "Due date": ent.due_date ?? "",
        Terms: ent.payment_terms ?? "",
        "Paid by": ent.payment_mode ?? "",
        Proof: ent.proof_url ?? "",
        "Entered by": ent.created_by_name ?? "",
        "Posted by": ent.posted_by_name ?? "",
      });
    }
  }

  const tb = trialBalanceTotals(balances);
  const trial: Row[] = balances
    .filter((b) => toPaise(b.closing_debit) || toPaise(b.closing_credit))
    .map((b) => ({
      Code: b.code,
      Account: b.name,
      Type: b.account_type,
      Group: b.sub_group ?? "",
      Debit: n(b.closing_debit),
      Credit: n(b.closing_credit),
    }));
  trial.push({ Code: "", Account: "TOTAL", Type: "", Group: "", Debit: tb.dr / 100, Credit: tb.cr / 100 });

  const sheets: [string, Row[]][] = [
    ["Journal", journal],
    ["Trial Balance", trial],
    [
      "Chart of Accounts",
      balances.map((b) => ({
        Code: b.code,
        Account: b.name,
        Type: b.account_type,
        Group: b.sub_group ?? "",
        "Closing (Dr +)": n(b.net),
      })),
    ],
    [
      "Cash and Bank",
      cash.map((c) => ({
        Date: c.entry_date,
        Voucher: c.voucher_no,
        Account: c.account_name,
        For: c.contra ?? "",
        In: n(c.money_in),
        Out: n(c.money_out),
        Balance: n(c.running),
      })),
    ],
    [
      "Parties",
      parties.map((p) => ({
        Party: p.name,
        Type: p.party_type ?? "",
        "Related party": p.is_related_party ? "Yes" : "",
        Balance: n(p.balance),
        "Last activity": p.last_activity ?? "",
        Entries: p.entry_count,
      })),
    ],
    [
      "Bills",
      bills.map((b) => ({
        Supplier: b.party_name ?? "",
        "Their bill no": b.supplier_bill_no ?? "",
        Voucher: b.voucher_no,
        "Bill date": b.bill_date,
        "Due date": b.due_date ?? "",
        Terms: b.payment_terms ?? "",
        Total: n(b.total),
        Settled: n(b.settled),
        Outstanding: n(b.outstanding),
        "Days overdue": b.days_overdue,
      })),
    ],
    [
      "Investors",
      investors.map((i) => ({
        Investor: i.name,
        "Agreed share %": Number(i.agreed_share_pct),
        Committed: n(i.committed),
        "Share capital": n(i.share_capital),
        "Repayable funding": n(i.investor_loan),
        "Not yet classified": n(i.pending),
        "Outside the company": n(i.outside_books),
        "Total put in": n(i.total_in),
        "Still to bring": n(i.still_to_bring),
        "% funded": Number(i.pct_funded),
      })),
    ],
  ];

  for (const [name, rows] of sheets) {
    const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ "": "No data" }]);
    XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
  }

  const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  return new Blob([out], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ============================================================================
   A single report as its own Excel file.

   The report list used to show a "printable" badge that only navigated to the
   screen — it promised an output it never produced. These functions produce the
   actual file.
   ========================================================================= */

export type ReportKind =
  | "trial-balance"
  | "balance-sheet"
  | "profit-loss"
  | "cash-book"
  | "investors"
  | "parties"
  | "bills";

const SHEET_NAME: Record<ReportKind, string> = {
  "trial-balance": "Trial Balance",
  "balance-sheet": "Balance Sheet",
  "profit-loss": "Profit and Loss",
  "cash-book": "Cash and Bank",
  investors: "Investors",
  parties: "Parties",
  bills: "Bills",
};

export async function exportReport(
  company: Company,
  bookId: string,
  kind: ReportKind,
): Promise<Blob> {
  let rows: Row[] = [];

  if (kind === "trial-balance") {
    const b = await accountBalances(company.id, bookId);
    const t = trialBalanceTotals(b);
    rows = b
      .filter((x) => toPaise(x.closing_debit) || toPaise(x.closing_credit))
      .map((x) => ({
        Code: x.code,
        Account: x.name,
        Type: x.account_type,
        Group: x.sub_group ?? "",
        Debit: n(x.closing_debit),
        Credit: n(x.closing_credit),
      }));
    rows.push({ Code: "", Account: "TOTAL", Type: "", Group: "", Debit: t.dr / 100, Credit: t.cr / 100 });
  } else if (kind === "balance-sheet") {
    const bs = balanceSheet(await accountBalances(company.id, bookId));
    rows = [
      ...bs.assets.map((l) => ({ Section: "Assets", Line: l.label, Amount: l.paise / 100 })),
      { Section: "Assets", Line: "TOTAL ASSETS", Amount: bs.totalAssets / 100 },
      ...bs.equity.map((l) => ({ Section: "Equity", Line: l.label, Amount: l.paise / 100 })),
      { Section: "Equity", Line: "Accumulated profit / (loss)", Amount: bs.profit / 100 },
      ...bs.liabilities.map((l) => ({ Section: "Liabilities", Line: l.label, Amount: l.paise / 100 })),
      {
        Section: "Equity & liabilities",
        Line: "TOTAL EQUITY & LIABILITIES",
        Amount: bs.totalEquityAndLiabilities / 100,
      },
    ];
  } else if (kind === "profit-loss") {
    const pl = profitAndLoss(await accountBalances(company.id, bookId));
    rows = [
      ...pl.income.map((l) => ({ Section: "Income", Line: l.label, Amount: l.paise / 100 })),
      { Section: "Income", Line: "TOTAL INCOME", Amount: pl.totalIncome / 100 },
      ...pl.expenses.map((l) => ({ Section: "Expenses", Line: l.label, Amount: l.paise / 100 })),
      { Section: "Expenses", Line: "TOTAL EXPENSES", Amount: pl.totalExpense / 100 },
      { Section: "Result", Line: pl.profit >= 0 ? "NET PROFIT" : "NET LOSS", Amount: pl.profit / 100 },
    ];
  } else if (kind === "cash-book") {
    rows = (await cashBook(company.id, bookId)).map((c) => ({
      Date: c.entry_date,
      Voucher: c.voucher_no,
      Account: c.account_name,
      For: c.contra ?? "",
      In: n(c.money_in),
      Out: n(c.money_out),
      Balance: n(c.running),
    }));
  } else if (kind === "investors") {
    rows = (await investorMaster(company.id)).map((i) => ({
      Investor: i.name,
      "Agreed share %": Number(i.agreed_share_pct),
      Committed: n(i.committed),
      "Share capital": n(i.share_capital),
      "Repayable funding": n(i.investor_loan),
      "Not yet classified": n(i.pending),
      "Outside the company": n(i.outside_books),
      "Total put in": n(i.total_in),
      "Still to bring": n(i.still_to_bring),
      "% funded": Number(i.pct_funded),
    }));
  } else if (kind === "parties") {
    rows = (await partyBalances(company.id, bookId)).map((p) => ({
      Party: p.name,
      Type: p.party_type ?? "",
      "Related party": p.is_related_party ? "Yes" : "",
      Balance: n(p.balance),
      "Last activity": p.last_activity ?? "",
      Entries: p.entry_count,
    }));
  } else {
    rows = (await openBills(company.id, bookId)).map((b) => ({
      Supplier: b.party_name ?? "",
      "Their bill no": b.supplier_bill_no ?? "",
      Voucher: b.voucher_no,
      "Bill date": b.bill_date,
      "Due date": b.due_date ?? "",
      Terms: b.payment_terms ?? "",
      Total: n(b.total),
      Settled: n(b.settled),
      Outstanding: n(b.outstanding),
      "Days overdue": b.days_overdue,
    }));
  }

  const XLSX = await loadXLSX();
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ "": "No data" }]);
  XLSX.utils.book_append_sheet(wb, ws, SHEET_NAME[kind]);
  const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  return new Blob([out], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}
