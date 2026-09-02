import { describe, expect, it } from "vitest";
import { computeActions, type NextActionInput } from "./nextAction";
import type { Account, Company, JournalEntry } from "../../lib/queries";

const company: Company = {
  id: "c1",
  org_id: "o1",
  name: "Test Co",
  legal_name: null,
  legal_form: "partnership",
  pan: null,
  gstin: null,
  cin: null,
  state_code: null,
  base_currency: "INR",
  books_start_date: "2026-06-08",
  lifecycle_phase: "capex",
  industry: "restaurant",
  target_investment: "10000000.00",
  authorised_capital: "1500000.00",
  show_internal_to_investors: false,
};

const base: NextActionInput = {
  company,
  accounts: [],
  entries: [],
  chainBrokenAtSeq: null,
  entriesWithoutProof: 0,
};

const entry = (over: Partial<JournalEntry> = {}): JournalEntry => ({
  id: "e" + Math.random(),
  voucher_no: "RE-001",
  voucher_type: "receipt",
  entry_date: "2026-06-08",
  narration: "x",
  status: "posted",
  book_id: "b1",
  proof_url: null,
  payment_mode: null,
  created_by_name: null,
  posted_by_name: null,
  reversed_by_entry_id: null,
  reverses_entry_id: null,
  ...over,
});

describe("the app always names a next step", () => {
  it("never returns an empty list", () => {
    expect(computeActions(base).length).toBeGreaterThan(0);
    expect(computeActions({ ...base, entries: [entry()] }).length).toBeGreaterThan(0);
  });

  it("tells a brand-new user to create a company first", () => {
    const a = computeActions({ ...base, company: null });
    expect(a[0].id).toBe("create-company");
  });

  it("tells a user with a company but no entries to record the first one", () => {
    expect(computeActions(base)[0].id).toBe("first-entry");
  });
});

describe("urgency ordering", () => {
  it("puts a broken audit trail above everything else", () => {
    const a = computeActions({
      ...base,
      chainBrokenAtSeq: 7,
      entries: [entry({ status: "draft" })],
      entriesWithoutProof: 3,
    });
    expect(a[0].id).toBe("chain-broken");
    expect(a[0].tone).toBe("danger");
  });

  it("surfaces drafts, because a draft affects no report", () => {
    const a = computeActions({ ...base, entries: [entry({ status: "draft" })] });
    expect(a.some((x) => x.id === "drafts")).toBe(true);
  });

  it("does not nag about missing proof when nothing is posted yet", () => {
    const a = computeActions({ ...base, entriesWithoutProof: 5 });
    expect(a.some((x) => x.id === "proof")).toBe(false);
  });

  it("does nag about missing proof once entries are posted", () => {
    const a = computeActions({
      ...base,
      entries: [entry()],
      entriesWithoutProof: 5,
    });
    expect(a.some((x) => x.id === "proof")).toBe(true);
  });
});

describe("the CapEx wedge", () => {
  const cwip: Account = {
    id: "a1",
    code: "1510",
    name: "CWIP",
    account_type: "asset",
    account_group: null,
    sub_group: "Capital Work in Progress",
    normal_balance: "D",
    is_group: false,
    is_bank_or_cash: false,
    is_active: true,
    is_system: false,
    capex_role: "cwip",
    restricted_to_book_id: null,
  };

  it("prompts a capex-phase company to review construction spend once it has history", () => {
    const a = computeActions({
      ...base,
      accounts: [cwip],
      entries: Array.from({ length: 5 }, () => entry()),
    });
    expect(a.some((x) => x.id === "capex-review")).toBe(true);
  });

  it("stays quiet for an operations-phase company", () => {
    const a = computeActions({
      ...base,
      company: { ...company, lifecycle_phase: "operations" },
      accounts: [cwip],
      entries: Array.from({ length: 5 }, () => entry()),
    });
    expect(a.some((x) => x.id === "capex-review")).toBe(false);
  });
});

describe("the all-clear state", () => {
  it("is reassuring rather than empty when there is nothing to fix", () => {
    const a = computeActions({ ...base, entries: [entry()] });
    expect(a[0].id).toBe("all-clear");
    expect(a[0].tone).toBe("ok");
  });
});
