/* ============================================================================
   CSV parsing, hand-written.

   An imported file is UNTRUSTED INPUT. Every CSV library considered pulled
   either unfixed advisories or a large dependency tree, and a parser is exactly
   where a prototype-pollution bug does damage. This is ~50 lines, handles the
   cases that actually occur in exports from Tally, Excel and Google Sheets, and
   builds objects with a null prototype so a column literally named
   "__proto__" cannot poison anything.
   ========================================================================= */

/** RFC 4180 with the tolerances real spreadsheets need: BOM, CRLF, quoted commas. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;

  while (i < src.length) {
    const c = src[i];

    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }

    if (c === '"') {
      quoted = true;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      continue;
    }
    if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += c;
    i++;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // drop trailing blank lines
  return rows.filter((r) => r.some((v) => v.trim() !== ""));
}

/** Rows as objects keyed by header. Null prototype: a "__proto__" column is inert. */
export function toObjects(rows: string[][]): Record<string, string>[] {
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const o = Object.create(null) as Record<string, string>;
    headers.forEach((h, i) => {
      o[h] = (r[i] ?? "").trim();
    });
    return o;
  });
}

/** Finds a column whatever it was called — "Date", "date", "Txn Date", "Dt". */
export function pick(row: Record<string, string>, ...names: string[]): string {
  const keys = Object.keys(row);
  for (const want of names) {
    const hit = keys.find((k) => k.toLowerCase().replace(/[^a-z]/g, "") === want.toLowerCase().replace(/[^a-z]/g, ""));
    if (hit && row[hit] !== "") return row[hit];
  }
  for (const want of names) {
    const hit = keys.find((k) => k.toLowerCase().includes(want.toLowerCase()));
    if (hit && row[hit] !== "") return row[hit];
  }
  return "";
}

/**
 * Dates as they actually appear in Indian exports: 28-07-2026, 28/07/2026,
 * 2026-07-28, 28-Jul-2026. Day-first is assumed for ambiguous numeric dates
 * because that is the Indian convention — and getting it silently wrong would
 * put entries in the wrong month.
 */
export function parseDate(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;

  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const dmy = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (dmy) {
    const d = dmy[1].padStart(2, "0");
    const m = dmy[2].padStart(2, "0");
    let y = dmy[3];
    if (y.length === 2) y = Number(y) > 70 ? `19${y}` : `20${y}`;
    if (Number(m) > 12) return null; // clearly not day-first; refuse rather than guess
    return `${y}-${m}-${d}`;
  }

  const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const named = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3,})[-\s](\d{2,4})$/);
  if (named) {
    const mi = MONTHS.indexOf(named[2].slice(0, 3).toLowerCase());
    if (mi < 0) return null;
    let y = named[3];
    if (y.length === 2) y = `20${y}`;
    return `${y}-${String(mi + 1).padStart(2, "0")}-${named[1].padStart(2, "0")}`;
  }
  return null;
}

/** Amounts as exported: "1,25,000.00", "(500)" for negative, "₹ 1000", "1000 Dr". */
export function parseAmount(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  if (/(^|\s)(cr|credit)$/i.test(s)) neg = true;
  s = s
    .replace(/[₹$€£]/g, "")
    .replace(/(^|\s)(dr|cr|debit|credit)$/i, "")
    .replace(/,/g, "")
    .trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  if (s.startsWith("-")) {
    neg = true;
    s = s.slice(1);
  }
  const [whole, frac = ""] = s.split(".");
  const val = `${whole}.${(frac + "00").slice(0, 2)}`;
  return neg ? `-${val}` : val;
}
