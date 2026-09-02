import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/* ============================================================================
   sub_group is a KEY shared between the database and the recipe engine.

   The balance sheet groups on it, `accountsFor` selects on it, and since the
   industry-templates migration the database refuses any value outside a fixed
   list. Nothing in TypeScript knows that list, so a section renamed in SQL
   would leave every recipe that names it silently offering no accounts at all
   — the picker would simply be empty, with no error anywhere.

   These tests read the SQL and the TypeScript and check they still agree.
   They fail the moment either side moves without the other.
   ========================================================================= */

const ROOT = new URL("../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const MIGRATIONS = join(ROOT, "supabase", "migrations");

function migrationText(): string {
  const file = readdirSync(MIGRATIONS).find((f) => f.endsWith("_industry_chart_templates.sql"));
  if (!file) throw new Error("the industry-templates migration is missing from the repo");
  return readFileSync(join(MIGRATIONS, file), "utf8");
}

/** The keys seeded into account_sub_groups. */
function canonicalSubGroups(): Set<string> {
  const sql = migrationText();
  const block = sql.slice(
    sql.indexOf("insert into public.account_sub_groups"),
    sql.indexOf("on conflict (key) do update"),
  );
  const keys = [...block.matchAll(/^ {2}\('([^']+)','/gm)].map((m) => m[1]);
  if (keys.length === 0) throw new Error("could not read any sub_group keys out of the migration");
  return new Set(keys);
}

/** Every sub_group named in a recipe filter. */
function subGroupsUsedByRecipes(): string[] {
  const ts = readFileSync(join(ROOT, "src", "lib", "recipes.ts"), "utf8");
  return [...ts.matchAll(/subGroup:\s*\[([^\]]*)\]/g)].flatMap((m) =>
    [...m[1].matchAll(/"([^"]+)"/g)].map((s) => s[1]),
  );
}

/** Every sub_group a chart template files an account under. */
function subGroupsUsedByTemplates(): string[] {
  const sql = migrationText();
  const block = sql.slice(sql.indexOf("delete from public.chart_template_accounts;"));
  return [...block.matchAll(/^ {2}\('[^']+','\d+','[^']*','\w+','([^']+)'/gm)].map((m) => m[1]);
}

describe("sub_group is a shared key, not a label", () => {
  it("has a canonical list with the sections the reports expect", () => {
    const canon = canonicalSubGroups();
    expect(canon.size).toBeGreaterThan(20);
    expect(canon.has("Cash & Bank")).toBe(true);
    expect(canon.has("Trade Payables")).toBe(true);
  });

  it("every sub_group a recipe filters on exists in the database's list", () => {
    const canon = canonicalSubGroups();
    const used = subGroupsUsedByRecipes();
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((s) => !canon.has(s))).toEqual([]);
  });

  it("every sub_group a chart template uses exists in the database's list", () => {
    const canon = canonicalSubGroups();
    const used = subGroupsUsedByTemplates();
    expect(used.length).toBeGreaterThan(50);
    expect([...new Set(used.filter((s) => !canon.has(s)))]).toEqual([]);
  });

  it("notices a section that does not exist — the check can fail", () => {
    const canon = canonicalSubGroups();
    expect(canon.has("Kitchen Costs")).toBe(false);
  });
});

describe("chart templates", () => {
  it("keeps the codes the app and the reports know by heart", () => {
    const sql = migrationText();
    // These are referenced by recipes, seeds and the CapEx screen. Renaming an
    // account is fine; moving one of these codes is not.
    for (const code of ["1010", "1020", "2010", "4010", "5010", "9900", "9910", "9920"]) {
      expect(sql).toContain(`('core','${code}',`);
    }
  });

  it("gives every industry an overlay that agrees with the core on 4010", () => {
    const sql = migrationText();
    const overlays = [...sql.matchAll(/^ {2}\('(\w+)','4010','([^']+)','(\w+)'/gm)];
    expect(overlays.length).toBeGreaterThan(5);
    for (const [, , , type] of overlays) expect(type).toBe("income");
  });
});
