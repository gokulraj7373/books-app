import { beforeEach, describe, expect, it, vi } from "vitest";

// The module talks to Supabase for the server-side half of the PIN. None of
// that is under test here — what is under test is who the in-memory unlock
// belongs to, which is pure logic and is where the bypass lived.
vi.mock("./supabase", () => ({ supabase: { rpc: vi.fn() } }));

// The suite runs in the node environment, which has no Web Storage. A ten-line
// stub is cheaper than pulling in jsdom for two `getItem` calls, and it keeps
// the test honest about the only two methods the module actually uses.
function storageStub(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
  };
}
vi.stubGlobal("localStorage", storageStub());
vi.stubGlobal("sessionStorage", storageStub());

const { isUnlocked, knownToHavePin, lockNow, markUnlocked, rememberHasPin } = await import(
  "./pinLock"
);

const ALICE = "11111111-1111-1111-1111-111111111111";
const BOB = "22222222-2222-2222-2222-222222222222";

describe("the unlock belongs to one user, not to the browser", () => {
  beforeEach(() => {
    lockNow();
    localStorage.clear();
  });

  it("opens for the user who entered the PIN", () => {
    markUnlocked(ALICE);
    expect(isUnlocked(ALICE)).toBe(true);
  });

  /* --------------------------------------------------------------------------
     THE BUG THIS EXISTS FOR.

     The unlock used to be a bare deadline with no owner. On a shared laptop:
     Alice unlocks, signs out, Bob signs in within fifteen minutes — and Bob
     walked straight past the lock screen on Alice's unlock, because signing out
     does not reload the page and the module variable survived it.

     Clearing the flag on sign-out fixes the path someone thought of. Recording
     WHOSE unlock it is fixes the ones nobody thought of.
  -------------------------------------------------------------------------- */
  it("never opens for anyone else, even inside the time window", () => {
    markUnlocked(ALICE);
    expect(isUnlocked(BOB)).toBe(false);
  });

  it("signing in as someone else replaces the unlock rather than adding to it", () => {
    markUnlocked(ALICE);
    markUnlocked(BOB);
    expect(isUnlocked(BOB)).toBe(true);
    expect(isUnlocked(ALICE)).toBe(false);
  });

  it("locking clears it for everybody", () => {
    markUnlocked(ALICE);
    lockNow();
    expect(isUnlocked(ALICE)).toBe(false);
    expect(isUnlocked(BOB)).toBe(false);
  });

  it("expires on time", () => {
    vi.useFakeTimers();
    try {
      markUnlocked(ALICE);
      vi.advanceTimersByTime(14 * 60_000);
      expect(isUnlocked(ALICE)).toBe(true);
      vi.advanceTimersByTime(2 * 60_000);
      expect(isUnlocked(ALICE)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an empty user id is not a skeleton key", () => {
    markUnlocked(ALICE);
    expect(isUnlocked("")).toBe(false);
  });
});

describe("remembering that a user has a PIN, so the gate can fail closed", () => {
  beforeEach(() => {
    lockNow();
    localStorage.clear();
  });

  it("knows nothing until told", () => {
    expect(knownToHavePin(ALICE)).toBe(false);
  });

  it("remembers per user, not per browser", () => {
    rememberHasPin(ALICE, true);
    expect(knownToHavePin(ALICE)).toBe(true);
    // Bob has never set one, and Alice's answer must not be given for him
    expect(knownToHavePin(BOB)).toBe(false);
  });

  it("forgets when the PIN is removed", () => {
    rememberHasPin(ALICE, true);
    rememberHasPin(ALICE, false);
    expect(knownToHavePin(ALICE)).toBe(false);
  });

  it("survives a reload, which is the whole point", () => {
    rememberHasPin(ALICE, true);
    // localStorage is what a page load reads back; nothing in memory is kept.
    expect(localStorage.getItem(`books.pin.has.${ALICE}`)).toBe("1");
  });
});
