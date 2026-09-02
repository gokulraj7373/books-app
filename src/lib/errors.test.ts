import { describe, expect, it } from "vitest";
import { errorMessage } from "./errors";

describe("errors a user can actually act on", () => {
  it("never renders the literal [object Object]", () => {
    // this is exactly what reached the screen: a Supabase error is a plain
    // object, so String(err) produced "[object Object]"
    const supabaseError = {
      code: "P0001",
      message: '"Cash in Hand" is an official bank or cash account',
      details: null,
      hint: null,
    };
    const out = errorMessage(supabaseError);
    expect(out).not.toContain("[object Object]");
    expect(out).toContain("Cash in Hand");
  });

  it("joins message, details and hint when all are present", () => {
    const out = errorMessage({ message: "Failed.", details: "Row 3.", hint: "Check the date." });
    expect(out).toBe("Failed. Row 3. Check the date.");
  });

  it("does not repeat an identical message and detail", () => {
    expect(errorMessage({ message: "Same", details: "Same" })).toBe("Same");
  });

  it("strips Postgres noise so it reads as English", () => {
    expect(errorMessage({ message: "P0001: the two sides do not match" })).toBe(
      "the two sides do not match",
    );
  });

  it("handles real Errors, strings, null and junk", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage(null)).toMatch(/went wrong/i);
    expect(errorMessage({})).toMatch(/went wrong/i);
  });

  it("survives a circular object rather than throwing while reporting an error", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => errorMessage(a)).not.toThrow();
  });
});
