// The service-role key bypasses EVERY RLS policy in the database. If it ever
// reaches a browser bundle, every tenant's books are readable by anyone who
// opens devtools. This refuses to let that ship.
//
// Extracted from the inline step in .github/workflows/ci.yml so that the local
// `npm run ship` gate and CI run the SAME implementation. Two copies of a
// safety check drift, and the copy that drifts is the one that stops catching
// things.

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, extname } from "node:path";

const ROOTS = ["src", "dist"];
const NEEDLES = ["service_role", "SUPABASE_SERVICE"];
// Binary-ish assets can contain these byte sequences by coincidence and cannot
// leak a key in a way a reader would use. Everything textual is scanned.
const SKIP_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".ico", ".woff", ".woff2", ".ttf"]);

let scanned = 0;
const hits = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === "node_modules") continue;
      walk(p);
      continue;
    }
    if (SKIP_EXT.has(extname(name).toLowerCase())) continue;
    scanned++;
    const text = readFileSync(p, "utf8");
    for (const needle of NEEDLES) {
      if (text.includes(needle)) hits.push(`${p}  (contains "${needle}")`);
    }
  }
}

for (const root of ROOTS) {
  if (existsSync(root)) walk(root);
}

// A scan that examined nothing would report "clean" forever. Fail loudly
// instead — the same reason the migration-fidelity script asserts it found
// files, and the reason an empty grep is not a pass.
if (scanned === 0) {
  console.error(
    "FAIL: scanned 0 files. Expected src/ (and dist/ after a build) to exist.\n" +
      "A check that examines nothing cannot fail, which makes a green result meaningless.",
  );
  process.exit(1);
}

if (hits.length > 0) {
  console.error("FAIL: a service-role reference was found in source or build output.");
  console.error("That key bypasses every RLS policy and must never reach a browser.\n");
  for (const h of hits) console.error("  " + h);
  process.exit(1);
}

console.log(`No service-role reference in ${ROOTS.filter((r) => existsSync(r)).join(" or ")}. ${scanned} files scanned.`);
