import { describe, expect, it } from "vitest";
import { findAmount, findDate, findParty, parseEntry } from "./parseEntry";
import { RECIPES } from "./recipes";

/** A fixed "today" so these tests never depend on when they run. */
const TODAY = new Date(2026, 7, 16); // 16 Aug 2026

describe("amounts, written the way people actually write them", () => {
  const cases: Array<[string, number]> = [
    ["25000", 2_500_000],
    ["25,000", 2_500_000],
    ["1,25,000", 12_500_000], // Indian grouping
    ["₹25000", 2_500_000],
    ["rs 25000", 2_500_000],
    ["rs.25000", 2_500_000],
    ["25k", 2_500_000],
    ["1.5 lakh", 15_000_000],
    ["1.5 lac", 15_000_000],
    ["2 crore", 2_000_000_000],
    ["2cr", 2_000_000_000],
    ["1234.50", 123_450],
  ];
  for (const [text, paise] of cases) {
    it(`reads "${text}" as ${paise} paise`, () => {
      expect(findAmount(text)?.paise).toBe(paise);
    });
  }

  it("finds no amount in a sentence with no number", () => {
    expect(findAmount("paid the contractor")).toBeNull();
  });

  it("rejects zero", () => {
    expect(findAmount("paid 0")).toBeNull();
  });
});

describe("dates are read the Indian way", () => {
  it("reads today", () => {
    expect(findDate("paid today", TODAY)?.date).toBe("2026-08-16");
  });

  it("reads yesterday", () => {
    expect(findDate("paid yesterday", TODAY)?.date).toBe("2026-08-15");
  });

  it("reads day before yesterday", () => {
    expect(findDate("paid day before yesterday", TODAY)?.date).toBe("2026-08-14");
  });

  it("reads '12 aug'", () => {
    expect(findDate("paid 12 aug", TODAY)?.date).toBe("2026-08-12");
  });

  it("reads 'aug 12'", () => {
    expect(findDate("paid aug 12", TODAY)?.date).toBe("2026-08-12");
  });

  it("reads 12/08 as DAY/MONTH, never month/day", () => {
    // The American reading would book this in December. It must not.
    expect(findDate("paid 12/08", TODAY)?.date).toBe("2026-08-12");
  });

  it("reads a two-digit year", () => {
    expect(findDate("paid 12/08/25", TODAY)?.date).toBe("2025-08-12");
  });

  it("finds no date when none is written", () => {
    expect(findDate("paid sushant for cement", TODAY)).toBeNull();
  });
});

describe("the party", () => {
  it("takes the name after 'to'", () => {
    expect(findParty(["paid", "to", "sushant"])?.name).toBe("sushant");
  });

  it("takes a multi-word name", () => {
    expect(findParty(["to", "sushant", "civil", "contractor"])?.name).toBe(
      "sushant civil contractor",
    );
  });

  it("stops at a clause break", () => {
    expect(findParty(["to", "sushant", "for", "cement"])?.name).toBe("sushant");
  });

  it("never swallows a number into a name", () => {
    expect(findParty(["to", "sushant", "25000"])?.name).toBe("sushant");
  });

  it("returns null when no lead word is present", () => {
    expect(findParty(["bought", "cement"])).toBeNull();
  });
});

describe("the whole sentence", () => {
  it("parses the owner's own example", () => {
    const r = parseEntry("paid 25000 to sushant for cement", RECIPES, TODAY);
    expect(r.amountPaise).toBe(2_500_000);
    expect(r.partyName).toBe("sushant");
    expect(r.date).toBe("2026-08-16"); // defaulted
    expect(r.dateWasTyped).toBe(false);
    expect(r.recipe).not.toBeNull();
  });

  it("keeps the amount out of the party name", () => {
    const r = parseEntry("paid 25000 to sushant", RECIPES, TODAY);
    expect(r.partyName).toBe("sushant");
    expect(r.amountPaise).toBe(2_500_000);
  });

  it("keeps the date out of the party name", () => {
    const r = parseEntry("paid 5000 to ramesh 12 aug", RECIPES, TODAY);
    expect(r.partyName).toBe("ramesh");
    expect(r.date).toBe("2026-08-12");
    expect(r.dateWasTyped).toBe(true);
  });

  it("routes building work to the construction recipe", () => {
    const r = parseEntry("paid 50000 for plumbing work", RECIPES, TODAY);
    expect(r.recipe?.id).toBe("construction_spend");
  });

  it("routes equipment to the asset recipe", () => {
    const r = parseEntry("bought a fridge for 45000", RECIPES, TODAY);
    expect(r.recipe?.id).toBe("buy_asset");
  });

  it("routes an investor receipt to the capital recipe", () => {
    const r = parseEntry("investor put in 500000", RECIPES, TODAY);
    expect(r.recipe?.id).toBe("investor_in");
  });

  it("warns instead of guessing when the direction is ambiguous", () => {
    const r = parseEntry("loan 100000", RECIPES, TODAY);
    expect(r.ambiguity).toBeTruthy();
  });

  it("warns on a bare 'advance', which could be either direction", () => {
    const r = parseEntry("advance 10000", RECIPES, TODAY);
    expect(r.ambiguity).toBeTruthy();
  });

  it("returns no recipe rather than a wrong one for gibberish", () => {
    const r = parseEntry("qwerty zxcvb", RECIPES, TODAY);
    expect(r.recipe).toBeNull();
    expect(r.confidence).toBe(0);
  });

  it("never invents an amount", () => {
    const r = parseEntry("paid sushant for cement", RECIPES, TODAY);
    expect(r.amountPaise).toBeNull();
  });

  it("offers alternatives so the user can correct a wrong guess", () => {
    const r = parseEntry("paid 1000 for rent", RECIPES, TODAY);
    expect(r.recipe).not.toBeNull();
    expect(Array.isArray(r.alternatives)).toBe(true);
  });
});
