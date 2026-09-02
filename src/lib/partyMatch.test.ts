import { describe, expect, it } from "vitest";
import { normalizeName, resolveParty } from "./partyMatch";
import type { DuplicateParty } from "./queries";

const p = (name: string, entry_count = 0): DuplicateParty => ({
  id: `id-${name}`,
  name,
  party_type: "vendor",
  entry_count,
});

describe("normalising a party name", () => {
  it("ignores case, spaces and punctuation", () => {
    expect(normalizeName("Sushant Civil Contractor")).toBe("sushantcivilcontractor");
    expect(normalizeName("SUSHANT  civil-contractor.")).toBe("sushantcivilcontractor");
  });
});

describe("reusing an existing party rather than creating a duplicate", () => {
  it("reuses on an exact match, ignoring case and spacing", () => {
    const r = resolveParty("sushant civil contractor", [p("Sushant Civil Contractor", 12)]);
    expect(r.kind).toBe("existing");
    if (r.kind === "existing") expect(r.party.entry_count).toBe(12);
  });

  it("prefers the exact match even when other candidates came back", () => {
    const r = resolveParty("sushant", [p("Sushant Civil Contractor"), p("Sushant")]);
    expect(r.kind).toBe("existing");
    if (r.kind === "existing") expect(r.party.name).toBe("Sushant");
  });

  it("reuses the single candidate when only one looks like it", () => {
    const r = resolveParty("sushant", [p("Sushant Civil Contractor", 5)]);
    expect(r.kind).toBe("existing");
    if (r.kind === "existing") expect(r.party.name).toBe("Sushant Civil Contractor");
  });

  it("ASKS rather than guessing when several could match", () => {
    // Silently picking one here is how half of someone's ledger goes missing.
    const r = resolveParty("sushant", [p("Sushant Civil"), p("Sushant Electricals")]);
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") expect(r.options).toHaveLength(2);
  });

  it("says plainly when a genuinely new party will be created", () => {
    const r = resolveParty("brand new supplier", []);
    expect(r.kind).toBe("new");
  });

  it("treats an empty name as nothing to resolve", () => {
    expect(resolveParty("", [p("Sushant")]).kind).toBe("none");
    expect(resolveParty("   ", [p("Sushant")]).kind).toBe("none");
  });
});
