/**
 * Money handling.
 *
 * Rule: amounts cross the wire as STRINGS and are compared/summed as integer
 * paise. A JS `number` is float64 — 0.1 + 0.2 !== 0.3 — so it is used only for
 * display, never to decide whether an entry balances. Postgres stores
 * numeric(18,2), which is exact; this module is what stops that exactness being
 * thrown away the moment a value reaches the browser.
 */

/** Parse a rupee amount (string or number) into integer paise. Throws on junk. */
export function toPaise(amount: string | number): number {
  const s = typeof amount === "number" ? amount.toString() : amount.trim();
  if (s === "") return 0;
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) {
    throw new Error(`invalid amount "${amount}" — use at most 2 decimal places`);
  }
  const neg = s.startsWith("-");
  const [whole, frac = ""] = (neg ? s.slice(1) : s).split(".");
  const paise = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return neg ? -paise : paise;
}

/** Integer paise back to the exact decimal string the API expects. */
export function fromPaise(paise: number): string {
  const neg = paise < 0;
  const abs = Math.abs(paise);
  const s = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
  return neg ? `-${s}` : s;
}

/** True when the debit and credit sides agree exactly, to the paisa. */
export function isBalanced(
  lines: { debit?: string | number; credit?: string | number }[],
): boolean {
  let dr = 0;
  let cr = 0;
  for (const l of lines) {
    dr += toPaise(l.debit ?? 0);
    cr += toPaise(l.credit ?? 0);
  }
  return dr === cr && dr > 0;
}

/** Signed difference (debit − credit) in paise. Zero means balanced. */
export function balanceDelta(
  lines: { debit?: string | number; credit?: string | number }[],
): number {
  let d = 0;
  for (const l of lines) d += toPaise(l.debit ?? 0) - toPaise(l.credit ?? 0);
  return d;
}

/** ₹ with Indian digit grouping. e.g. 745000 -> "₹7,45,000.00" */
export function inr(paise: number, opts: { paise?: boolean } = {}): string {
  const showPaise = opts.paise ?? true;
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: showPaise ? 2 : 0,
    maximumFractionDigits: showPaise ? 2 : 0,
  }).format(paise / 100);
}

/** Short lakh form for dashboards. e.g. 745000_00 -> "₹7.45L" */
export function lakh(paise: number, dp = 2): string {
  const l = paise / 100 / 100000;
  const s = Math.abs(l) >= 100 ? l.toFixed(0) : l.toFixed(dp).replace(/\.?0+$/, "");
  return `₹${s}L`;
}
