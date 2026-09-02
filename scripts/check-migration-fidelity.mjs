// ============================================================================
// Is every migration file in the repo byte-identical to the SQL that actually
// built the live database?
//
// The repo drifted badly: files were hand-numbered while the database recorded
// its own timestamped versions, and 35 applied migrations had no file at all.
// This script is the check that the two are back in step — and it compares
// CONTENT, not filenames, because a file that merely looks right is exactly the
// failure this is meant to catch.
//
// Expected checksums live in migration-checksums.json, taken from
// supabase_migrations.schema_migrations.
//
// Two normalisations, and only two. Both are about how the bytes travelled, not
// about what the SQL says, so neither can hide a real difference:
//   - CRLF -> LF, because git checks these files out with CRLF on Windows.
//   - the trailing newline is optional. Migrations backfilled FROM the database
//     were written out with one added; migrations applied since then went in
//     with the file's own trailing newline and the database kept it. Either
//     form is accepted; a single differing character anywhere else still fails.
//
// Usage:  node scripts/check-migration-fidelity.mjs
// ============================================================================

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const DIR = new URL("../supabase/migrations/", import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  "$1",
);
const MANIFEST = new URL("./migration-checksums.json", import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  "$1",
);

if (!existsSync(MANIFEST)) {
  console.error(`::error::No manifest at ${MANIFEST}.`);
  process.exit(1);
}

const expected = JSON.parse(readFileSync(MANIFEST, "utf8"));
const md5 = (s) => createHash("md5").update(s, "utf8").digest("hex");
const onDisk = readdirSync(DIR).filter((f) => f.endsWith(".sql"));

let missing = 0;
let wrong = 0;
const matched = new Set();

for (const m of expected) {
  // ONLY the canonical Supabase filename. An earlier version of this script
  // also accepted the repo's old hand-numbered form, which let one file sit
  // there un-versioned and still "pass" — and a file the CLI cannot pair with
  // its applied version is not a file that can rebuild anything.
  const found = onDisk.includes(`${m.version}_${m.name}.sql`)
    ? `${m.version}_${m.name}.sql`
    : undefined;
  if (!found) {
    console.error(`MISSING  ${m.version}_${m.name}.sql`);
    missing++;
    continue;
  }
  matched.add(found);
  const raw = readFileSync(join(DIR, found), "utf8").replace(/\r\n/g, "\n");
  const bare = raw.replace(/\n+$/, "");
  if (md5(raw) !== m.md5 && md5(bare) !== m.md5) {
    console.error(`DIFFERS  ${found}  (file ${md5(bare)} vs applied ${m.md5})`);
    wrong++;
  }
}

const extra = onDisk.filter((f) => !matched.has(f));
for (const f of extra) console.error(`EXTRA    ${f} — not in the applied history`);

const ok = expected.length - missing - wrong;
console.log("");
console.log(`applied migrations : ${expected.length}`);
console.log(`byte-identical     : ${ok}`);
console.log(`missing from repo  : ${missing}`);
console.log(`content differs    : ${wrong}`);
console.log(`extra files        : ${extra.length}`);

if (missing || wrong || extra.length) {
  console.error("");
  console.error("::error::The repo cannot faithfully rebuild the database.");
  process.exit(1);
}
console.log("\nThe repo rebuilds the deployed schema exactly.");
