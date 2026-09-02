import { supabase } from "./supabase";
import type { TaxSetup } from "./recipes";

export type Company = {
  id: string;
  org_id: string;
  name: string;
  legal_name: string | null;
  legal_form: string | null;
  pan: string | null;
  gstin: string | null;
  cin: string | null;
  state_code: string | null;
  base_currency: string;
  books_start_date: string;
  lifecycle_phase: "capex" | "transition" | "operations";
  /** Which chart_templates key this company was seeded from. */
  industry: string | null;
  target_investment: string;
  authorised_capital: string;
  show_internal_to_investors: boolean;
};

export type Book = {
  id: string;
  company_id: string;
  code: string;
  name: string;
  kind: "primary" | "adjustment";
  is_statutory: boolean;
};

export type Account = {
  id: string;
  code: string;
  name: string;
  account_type: "asset" | "liability" | "equity" | "income" | "expense";
  account_group: string | null;
  sub_group: string | null;
  normal_balance: "D" | "C";
  is_group: boolean;
  is_bank_or_cash: boolean;
  is_active: boolean;
  /**
   * The app's own plumbing — Suspense, Exchange Rate Difference, the
   * internal-only cash account. Never offered in an ordinary picker; see
   * `accountsFor` in lib/recipes.ts.
   */
  is_system: boolean;
  capex_role: string | null;
  restricted_to_book_id: string | null;
};

export type JournalEntry = {
  id: string;
  voucher_no: string;
  voucher_type: string;
  entry_date: string;
  narration: string;
  status: string;
  book_id: string;
  proof_url: string | null;
  payment_mode: string | null;
  created_by_name: string | null;
  posted_by_name: string | null;
  /** set when a correction has cancelled this entry out */
  reversed_by_entry_id: string | null;
  /** set when this entry IS the correction of another one */
  reverses_entry_id: string | null;
};

export async function listCompanies(): Promise<Company[]> {
  const { data, error } = await supabase
    .from("companies")
    .select(
      "id,org_id,name,legal_name,legal_form,pan,gstin,cin,state_code,base_currency,books_start_date,lifecycle_phase,industry,target_investment,authorised_capital,show_internal_to_investors",
    )
    .order("created_at");
  if (error) throw error;
  return data ?? [];
}

export async function listBooks(companyId: string): Promise<Book[]> {
  const { data, error } = await supabase
    .from("books")
    .select("id,company_id,code,name,kind,is_statutory")
    .eq("company_id", companyId)
    .order("kind");
  if (error) throw error;
  return data ?? [];
}

export async function listAccounts(companyId: string): Promise<Account[]> {
  const { data, error } = await supabase
    .from("accounts")
    .select(
      "id,code,name,account_type,account_group,sub_group,normal_balance,is_group,is_bank_or_cash,is_active,is_system,capex_role,restricted_to_book_id",
    )
    .eq("company_id", companyId)
    .order("code");
  if (error) throw error;
  return data ?? [];
}

export async function listEntries(companyId: string, bookId?: string): Promise<JournalEntry[]> {
  let q = supabase
    .from("journal_entries")
    .select(
      "id,voucher_no,voucher_type,entry_date,narration,status,book_id,proof_url,payment_mode,created_by_name,posted_by_name,reversed_by_entry_id,reverses_entry_id",
    )
    .eq("company_id", companyId)
    .order("entry_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(200);
  if (bookId) q = q.eq("book_id", bookId);
  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

/** My rights on a company, resolved from company_members. */
export async function myRights(companyId: string): Promise<Record<string, boolean>> {
  const { data: userData } = await supabase.auth.getUser();
  const uid = userData.user?.id;
  if (!uid) return {};
  const { data } = await supabase
    .from("company_members")
    .select("rights,role_key")
    .eq("company_id", companyId)
    .eq("user_id", uid)
    .maybeSingle();
  return (data?.rights as Record<string, boolean>) ?? {};
}

export async function createCompany(payload: {
  name: string;
  legal_form?: string;
  books_start_date: string;
  lifecycle_phase?: string;
  pan?: string;
  gstin?: string;
  /** A key from chart_templates — decides which chart of accounts is seeded. */
  industry?: string;
}): Promise<string> {
  const { data, error } = await supabase.rpc("create_company", { p_payload: payload });
  if (error) throw error;
  return data as string;
}

export type LineInput = {
  account_id: string;
  debit?: string;
  credit?: string;
  line_narration?: string;
  /** Tags the line to a supplier/investor so party statements work. */
  party_id?: string;
  /** Links spend to a capital project budget line. */
  capital_project_line_id?: string;
};

export async function saveJournalEntry(payload: {
  company_id: string;
  book_id: string;
  voucher_type: string;
  entry_date: string;
  narration: string;
  status: "draft" | "posted";
  adjustment_reason?: string;
  payment_mode?: string;
  reference_no?: string;
  proof_url?: string;
  idempotency_key?: string;
  due_date?: string;
  source?: string;
  lines: LineInput[];
}): Promise<string> {
  const { data, error } = await supabase.rpc("save_journal_entry", { p_payload: payload });
  if (error) throw error;
  return data as string;
}

export async function verifyChain(companyId: string, bookId: string): Promise<number | null> {
  const { data, error } = await supabase.rpc("verify_chain", {
    p_company: companyId,
    p_book: bookId,
  });
  if (error) throw error;
  return data as number | null;
}

/* ---------------------------------------------------------------- parties --
   A party is what Tally calls a ledger: Meridian Furniture, an investor, a
   contractor. It is created by typing the name during entry, not on a separate
   screen — see find_or_create_party.
   -------------------------------------------------------------------------- */

export type PartyBalance = {
  party_id: string;
  name: string;
  party_type: string | null;
  is_related_party: boolean;
  balance: string;
  last_activity: string | null;
  entry_count: number;
};

export type PartyStatementRow = {
  entry_date: string;
  voucher_no: string;
  narration: string;
  account_name: string;
  debit: string;
  credit: string;
  running: string;
  entry_id: string;
};

export async function partyBalances(
  companyId: string,
  bookId: string,
  solo = true,
): Promise<PartyBalance[]> {
  const { data, error } = await supabase.rpc("party_balances", {
    p_company: companyId,
    p_book: bookId,
    p_solo: solo,
  });
  if (error) throw error;
  return (data ?? []) as PartyBalance[];
}

export async function partyStatement(
  companyId: string,
  partyId: string,
  bookId: string,
  from?: string,
  to?: string,
  solo = true,
): Promise<PartyStatementRow[]> {
  const { data, error } = await supabase.rpc("party_statement", {
    p_company: companyId,
    p_party: partyId,
    p_book: bookId,
    p_from: from ?? null,
    p_to: to ?? null,
    p_solo: solo,
  });
  if (error) throw error;
  return (data ?? []) as PartyStatementRow[];
}

/* ------------------------------------------------------------- capital -----*/

export type CapexProject = {
  project_id: string;
  name: string;
  status: string;
  budget_amount: string;
  planned_amount: string;
  spent: string;
  cwip_balance: string;
  line_count: number;
  capitalized_on: string | null;
};

export async function capexSummary(
  companyId: string,
  bookId: string,
  solo = true,
): Promise<CapexProject[]> {
  const { data, error } = await supabase.rpc("capex_summary", {
    p_company: companyId,
    p_book: bookId,
    p_solo: solo,
  });
  if (error) throw error;
  return (data ?? []) as CapexProject[];
}

export type ProjectLine = {
  id: string;
  name: string;
  category: string | null;
  planned_amount: string;
  status: string;
  target_ppe_account_id: string | null;
};

export async function listProjectLines(projectId: string): Promise<ProjectLine[]> {
  const { data, error } = await supabase
    .from("capital_project_lines")
    .select("id,name,category,planned_amount,status,target_ppe_account_id")
    .eq("capital_project_id", projectId)
    .order("sort_order")
    .order("created_at");
  if (error) throw error;
  return (data ?? []) as ProjectLine[];
}

export async function createProject(p: {
  company_id: string;
  name: string;
  budget_amount: string;
  cwip_account_id: string;
  target_date?: string;
}): Promise<string> {
  const { data, error } = await supabase
    .from("capital_projects")
    .insert({
      company_id: p.company_id,
      name: p.name,
      budget_amount: p.budget_amount,
      cwip_account_id: p.cwip_account_id,
      target_date: p.target_date || null,
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

export async function addProjectLine(p: {
  capital_project_id: string;
  company_id: string;
  name: string;
  planned_amount: string;
  target_ppe_account_id?: string;
}): Promise<void> {
  const { error } = await supabase.from("capital_project_lines").insert({
    capital_project_id: p.capital_project_id,
    company_id: p.company_id,
    name: p.name,
    planned_amount: p.planned_amount,
    target_ppe_account_id: p.target_ppe_account_id || null,
  });
  if (error) throw error;
}

/* ------------------------------------------------------------ bills --------*/

export type OpenBill = {
  entry_id: string;
  voucher_no: string;
  supplier_bill_no: string | null;
  party_id: string | null;
  party_name: string | null;
  bill_date: string;
  due_date: string | null;
  payment_terms: string | null;
  total: string;
  settled: string;
  outstanding: string;
  days_overdue: number;
  narration: string;
};

export type SupplierAdvance = {
  party_id: string;
  party_name: string;
  account_id: string;
  account_name: string;
  advance_outstanding: string;
};

export type PayableAgeing = {
  party_id: string;
  party_name: string;
  owed: string;
  oldest_due: string | null;
  days_overdue: number;
  bill_count: number;
};

export async function openBills(
  companyId: string,
  bookId: string,
  solo = true,
): Promise<OpenBill[]> {
  const { data, error } = await supabase.rpc("open_bills", {
    p_company: companyId,
    p_book: bookId,
    p_solo: solo,
  });
  if (error) throw error;
  return (data ?? []) as OpenBill[];
}

export async function supplierAdvances(
  companyId: string,
  bookId: string,
  solo = true,
): Promise<SupplierAdvance[]> {
  const { data, error } = await supabase.rpc("supplier_advances", {
    p_company: companyId,
    p_book: bookId,
    p_solo: solo,
  });
  if (error) throw error;
  return (data ?? []) as SupplierAdvance[];
}

export async function payablesAgeing(
  companyId: string,
  bookId: string,
): Promise<PayableAgeing[]> {
  const { data, error } = await supabase.rpc("payables_ageing", {
    p_company: companyId,
    p_book: bookId,
  });
  if (error) throw error;
  return (data ?? []) as PayableAgeing[];
}

export type BillLineInput = {
  account_id: string;
  amount: string;
  description?: string;
  qty?: string;
  unit?: string;
  hsn_sac?: string;
  capital_project_line_id?: string;
};

export async function recordBill(payload: {
  company_id: string;
  book_id: string;
  party_id?: string;
  party_name?: string;
  bill_no?: string;
  bill_date: string;
  due_date?: string;
  payment_terms?: string;
  narration?: string;
  proof_url?: string;
  adjustment_reason?: string;
  lines: BillLineInput[];
  apply_advance?: { account_id: string; amount: string };
  payment?: {
    money_account_id: string;
    amount: string;
    date?: string;
    mode?: string;
    reference?: string;
  };
}): Promise<{
  bill_entry_id: string;
  total: string;
  outstanding: string;
  party_id: string;
}> {
  const { data, error } = await supabase.rpc("record_bill", { p_payload: payload });
  if (error) throw error;
  return data as { bill_entry_id: string; total: string; outstanding: string; party_id: string };
}

export async function payBill(payload: {
  company_id: string;
  bill_entry_id: string;
  amount: string;
  source_account_id: string;
  date?: string;
  mode?: string;
  reference?: string;
  from_advance?: boolean;
  narration?: string;
}): Promise<string> {
  const { data, error } = await supabase.rpc("pay_bill", { p_payload: payload });
  if (error) throw error;
  return data as string;
}

export type UnappliedCredit = { party_id: string; party_name: string; amount: string };

/**
 * Payments or advance adjustments that reduced what we owe a supplier but were
 * never tied to a specific bill. If this is non-zero, the bills list and the
 * ledger disagree — so it is surfaced rather than silently reconciled.
 */
export async function unappliedCredits(
  companyId: string,
  bookId: string,
  solo = true,
): Promise<UnappliedCredit[]> {
  const { data, error } = await supabase.rpc("unapplied_credits", {
    p_company: companyId,
    p_book: bookId,
    p_solo: solo,
  });
  if (error) throw error;
  return (data ?? []) as UnappliedCredit[];
}

/* ---------------------------------------------------------- investors -----
   Share % is fixed by agreement at setup, never derived from who funded first.
   Each investor has four figures because there are two books; they are kept
   separate rather than blended, because blending misleads in both directions.
   -------------------------------------------------------------------------- */

export type InvestorRow = {
  investor_id: string;
  name: string;
  agreed_share_pct: string;
  committed: string;
  share_capital: string;
  investor_loan: string;
  pending: string;
  outside_books: string;
  statutory_total: string;
  total_in: string;
  still_to_bring: string;
  pct_funded: string;
  last_received: string | null;
  receipt_count: number;
};

export async function investorMaster(companyId: string): Promise<InvestorRow[]> {
  const { data, error } = await supabase.rpc("investor_master", { p_company: companyId });
  if (error) throw error;
  return (data ?? []) as InvestorRow[];
}

export async function addInvestor(p: {
  company_id: string;
  name: string;
  agreed_share_pct?: string;
  committed_amount?: string;
  joined_on?: string;
}): Promise<string> {
  const { data, error } = await supabase.rpc("add_investor", { p_payload: p });
  if (error) throw error;
  return data as string;
}

export async function recordInvestment(p: {
  company_id: string;
  investor_id: string;
  kind: "share_capital" | "investor_loan" | "pending";
  amount: string;
  money_account_id: string;
  date?: string;
  mode?: string;
  reference?: string;
  narration?: string;
  proof_url?: string;
}): Promise<string> {
  const { data, error } = await supabase.rpc("record_investment", { p_payload: p });
  if (error) throw error;
  return data as string;
}

export async function reclassifyInvestment(p: {
  company_id: string;
  investor_id: string;
  from_kind: string;
  to_kind: string;
  amount: string;
  date?: string;
  narration?: string;
}): Promise<string> {
  const { data, error } = await supabase.rpc("reclassify_investment", { p_payload: p });
  if (error) throw error;
  return data as string;
}

export async function unclassifiedInvestorFunds(companyId: string): Promise<number> {
  const { data, error } = await supabase.rpc("unclassified_investor_funds", {
    p_company: companyId,
  });
  if (error) throw error;
  return Number(data ?? 0);
}

export async function updateCompanyPlan(p: {
  id: string;
  target_investment?: string;
  authorised_capital?: string;
  show_internal_to_investors?: boolean;
  legal_name?: string | null;
  legal_form?: string | null;
  pan?: string | null;
  gstin?: string | null;
  cin?: string | null;
  state_code?: string | null;
  lifecycle_phase?: "capex" | "transition" | "operations";
}): Promise<void> {
  const { id, ...patch } = p;
  const { error } = await supabase.from("companies").update(patch).eq("id", id);
  if (error) throw error;
}

/* --------------------------------------------------------- period lock ----
   Closing a period stops everyone WITHOUT the unlock_period right (normally
   only the owner has it) from touching anything dated on or before the lock.
   The owner can still post through their own lock — a lock nobody can ever
   see past, including themselves, would just become a way to get stuck.
   -------------------------------------------------------------------------- */

export type PeriodLockStatus = {
  locked_through: string | null;
  locked_by_name: string | null;
  locked_at: string | null;
};

export async function periodLockStatus(
  companyId: string,
  bookId: string,
): Promise<PeriodLockStatus | null> {
  const { data, error } = await supabase.rpc("period_lock_status", {
    p_company: companyId,
    p_book: bookId,
  });
  if (error) throw error;
  const rows = (data ?? []) as PeriodLockStatus[];
  return rows[0] ?? null;
}

export async function lockPeriod(companyId: string, bookId: string, through: string): Promise<void> {
  const { error } = await supabase.rpc("lock_period", {
    p_company: companyId,
    p_book: bookId,
    p_through: through,
  });
  if (error) throw error;
}

export async function unlockPeriod(companyId: string, bookId: string): Promise<void> {
  const { error } = await supabase.rpc("unlock_period", { p_company: companyId, p_book: bookId });
  if (error) throw error;
}

/* --------------------------------------------------------- people ---------*/

export type Person = {
  user_id: string;
  email: string | null;
  full_name: string | null;
  role_key: string;
  investor_name: string | null;
  is_you: boolean;
  joined: string;
};

export type Invite = {
  id: string;
  email: string;
  role_key: string;
  investor_id: string | null;
  invited_at: string;
  claimed_at: string | null;
};

export async function companyPeople(companyId: string): Promise<Person[]> {
  const { data, error } = await supabase.rpc("company_people", { p_company: companyId });
  if (error) throw error;
  return (data ?? []) as Person[];
}

export async function listInvites(companyId: string): Promise<Invite[]> {
  const { data, error } = await supabase
    .from("company_invites")
    .select("id,email,role_key,investor_id,invited_at,claimed_at")
    .eq("company_id", companyId)
    .is("revoked_at", null)
    .order("invited_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as Invite[];
}

export async function createInvite(p: {
  company_id: string;
  email: string;
  role_key: string;
  investor_id?: string | null;
}): Promise<void> {
  const { error } = await supabase.from("company_invites").upsert(
    {
      company_id: p.company_id,
      email: p.email.trim().toLowerCase(),
      role_key: p.role_key,
      investor_id: p.investor_id ?? null,
      claimed_at: null,
      revoked_at: null,
    },
    { onConflict: "company_id,email" },
  );
  if (error) throw error;
}

export async function revokeInvite(id: string): Promise<void> {
  const { error } = await supabase
    .from("company_invites")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

export async function setPersonRole(
  companyId: string,
  userId: string,
  roleKey: string,
): Promise<void> {
  // rights are reset to the role's defaults by the database trigger
  const { error } = await supabase
    .from("company_members")
    .update({ role_key: roleKey, rights: {} })
    .eq("company_id", companyId)
    .eq("user_id", userId);
  if (error) throw error;
}

export async function removePerson(companyId: string, userId: string): Promise<void> {
  const { error } = await supabase
    .from("company_members")
    .delete()
    .eq("company_id", companyId)
    .eq("user_id", userId);
  if (error) throw error;
}

/** Grants membership for any open invite matching the signed-in user's email. */
export async function claimInvites(): Promise<number> {
  const { data, error } = await supabase.rpc("claim_invites");
  if (error) throw error;
  return Number(data ?? 0);
}

/** The signed-in user's role on a company, for badges and role-aware screens. */
export async function myRole(companyId: string): Promise<string | null> {
  const { data: u } = await supabase.auth.getUser();
  const uid = u.user?.id;
  if (!uid) return null;
  const { data } = await supabase
    .from("company_members")
    .select("role_key")
    .eq("company_id", companyId)
    .eq("user_id", uid)
    .maybeSingle();
  return (data?.role_key as string) ?? null;
}

/* ------------------------------------------------------------- alerts -----
   Deterministic rules over the company's own data. Each alert carries the exact
   screen that fixes it, so clicking one always lands somewhere useful.
   -------------------------------------------------------------------------- */

export type Alert = {
  id: string;
  severity: "danger" | "warn" | "info";
  title: string;
  body: string;
  href: string;
  amount: string | null;
  /** false for danger alerts, which must never be hideable */
  dismissible: boolean;
  /** changes when the underlying amount changes, so the alert returns */
  fingerprint: string;
};

export async function companyAlerts(
  companyId: string,
  bookId: string,
  solo = true,
): Promise<Alert[]> {
  // live_alerts = company_alerts minus what this user has dismissed. Danger
  // alerts are never filtered out, however many times they are tapped away.
  // Scoped the same way as whatever reports are currently showing, so the
  // notification panel and the trial balance it links to never disagree.
  const { data, error } = await supabase.rpc("live_alerts", {
    p_company: companyId,
    p_book: bookId,
    p_solo: solo,
  });
  if (error) throw error;
  return (data ?? []) as Alert[];
}

export async function dismissAlert(
  companyId: string,
  alertKey: string,
  fingerprint: string,
): Promise<void> {
  const { error } = await supabase.rpc("dismiss_alert", {
    p_company: companyId,
    p_alert_key: alertKey,
    p_fingerprint: fingerprint,
  });
  if (error) throw error;
}

export async function restoreAlerts(companyId: string): Promise<void> {
  const { error } = await supabase.rpc("restore_alerts", { p_company: companyId });
  if (error) throw error;
}

export async function dismissedAlertCount(companyId: string): Promise<number> {
  const { data, error } = await supabase.rpc("dismissed_alert_count", { p_company: companyId });
  if (error) throw error;
  return Number(data ?? 0);
}

/* ------------------------------------------------------- corrections -----
   The only way to change a posted entry.

   Not an UPDATE. The original stays visible, marked reversed, with an equal and
   opposite entry beside it carrying the reason. That is what an auditor expects
   to see, and it is the reason a number in these books can be trusted: nothing
   ever quietly becomes a different number.
   -------------------------------------------------------------------------- */

export type EntryLine = {
  account_id: string;
  account_name: string;
  account_code: string;
  debit: string;
  credit: string;
  party_id: string | null;
  party_name: string | null;
};

export type EntryDetail = {
  id: string;
  voucher_no: string;
  voucher_type: string;
  entry_date: string;
  narration: string;
  party_id: string | null;
  party_name: string | null;
  payment_mode: string | null;
  reference_no: string | null;
  due_date: string | null;
  proof_url: string | null;
  book_id: string;
  book_name: string;
  book_kind: "primary" | "adjustment";
  status: string;
  created_by_name: string | null;
  posted_by_name: string | null;
  posted_at: string | null;
  reverses_entry_id: string | null;
  reverses_voucher_no: string | null;
  reversed_by_entry_id: string | null;
  reversed_by_voucher_no: string | null;
  lines: EntryLine[];
};

export async function entryDetail(entryId: string): Promise<EntryDetail | null> {
  const { data, error } = await supabase.rpc("entry_detail", { p_entry: entryId });
  if (error) throw error;
  return (data ?? null) as EntryDetail | null;
}

export type Amendment = {
  reason: string;
  amount: string;
  date?: string;
  narration?: string;
  debitAccountId?: string;
  creditAccountId?: string;
  paymentMode?: string;
  reference?: string;
};

/**
 * Correct an entry. Cancels the original and posts the corrected version.
 *
 * PIN required, as of migration 0045 — this cancels a posted voucher, which is
 * exactly what Settings promises the PIN protects. The server ignores it for
 * users who have not set one.
 */
export async function amendEntry(entryId: string, a: Amendment, pin: string): Promise<string> {
  const { data, error } = await supabase.rpc("amend_entry", {
    p_entry: entryId,
    p_reason: a.reason,
    p_amount: a.amount,
    p_date: a.date ?? null,
    p_narration: a.narration ?? null,
    p_debit_account: a.debitAccountId ?? null,
    p_credit_account: a.creditAccountId ?? null,
    p_party: null,
    p_payment_mode: a.paymentMode ?? null,
    p_reference: a.reference ?? null,
    p_pin: pin || null,
  });
  if (error) throw error;
  return data as string;
}

/** Take an entry out of every report. PIN required; the record is kept forever. */
export async function voidEntry(entryId: string, reason: string, pin: string): Promise<void> {
  const { error } = await supabase.rpc("void_entry", {
    p_entry: entryId,
    p_reason: reason,
    p_pin: pin,
  });
  if (error) throw error;
}

export type AuditLogRow = {
  id: string;
  entry_id: string;
  action: "void" | "amend";
  reason: string;
  acted_by_name: string | null;
  acted_at: string;
};

export async function entryAuditLog(companyId: string): Promise<AuditLogRow[]> {
  const { data, error } = await supabase
    .from("entry_audit_log")
    .select("id,entry_id,action,reason,acted_by_name,acted_at")
    .eq("company_id", companyId)
    .order("acted_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data ?? []) as AuditLogRow[];
}

/* ---------------------------------------------------------------- the PIN ---
   Held by the server, not the browser. A PIN checked in the browser protects
   nothing — the API call it guards can simply be made directly — and a PIN in
   localStorage is per-browser, so setting it on a laptop left the phone open.
   -------------------------------------------------------------------------- */

export async function hasUserPin(): Promise<boolean> {
  const { data, error } = await supabase.rpc("has_user_pin");
  if (error) throw error;
  return data === true;
}

export async function setUserPin(pin: string, current?: string): Promise<void> {
  const { error } = await supabase.rpc("set_user_pin", {
    p_pin: pin,
    p_current: current ?? null,
  });
  if (error) throw error;
}

export async function clearUserPin(current: string): Promise<void> {
  const { error } = await supabase.rpc("clear_user_pin", { p_current: current });
  if (error) throw error;
}

/** Cancel a posted entry with an equal and opposite one. PIN required (0045). */
export async function reverseEntry(
  entryId: string,
  reason: string,
  pin: string,
): Promise<string> {
  const { data, error } = await supabase.rpc("reverse_entry", {
    p_entry: entryId,
    p_reason: reason,
    p_pin: pin || null,
  });
  if (error) throw error;
  return data as string;
}

/* ------------------------------------------------------------- backup -----
   A full-fidelity copy of one company, taken and kept by the owner. The Excel
   export is for reading; this one is for surviving.
   -------------------------------------------------------------------------- */

export type BookIntegrity = {
  book_id: string;
  book_name: string;
  entry_count: number;
  last_seq: number | null;
  head_hash: string | null;
  total_debit: string;
  total_credit: string;
};

export type Snapshot = {
  format: string;
  format_version: number;
  taken_at: string;
  company_id: string;
  company: { name: string } & Record<string, unknown>;
  entries: unknown[];
  lines: unknown[];
  accounts: unknown[];
  integrity: BookIntegrity[];
} & Record<string, unknown>;

export type BackupRecord = {
  id: string;
  taken_at: string;
  taken_by_name: string | null;
  kind: "snapshot" | "excel";
  entry_count: number;
};

export async function exportSnapshot(companyId: string): Promise<Snapshot> {
  const { data, error } = await supabase.rpc("export_company_snapshot", { p_company: companyId });
  if (error) throw error;
  return data as Snapshot;
}

export async function recordBackup(
  companyId: string,
  kind: "snapshot" | "excel",
  entryCount: number,
  chainHead: string | null,
): Promise<void> {
  const { error } = await supabase.rpc("record_backup", {
    p_company: companyId,
    p_kind: kind,
    p_entry_count: entryCount,
    p_chain_head: chainHead,
  });
  if (error) throw error;
}

export async function listBackups(companyId: string): Promise<BackupRecord[]> {
  const { data, error } = await supabase
    .from("backup_log")
    .select("id, taken_at, taken_by_name, kind, entry_count")
    .eq("company_id", companyId)
    .order("taken_at", { ascending: false })
    .limit(10);
  if (error) throw error;
  return (data ?? []) as BackupRecord[];
}

export type BackupCheck = { book_name: string; matches: boolean; detail: string };

export async function checkBackup(
  companyId: string,
  integrity: BookIntegrity[],
): Promise<BackupCheck[]> {
  const { data, error } = await supabase.rpc("check_backup", {
    p_company: companyId,
    p_integrity: integrity,
  });
  if (error) throw error;
  return (data ?? []) as BackupCheck[];
}

/* =========================================================== master data ===
   Creating, renaming and retiring the things entries point AT — accounts,
   parties, investors, capital projects.

   RLS has always allowed this through the `edit_coa` right. Until now nothing
   in the app called it, so the capability existed and could not be reached.
   Every function here is the server-side one; none of these tables is written
   to directly, so the guards (a system account cannot be edited, an account
   holding a balance cannot be switched off) cannot be walked around.
   ========================================================================= */

export type NewAccount = {
  company_id: string;
  code: string;
  name: string;
  account_type: Account["account_type"];
  sub_group: string;
  account_group?: string;
  normal_balance?: "D" | "C";
  capex_role?: string | null;
  is_bank_or_cash?: boolean;
  restricted_to_book_id?: string | null;
};

export async function createAccount(a: NewAccount): Promise<string> {
  const { data, error } = await supabase.rpc("create_account", { p_payload: a });
  if (error) throw error;
  return data as string;
}

/** Rename, re-tag or retire. Code, type and grouping are deliberately fixed. */
export async function updateAccount(
  accountId: string,
  patch: { name?: string; capex_role?: string | null; is_active?: boolean },
): Promise<void> {
  const { error } = await supabase.rpc("update_account", {
    p_account: accountId,
    p_payload: patch,
  });
  if (error) throw error;
}

export type PartyDetail = {
  id: string;
  name: string;
  party_type: string | null;
  gstin: string | null;
  pan: string | null;
  phone: string | null;
  email: string | null;
  notes: string | null;
  is_related_party: boolean;
  is_active: boolean;
};

export async function listPartyDetails(companyId: string): Promise<PartyDetail[]> {
  const { data, error } = await supabase
    .from("parties")
    .select("id,name,party_type,gstin,pan,phone,email,notes,is_related_party,is_active")
    .eq("company_id", companyId)
    .order("name");
  if (error) throw error;
  return (data ?? []) as PartyDetail[];
}

export async function updateParty(
  partyId: string,
  patch: Partial<Omit<PartyDetail, "id">>,
): Promise<void> {
  const { error } = await supabase.rpc("update_party", {
    p_party: partyId,
    p_payload: patch,
  });
  if (error) throw error;
}

/**
 * Fold one name into another. Every entry and line tagged to the loser is
 * re-pointed at the keeper, then the loser is removed.
 *
 * Safe against the audit trail: the tamper-evident hash covers the account and
 * the amounts on each line, not who the line is about, so re-tagging changes no
 * hash. Verified by test, not by assumption.
 */
export async function mergeParties(
  companyId: string,
  keepId: string,
  mergeId: string,
  reason?: string,
): Promise<{ lines_moved: number; entries_moved: number }> {
  const { data, error } = await supabase.rpc("merge_parties", {
    p_company: companyId,
    p_keep: keepId,
    p_merge: mergeId,
    p_reason: reason ?? null,
  });
  if (error) throw error;
  return data as { lines_moved: number; entries_moved: number };
}

export type DuplicateParty = {
  id: string;
  name: string;
  party_type: string | null;
  entry_count: number;
};

/** Names that look like the one being typed, ignoring case and punctuation. */
export async function possibleDuplicateParties(
  companyId: string,
  name: string,
): Promise<DuplicateParty[]> {
  const { data, error } = await supabase.rpc("possible_duplicate_parties", {
    p_company: companyId,
    p_name: name,
  });
  if (error) throw error;
  return (data ?? []) as DuplicateParty[];
}

/* ------------------------------------------------------- opening balances --
   What an existing business starts with on the day it moves in. Posted as a
   real dated entry, not typed into a field — so it has a voucher number, sits
   in the ledger, and can only be corrected the way any other entry is.
   -------------------------------------------------------------------------- */

export type OpeningLine = {
  account_id: string;
  debit?: string;
  credit?: string;
  party_id?: string;
  note?: string;
};

export async function setOpeningBalances(payload: {
  company_id: string;
  book_id: string;
  as_on: string;
  narration?: string;
  adjustment_reason?: string;
  lines: OpeningLine[];
}): Promise<string> {
  const { data, error } = await supabase.rpc("set_opening_balances", { p_payload: payload });
  if (error) throw error;
  return data as string;
}

export type OpeningStatus = {
  entry_id: string;
  voucher_no: string;
  entry_date: string;
  line_count: number;
  total: string;
};

export async function openingBalanceStatus(
  companyId: string,
  bookId: string,
): Promise<OpeningStatus | null> {
  const { data, error } = await supabase.rpc("opening_balance_status", {
    p_company: companyId,
    p_book: bookId,
  });
  if (error) throw error;
  return ((data ?? [])[0] ?? null) as OpeningStatus | null;
}

/* ------------------------------------------- investors and capital projects */

export async function updateInvestor(
  investorId: string,
  patch: {
    display_name?: string;
    agreed_share_pct?: string;
    committed_amount?: string;
    is_active?: boolean;
    notes?: string;
  },
): Promise<void> {
  const { error } = await supabase.rpc("update_investor", {
    p_investor: investorId,
    p_payload: patch,
  });
  if (error) throw error;
}

export type ShareCheck = {
  total_pct: string;
  investor_count: number;
  status: "none" | "ok" | "over" | "under";
  message: string;
};

export async function investorShareCheck(companyId: string): Promise<ShareCheck | null> {
  const { data, error } = await supabase.rpc("investor_share_check", { p_company: companyId });
  if (error) throw error;
  return ((data ?? [])[0] ?? null) as ShareCheck | null;
}

export async function updateCapitalProject(
  projectId: string,
  patch: { name?: string; budget_amount?: string; description?: string; target_date?: string },
): Promise<void> {
  const { error } = await supabase.rpc("update_capital_project", {
    p_project: projectId,
    p_payload: patch,
  });
  if (error) throw error;
}

/**
 * The work is finished and in use: move it out of work-in-progress and into a
 * real asset you own. Until this is posted, the balance sheet shows a building
 * site rather than a kitchen — and nothing has started depreciating.
 */
export async function capitalizeProject(payload: {
  capital_project_id: string;
  to_account_id: string;
  event_date?: string;
  amount?: string;
  useful_life_months?: number;
  book_id?: string;
  narration?: string;
  adjustment_reason?: string;
}): Promise<string> {
  const { data, error } = await supabase.rpc("capitalize_project", { p_payload: payload });
  if (error) throw error;
  return data as string;
}

/* --------------------------------------------------- master-data audit log */

export type MasterAuditRow = {
  id: string;
  object_type: "account" | "party" | "investor" | "capital_project" | "opening_balance";
  object_id: string;
  action: string;
  summary: string;
  acted_by_name: string | null;
  acted_at: string;
};

export async function masterAuditLog(companyId: string): Promise<MasterAuditRow[]> {
  const { data, error } = await supabase
    .from("master_audit_log")
    .select("id,object_type,object_id,action,summary,acted_by_name,acted_at")
    .eq("company_id", companyId)
    .order("acted_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data ?? []) as MasterAuditRow[];
}

/* ================================================ company configuration ===
   What kind of business this is, and therefore which parts of the app exist.

   The point of this is that the app is EMPTY of GST until a company registers
   — not that GST fields are hidden or greyed out, but that they are absent.
   A restaurant that is not registered should never see the letters GST, and a
   business that does not sell on credit should not be offered a bills screen.
   ========================================================================= */

export type CompanyConfig = {
  gst_regime: "unregistered" | "regular" | "composition";
  gst_registered_from: string | null;
  composition_rate_bps: number | null;
  itc_blocked_by_scheme: boolean;
  itc_blocked_reason: string | null;
  tds_deductor: boolean;
  tan: string | null;
  gstin: string | null;
  state_code: string | null;
  features: Record<string, boolean>;
};

export type FeatureKey = {
  key: string;
  label: string;
  blurb: string | null;
  default_enabled: boolean;
  sort: number;
};

export async function companyConfig(companyId: string): Promise<CompanyConfig | null> {
  const { data, error } = await supabase.rpc("company_config", { p_company: companyId });
  if (error) throw error;
  return (data ?? null) as CompanyConfig | null;
}

export async function listFeatureKeys(): Promise<FeatureKey[]> {
  const { data, error } = await supabase
    .from("feature_keys")
    .select("key,label,blurb,default_enabled,sort")
    .order("sort");
  if (error) throw error;
  return (data ?? []) as FeatureKey[];
}

/* ----------------------------------------------------------------------------
   Chart of accounts templates, and the report sections an account can sit in.

   Both are global reference data, identical for every company and every user,
   so they are cached hard — they change only when a migration changes them.

   `sub_group` is a KEY, not a label. The recipe engine picks accounts by it
   ("give me the Trade Payables account"), the balance sheet groups on it, and
   the database now refuses any value that is not in this list. That is why the
   account editor offers these rather than whatever strings the company happens
   to have used so far — a section with no account in it yet was previously
   impossible to choose.
---------------------------------------------------------------------------- */

export type ChartTemplate = {
  key: string;
  name: string;
  blurb: string;
  is_base: boolean;
  sort: number;
};

export type SubGroup = {
  key: string;
  account_group: string;
  account_type: Account["account_type"];
  label: string;
  hint: string | null;
  sort: number;
};

export async function listChartTemplates(): Promise<ChartTemplate[]> {
  const { data, error } = await supabase
    .from("chart_templates")
    .select("key,name,blurb,is_base,sort")
    .eq("is_active", true)
    .order("sort");
  if (error) throw error;
  return (data ?? []) as ChartTemplate[];
}

export async function listSubGroups(): Promise<SubGroup[]> {
  const { data, error } = await supabase
    .from("account_sub_groups")
    .select("key,account_group,account_type,label,hint,sort")
    .order("sort");
  if (error) throw error;
  return (data ?? []) as SubGroup[];
}

/** How many accounts a template would seed, and what it calls the main ones. */
export async function templateAccounts(template: string): Promise<
  { code: string; name: string; sub_group: string }[]
> {
  const { data, error } = await supabase
    .from("chart_template_accounts")
    .select("code,name,sub_group,template_key")
    .in("template_key", ["core", template])
    .order("code");
  if (error) throw error;
  // The industry overlay wins where both define a code — the same rule the
  // database applies when it seeds.
  const rows = (data ?? []) as {
    code: string;
    name: string;
    sub_group: string;
    template_key: string;
  }[];
  const byCode = new Map<string, { code: string; name: string; sub_group: string }>();
  for (const r of rows) {
    if (r.template_key !== "core" || !byCode.has(r.code)) {
      byCode.set(r.code, { code: r.code, name: r.name, sub_group: r.sub_group });
    }
  }
  return [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code));
}

/** Adds a template's accounts to an existing company. Never renames one. */
export async function applyChartTemplate(companyId: string, template: string): Promise<number> {
  const { data, error } = await supabase.rpc("apply_chart_template", {
    p_payload: { company_id: companyId, template },
  });
  if (error) throw error;
  return (data ?? 0) as number;
}

/**
 * Which accounts play the GST and TDS roles, and whether input credit can be
 * claimed at all. `itc_claimable` is decided in the database from the company's
 * own registration — a composition dealer and a 5%-scheme restaurant both get
 * false, and for them GST on a purchase is part of its cost.
 */
export async function taxPostingSetup(companyId: string): Promise<TaxSetup | null> {
  const { data, error } = await supabase.rpc("tax_posting_setup", { p_company: companyId });
  if (error) throw error;
  if (!data) return null;
  const d = data as {
    gst_input: string | null;
    gst_output: string | null;
    tds_payable: string | null;
    itc_claimable: boolean | null;
  };
  return {
    gstInputAccountId: d.gst_input,
    gstOutputAccountId: d.gst_output,
    tdsPayableAccountId: d.tds_payable,
    itcClaimable: !!d.itc_claimable,
  };
}

export async function setCompanyConfig(payload: {
  company_id: string;
  gst_regime?: string;
  gst_registered_from?: string;
  composition_rate_bps?: number;
  itc_blocked_by_scheme?: boolean;
  itc_blocked_reason?: string;
  tds_deductor?: boolean;
  tan?: string;
  features?: Record<string, boolean>;
}): Promise<void> {
  const { error } = await supabase.rpc("set_company_config", { p_payload: payload });
  if (error) throw error;
}
