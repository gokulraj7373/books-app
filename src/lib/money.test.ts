import { describe, expect, it } from "vitest";
import { balanceDelta, fromPaise, inr, isBalanced, lakh, toPaise } from "./money";

describe("toPaise", () => {
  it("parses rupees and paise exactly", () => {
    expect(toPaise("70000")).toBe(7_000_000);
    expect(toPaise("0.01")).toBe(1);
    expect(toPaise("1.5")).toBe(150);
    expect(toPaise("1.05")).toBe(105);
    expect(toPaise("-25.75")).toBe(-2575);
    expect(toPaise("")).toBe(0);
  });

  it("rejects more than 2 decimal places rather than silently rounding", () => {
    expect(() => toPaise("1.234")).toThrow();
    expect(() => toPaise("abc")).toThrow();
    expect(() => toPaise("1e5")).toThrow();
  });
});

describe("float64 is not trusted with money", () => {
  it("0.1 + 0.2 balances exactly against 0.3", () => {
    // as raw JS numbers this is false: 0.1 + 0.2 === 0.30000000000000004
    expect(0.1 + 0.2).not.toBe(0.3);
    // through paise it is exact, which is the whole point of this module
    expect(
      isBalanced([
        { debit: "0.10" },
        { debit: "0.20" },
        { credit: "0.30" },
      ]),
    ).toBe(true);
  });

  it("catches an off-by-one-paisa entry that a float compare would miss", () => {
    expect(isBalanced([{ debit: "1000.00" }, { credit: "999.99" }])).toBe(false);
    expect(balanceDelta([{ debit: "1000.00" }, { credit: "999.99" }])).toBe(1);
  });
});

describe("round trip", () => {
  it("survives paise -> string -> paise", () => {
    for (const p of [0, 1, 99, 100, 12345, 7_450_000_00, -2575]) {
      expect(toPaise(fromPaise(p))).toBe(p);
    }
  });
});

describe("isBalanced", () => {
  it("accepts the owner's worked example", () => {
    expect(
      isBalanced([{ debit: "30000" }, { credit: "30000" }]),
    ).toBe(true);
  });

  it("accepts a multi-line entry (the Excel file could not do this)", () => {
    expect(
      isBalanced([
        { debit: "25000" },
        { debit: "100000" },
        { debit: "280000" },
        { credit: "405000" },
      ]),
    ).toBe(true);
  });

  it("rejects an all-zero entry", () => {
    expect(isBalanced([{ debit: "0" }, { credit: "0" }])).toBe(false);
  });
});

describe("formatting", () => {
  it("uses Indian digit grouping", () => {
    expect(inr(7_45_000_00)).toBe("₹7,45,000.00");
    expect(inr(7_45_000_00, { paise: false })).toBe("₹7,45,000");
  });

  it("renders lakhs", () => {
    expect(lakh(7_45_000_00)).toBe("₹7.45L");
  });
});
