import { supabase } from "./supabase";

/* ============================================================================
   The PIN.

   It lives on the SERVER, as a bcrypt hash against your user. Three reasons:

     1. A PIN checked in the browser protects nothing. The API call it is meant
        to guard can be made directly, so "PIN required to delete an entry"
        would have been decoration. Now the same function that voids the entry
        checks the PIN, in the database, where it cannot be walked around.
     2. It follows you. The old version lived in localStorage, which is per
        browser and per URL — set it on the laptop and the phone stayed open,
        clear the cache and it was gone.
     3. Wrong tries can be counted. Five failures lock it for fifteen minutes;
        a four-digit secret is only meaningful with that in place.

   The UNLOCK, by contrast, is held in memory only — never in localStorage or
   sessionStorage, both of which survive things a lock must not survive
   (closing the browser; clicking a history link into the same tab, which
   Chrome restores). A module variable dies with the page, so every load,
   refresh and bookmark asks again, while moving between screens inside the app
   does not, because that never reloads the page.

   The unlock is also bound to WHOSE unlock it is.

   It used to be a bare timestamp. On a shared laptop that meant: user A signs
   out, user B signs in within fifteen minutes, and B walks straight past the
   lock screen on A's unlock — because signing out did not reload the page, so
   the module variable survived. Recording the user id alongside the deadline
   makes the bypass impossible to reach rather than merely remembering to clear
   it in every sign-out path.
   ========================================================================= */

export const LOCK_AFTER_MINUTES = 15;

let unlockedUntil = 0;
let unlockedFor: string | null = null;

/** localStorage key remembering that a given user HAS a PIN. See `knownToHavePin`. */
const hasPinKey = (userId: string) => `books.pin.has.${userId}`;

export async function pinIsSet(): Promise<boolean> {
  const { data, error } = await supabase.rpc("has_user_pin");
  if (error) throw error;
  return data === true;
}

export async function setPin(pin: string, userId: string, current?: string): Promise<void> {
  if (!/^\d{4,8}$/.test(pin)) throw new Error("The PIN must be 4 to 8 digits.");
  const { error } = await supabase.rpc("set_user_pin", {
    p_pin: pin,
    p_current: current ?? null,
  });
  if (error) throw error;
  rememberHasPin(userId, true);
  markUnlocked(userId);
}

export async function clearPin(currentPin: string, userId: string): Promise<void> {
  const { error } = await supabase.rpc("clear_user_pin", { p_current: currentPin });
  if (error) throw error;
  rememberHasPin(userId, false);
  lockNow();
}

/**
 * The way out of a forgotten PIN.
 *
 * The lock screen has always offered "sign out and use your email and password
 * instead", and until now that did nothing — `clearPin` needs the PIN you have
 * forgotten, so the loop had no exit. The server allows this only within five
 * minutes of a real password sign-in (see the migration for why the token's own
 * timestamps are the wrong thing to trust).
 *
 * Returns false — rather than throwing — when the sign-in is too old, so the
 * screen can say what to do next instead of showing an error.
 */
export async function clearPinAfterPassword(userId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("clear_user_pin_after_password");
  if (error) throw error;
  if (data !== true) return false;
  rememberHasPin(userId, false);
  markUnlocked(userId);
  return true;
}

/** Throttled server check. Throws with the wait time once it locks out. */
export async function verifyPin(pin: string, userId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("unlock_with_pin", { p_pin: pin });
  if (error) throw error;
  if (data === true) {
    rememberHasPin(userId, true);
    markUnlocked(userId);
  }
  return data === true;
}

export function markUnlocked(userId: string): void {
  unlockedUntil = Date.now() + LOCK_AFTER_MINUTES * 60_000;
  unlockedFor = userId;
}

export function lockNow(): void {
  unlockedUntil = 0;
  unlockedFor = null;
  // Remove the markers earlier builds wrote, so a stale one cannot let anyone in.
  try {
    sessionStorage.removeItem("books.pin.unlocked_until");
    localStorage.removeItem("books.pin.unlocked_until");
    localStorage.removeItem("books.pin.v1");
  } catch {
    /* storage unavailable — the in-memory value is what decides */
  }
}

/** Is the lock open, and open for THIS user? Both have to be true. */
export function isUnlocked(userId: string): boolean {
  return unlockedFor === userId && Date.now() < unlockedUntil;
}

/* ----------------------------------------------------------------------------
   Failing closed.

   `has_user_pin` is one named request. Block it in DevTools — or lose signal at
   the wrong moment — and the gate used to render the whole app, because the
   catch treated "cannot tell" as "no PIN". A lock you can switch off by
   blocking a request is not a lock.

   So the answer is remembered per user, the first time the server gives it. If
   the check later fails and we KNOW this user has a PIN, the gate stays shut.

   This is the only PIN-related thing written to localStorage, and it is
   deliberately a fact that helps nobody: "this user has a PIN". It carries no
   secret and cannot unlock anything — setting it by hand only locks you out
   harder, and clearing it does not open the gate, because with no remembered
   answer a failed check shows an explicit "cannot reach the server" screen
   rather than the app.
---------------------------------------------------------------------------- */
export function rememberHasPin(userId: string, has: boolean): void {
  try {
    if (has) localStorage.setItem(hasPinKey(userId), "1");
    else localStorage.removeItem(hasPinKey(userId));
  } catch {
    /* private mode — we simply have no memory to fall back on */
  }
}

export function knownToHavePin(userId: string): boolean {
  try {
    return localStorage.getItem(hasPinKey(userId)) === "1";
  } catch {
    return false;
  }
}
