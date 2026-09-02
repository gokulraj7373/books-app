import { describe, expect, it } from "vitest";
import { parseAmount, parseCsv, parseDate, pick, toObjects } from "./csv";

describe("parsing real spreadsheet output", () => {
  it("handles quoted commas, escaped quotes, CRLF and a BOM", () => {
    const csv = '﻿Date,Narration,Amount\r\n2026-07-28,"Paid ""Anbu"", in full",1000\r\n';
    const rows = parseCsv(csv);
    expect(rows[0]).toEqual(["Date", "Narration", "Amount"]);
    expect(rows[1]).toEqual(["2026-07-28", 'Paid "Anbu", in full', "1000"]);
  });

  it("ignores blank trailing lines that exports always leave behind", () => {
    expect(parseCsv("a,b\n1,2\n\n\n").length).toBe(2);
  });

  it("keeps empty cells rather than shifting columns", () => {
    expect(parseCsv("a,b,c\n1,,3")[1]).toEqual(["1", "", "3"]);
  });
});

describe("an uploaded file is untrusted input", () => {
  it("cannot poison Object.prototype through a __proto__ column", () => {
    const rows = parseCsv("__proto__,name\npolluted,x");
    const objs = toObjects(rows);
    expect(objs[0].name).toBe("x");
    // the payload lands as an ordinary key on a null-prototype object
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(objs[0])).toBe(null);
  });
});

describe("finding columns whatever they were called", () => {
  const row = { "Txn Date": "28-07-2026", "Debit Amt": "1,000.00", Particulars: "Rent" };
  it("matches loosely on spacing and case", () => {
    expect(pick(row, "date")).toBe("28-07-2026");
    expect(pick(row, "debit")).toBe("1,000.00");
  });
  it("falls back through alternative names", () => {
    expect(pick(row, "narration", "particulars")).toBe("Rent");
  });
  it("returns empty rather than guessing when nothing matches", () => {
    expect(pick(row, "gstin")).toBe("");
  });
});

describe("dates as Indian exports write them", () => {
  it("reads the common formats", () => {
    expect(parseDate("2026-07-28")).toBe("2026-07-28");
    expect(parseDate("28-07-2026")).toBe("2026-07-28");
    expect(parseDate("28/07/2026")).toBe("2026-07-28");
    expect(parseDate("28-Jul-2026")).toBe("2026-07-28");
    expect(parseDate("28-July-26")).toBe("2026-07-28");
  });

  it("assumes day-first, which is the Indian convention", () => {
    // 07-08-2026 is 7 August, not 8 July
    expect(parseDate("07-08-2026")).toBe("2026-08-07");
  });

  it("refuses to guess when the value cannot be day-first", () => {
    // 2026-13-01 style: month 13 is impossible, so do not silently swap
    expect(parseDate("28-13-2026")).toBe(null);
    expect(parseDate("not a date")).toBe(null);
    expect(parseDate("")).toBe(null);
  });
});

describe("amounts as exports write them", () => {
  it("strips Indian digit grouping and currency symbols", () => {
    expect(parseAmount("1,25,000.00")).toBe("125000.00");
    expect(parseAmount("₹ 1000")).toBe("1000.00");
    expect(parseAmount("1000")).toBe("1000.00");
  });

  it("treats brackets and a Cr suffix as negative", () => {
    expect(parseAmount("(500)")).toBe("-500.00");
    expect(parseAmount("500 Cr")).toBe("-500.00");
    expect(parseAmount("-500")).toBe("-500.00");
  });

  it("keeps exactly two decimals", () => {
    expect(parseAmount("1000.5")).toBe("1000.50");
    expect(parseAmount("1000.456")).toBe("1000.45");
  });

  it("rejects junk instead of importing a wrong number", () => {
    expect(parseAmount("abc")).toBe(null);
    expect(parseAmount("")).toBe(null);
    expect(parseAmount("1.2.3")).toBe(null);
  });
});
