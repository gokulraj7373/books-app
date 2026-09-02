import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useCompany } from "../company/CompanyProvider";
import { companyConfig, listAccounts, taxPostingSetup } from "../../lib/queries";
import { getRecipe } from "../../lib/recipes";
import { RecipeForm } from "../entries/GuidedEntry";
import { Alert, Skeleton } from "../../components/ui";

/* ============================================================================
   Recording spend on site.

   The fast way in, for standing in a half-built room holding a bill. The full
   entry screen asks you to describe what happened and search a list; here there
   are five buttons, because on a site there are only five things.

   It contains NO accounting. Each button picks a recipe that already exists and
   is already tested, and hands it to the SAME form the main entry screen uses.
   Nothing here decides a debit or a credit, and nothing here talks to
   `save_journal_entry` directly — so a site expense is an ordinary entry that
   happened to be typed with fewer taps, and it shows up in the day book, the
   trial balance and Building / CapEx with no extra wiring.

   If this screen ever needs a rule the recipes cannot express, the rule belongs
   in `recipes.ts`, where every screen gets it — never copied in here.
   ========================================================================= */

/** The five things that actually happen on a building site. */
const SITE_CATEGORIES = [
  {
    id: "construction_spend",
    icon: "⌂",
    label: "Civil or interior work",
    hint: "Masonry, wiring, plumbing, carpentry, painting",
  },
  {
    id: "buy_asset",
    icon: "▣",
    label: "Bought equipment or furniture",
    hint: "Something you will still own in five years",
  },
  {
    id: "advance_supplier",
    icon: "→",
    label: "Advance to a contractor",
    hint: "Money paid up front, before the work is done",
  },
  {
    id: "pay_expense",
    icon: "−",
    label: "Site running cost",
    hint: "Transport, tea, small hire, fees — spent and gone",
  },
  {
    id: "bill_received",
    icon: "🧾",
    label: "Got a bill, paying later",
    hint: "Opens the full bill screen, where terms and due dates live",
  },
] as const;

export function SiteExpense() {
  const nav = useNavigate();
  const { company, statutoryBook } = useCompany();
  const [recipeId, setRecipeId] = useState<string | null>(null);

  const accountsQ = useQuery({
    queryKey: ["accounts", company?.id],
    queryFn: () => listAccounts(company!.id),
    enabled: !!company,
  });
  const configQ = useQuery({
    queryKey: ["company-config", company?.id],
    queryFn: () => companyConfig(company!.id),
    enabled: !!company,
  });
  const taxQ = useQuery({
    queryKey: ["tax-setup", company?.id],
    queryFn: () => taxPostingSetup(company!.id),
    enabled: !!company,
  });

  if (!company) return <p className="text-sm text-muted">Create a company first.</p>;
  if (accountsQ.isLoading || configQ.isLoading || !statutoryBook) return <Skeleton rows={6} />;

  const recipe = recipeId ? getRecipe(recipeId) : null;

  if (recipe) {
    return (
      <RecipeForm
        recipe={recipe}
        accounts={accountsQ.data ?? []}
        companyId={company.id}
        features={configQ.data?.features}
        taxSetup={taxQ.data ?? null}
        onBack={() => setRecipeId(null)}
        backLabel="← Site expense"
      />
    );
  }

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-xl font-extrabold text-navy">Site expense</h1>
      <p className="mt-0.5 mb-4 text-sm text-muted">What did you pay for?</p>

      <div className="grid gap-2.5">
        {SITE_CATEGORIES.map((c) => {
          const r = getRecipe(c.id);
          return (
            <button
              key={c.id}
              type="button"
              // `bill_received` is a redirect recipe — it has no fields of its
              // own and is handled by the full bill screen. Honour that here
              // rather than rendering an empty form.
              onClick={() => (r?.redirectTo ? nav({ to: r.redirectTo }) : setRecipeId(c.id))}
              className="flex items-center gap-4 rounded-2xl border border-line bg-card p-5 text-left shadow-sm transition-[border-color,transform] duration-200 hover:border-navy active:scale-[0.98]"
            >
              <span
                aria-hidden
                className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-navy/5 text-2xl text-navy"
              >
                {c.icon}
              </span>
              <span className="min-w-0">
                <span className="block text-base font-bold text-ink">{c.label}</span>
                <span className="mt-0.5 block text-xs text-muted">{c.hint}</span>
              </span>
            </button>
          );
        })}
      </div>

      {/* Deliberately a LINK, not a total computed here. Two places that each
          work out "what the project has spent" will disagree eventually, and
          the one on the phone is the one people believe. There is exactly one
          answer to that question and it lives on the CapEx screen, derived from
          what actually posted. */}
      <p className="mt-5 text-center text-sm text-muted">
        <Link to="/capex" className="font-semibold text-navy underline underline-offset-2">
          Budget vs spent
        </Link>
      </p>

      {!configQ.data?.features?.capex && (
        <div className="mt-4">
          <Alert tone="info" title="“Building something” is switched off">
            Turn it on in Settings to see budget and CapEx alongside these entries.
          </Alert>
        </div>
      )}
    </div>
  );
}
