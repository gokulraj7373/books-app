import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/* ============================================================================
   The site screen names five recipes by string id.

   Nothing in TypeScript connects those strings to `recipes.ts`. `getRecipe`
   takes a plain `string` and returns undefined for one it does not know, so a
   recipe renamed on one side would turn a button into one that silently does
   nothing — no type error, no crash, no entry. Just a dead button, discovered
   while standing on a building site holding a bill.

   Same shape of problem as subGroups.test.ts, and the same fix: read both
   files and check they still agree. Read as TEXT rather than imported, because
   `checks/` builds under tsconfig.node.json and `src/` under tsconfig.app.json
   — importing across that boundary type-checks app code with the wrong lib.
   ========================================================================= */

const ROOT = new URL("../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const SCREEN = join(ROOT, "src", "features", "site", "SiteExpense.tsx");
const RECIPES = join(ROOT, "src", "lib", "recipes.ts");

/** The ids the screen actually offers, read from the screen. */
function siteIds(): string[] {
  const src = readFileSync(SCREEN, "utf8");
  const block = src.match(/const SITE_CATEGORIES = \[([\s\S]*?)\n\] as const;/);
  if (!block) throw new Error("SITE_CATEGORIES not found — has the screen been restructured?");
  // Deliberately permissive about the id's shape. A narrow pattern (say
  // `[a-z_]+`) silently SKIPS an id it dislikes, so a typo would trip the count
  // assertion rather than the "is this a real recipe?" one — the right answer
  // for the wrong reason, with a misleading message.
  return [...block[1].matchAll(/^\s*id:\s*"([^"]+)"/gm)].map((m) => m[1]);
}

/** Every recipe id defined in the engine. */
function recipeIds(): string[] {
  const src = readFileSync(RECIPES, "utf8");
  return [...src.matchAll(/^\s*id:\s*"([^"]+)",$/gm)].map((m) => m[1]);
}

/** The source of one recipe object, from its id to the start of the next. */
function recipeBlock(id: string): string {
  const src = readFileSync(RECIPES, "utf8");
  const start = src.indexOf(`id: "${id}",`);
  if (start === -1) throw new Error(`recipe "${id}" not found`);
  const next = src.indexOf('\n    id: "', start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

describe("site expense categories", () => {
  // Guards the guards. If either regex stopped matching, every assertion below
  // would iterate an empty array and pass forever — a check that cannot fail is
  // worse than no check at all.
  it("finds the categories in the screen", () => {
    expect(siteIds()).toHaveLength(5);
  });

  it("finds the recipes in the engine", () => {
    expect(recipeIds().length).toBeGreaterThan(5);
  });

  it.each(siteIds())("%s is a real recipe", (id) => {
    expect(recipeIds(), `no recipe "${id}" — was it renamed in recipes.ts?`).toContain(id);
  });

  it("offers no duplicates", () => {
    expect(new Set(siteIds()).size).toBe(siteIds().length);
  });

  // `bill_received` has no fields of its own — it redirects to the full bill
  // screen. The site screen navigates for it instead of rendering an empty
  // form, so if that flag moves the screen has to move with it.
  it("bill_received still redirects", () => {
    expect(recipeBlock("bill_received")).toContain("redirectTo");
  });

  // ...and the other four must NOT, or the screen would bounce the user
  // elsewhere for a category it claims to handle itself.
  it.each(siteIds().filter((i) => i !== "bill_received"))("%s is filled in place", (id) => {
    expect(recipeBlock(id)).not.toContain("redirectTo");
  });
});
