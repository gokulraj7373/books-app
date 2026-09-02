// ============================================================================
// Bundle-size budget.
//
// This app is used on a phone, on Indian mobile data, often in a kitchen with
// one bar of signal. Bundle size is a feature, not a vanity metric — so it gets
// a gate in CI rather than a note in a README that nobody reads.
//
// The budget is deliberately set just above the CURRENT size. It is a ratchet:
// it exists to stop the bundle silently doubling, not to give room to grow. If
// a change genuinely needs more, raise the number in the same commit and say
// why in the message — that way the growth is a decision someone made, not
// something that happened.
//
// SheetJS is now a dynamic import inside the export handler, so the metric that
// matters has changed. "Total JavaScript" counts chunks that no longer load at
// startup, which would punish exactly the code-splitting it was meant to
// encourage. What a phone on one bar of signal actually waits for is the ENTRY
// chunk plus anything the HTML preloads — so that is what is gated now, read
// from dist/index.html rather than guessed.
// ============================================================================

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const DIST = join(ROOT, "dist", "assets");

// Ratcheted DOWN 2026-08-12, the first fall since this file was written, when
// SheetJS became a dynamic import. First-load JavaScript went 1,146,830 ->
// 820,843 bytes: every visitor now downloads ~326 KB less (107 KB less over
// the wire, gzipped) before the sign-in screen can render.
//
// Total JS went UP, from 1,146,830 to 1,314,064. Stated plainly rather than
// buried: the CDN build of SheetJS is kept whole as its own chunk instead of
// being tree-shaken into the main one. That is the right trade — most sessions
// never export anything, so almost nobody pays for those bytes, while everyone
// used to.
const BUDGET = {
  // What a phone waits for before the app is usable: the entry chunk plus any
  // chunk the HTML preloads. THIS is the number that should keep falling.
  firstLoadJs: 870_000,
  // Everything the build emits. A ceiling on total growth, not on first load.
  totalJs: 1_380_000,
  totalCss: 60_000,
};

const fmt = (n) => `${(n / 1024).toFixed(1)} KB`;

let files;
try {
  files = readdirSync(DIST).map((name) => ({ name, size: statSync(join(DIST, name)).size }));
} catch {
  console.error(`::error::No build output at ${DIST}. Run the production build first.`);
  process.exit(1);
}

const js = files.filter((f) => f.name.endsWith(".js"));
const css = files.filter((f) => f.name.endsWith(".css"));

if (js.length === 0) {
  console.error("::error::The build emitted no JavaScript. That is not a passing build.");
  process.exit(1);
}

const totalJs = js.reduce((n, f) => n + f.size, 0);
const totalCss = css.reduce((n, f) => n + f.size, 0);

// Which chunks does the browser fetch before the app can render? Read from the
// HTML the build actually emitted, not inferred from filenames — a chunk named
// "xlsx" that turned out to be preloaded would still be a first-load cost.
let html;
try {
  html = readFileSync(join(ROOT, "dist", "index.html"), "utf8");
} catch {
  console.error("::error::No dist/index.html. Run the production build first.");
  process.exit(1);
}
const eager = new Set(
  [...html.matchAll(/(?:src|href)="\/assets\/([^"]+\.js)"/g)].map((m) => m[1]),
);
// Two separate ways this can be vacuously true, and both have to be closed.
// Checking only "did the regex match something" is not enough: pointed at a
// filename that does not exist, this reported a cheerful "first-load: 0.0 KB,
// OK". Found by deliberately breaking it — which is the only way such a hole
// ever gets found.
if (eager.size === 0) {
  console.error(
    "::error::No JS referenced from dist/index.html. Either the build changed shape " +
      "or this check is looking in the wrong place — a budget that matches nothing " +
      "would pass forever.",
  );
  process.exit(1);
}
const emitted = new Set(js.map((f) => f.name));
const missing = [...eager].filter((n) => !emitted.has(n));
if (missing.length > 0) {
  console.error(
    `::error::dist/index.html references JS that the build did not emit: ${missing.join(", ")}. ` +
      "Measuring what is left would understate first load.",
  );
  process.exit(1);
}
const firstLoadJs = js.filter((f) => eager.has(f.name)).reduce((n, f) => n + f.size, 0);

console.log("Emitted assets:");
for (const f of [...js, ...css].sort((a, b) => b.size - a.size)) {
  const when = f.name.endsWith(".js") ? (eager.has(f.name) ? "first load" : "on demand") : "";
  console.log(`  ${fmt(f.size).padStart(10)}  ${f.name}  ${when}`);
}
console.log("");

const checks = [
  ["first-load JavaScript", firstLoadJs, BUDGET.firstLoadJs],
  ["total JavaScript", totalJs, BUDGET.totalJs],
  ["total CSS", totalCss, BUDGET.totalCss],
];

let failed = false;
for (const [label, actual, budget] of checks) {
  const pct = ((actual / budget) * 100).toFixed(1);
  if (actual > budget) {
    failed = true;
    console.error(
      `::error::${label} is ${fmt(actual)}, over the ${fmt(budget)} budget by ${fmt(actual - budget)}.`,
    );
  } else {
    console.log(`OK  ${label}: ${fmt(actual)} of ${fmt(budget)} (${pct}%)`);
  }
}

if (failed) {
  console.error("");
  console.error(
    "::error::Bundle budget exceeded. Either shrink the bundle, or raise the budget " +
      "in scripts/check-bundle-size.mjs in this same commit and explain why.",
  );
  process.exit(1);
}
