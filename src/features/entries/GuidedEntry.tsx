import { useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../company/CompanyProvider";
import { companyConfig, listAccounts, saveJournalEntry, taxPostingSetup } from "../../lib/queries";
import { supabase } from "../../lib/supabase";
import { fromPaise, inr, toPaise } from "../../lib/money";
import {
  CREDIT_RECIPE_IDS,
  accountsFor,
  applyTaxes,
  directionNote,
  getRecipe,
  moneyAccountsForBook,
  recipesFor,
  searchRecipes,
  taxFieldsFor,
  validateLines,
  type Recipe,
  type TaxSetup,
} from "../../lib/recipes";
import { Alert, Button, Card, Field, inputClass, Skeleton } from "../../components/ui";
import { PartyPicker } from "./PartyPicker";
import { ProofPicker } from "./ProofPicker";
import { SmartPreview } from "./SmartPreview";
import { parseEntry } from "../../lib/parseEntry";
import { errorMessage } from "../../lib/errors";

/**
 * Today, in the user's OWN timezone.
 *
 * This was `toISOString().slice(0,10)`, which is UTC. India is UTC+5:30, so
 * every entry made between midnight and 5:30am was silently dated to the
 * PREVIOUS day — a real wrong date on a real voucher, in the window when
 * someone is most likely to be closing off the day's spend.
 */
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const INTERNAL_MODE_REASON = "Internal book entry — not routed through the company bank";


export function GuidedEntry() {
  const nav = useNavigate();
  const { company, statutoryBook } = useCompany();
  const [recipeId, setRecipeId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // Values carried over when the smart bar understood a whole sentence.
  const [prefill, setPrefill] = useState<
    { amount?: string; date?: string; party?: string; note?: string } | undefined
  >();
  // Set when the user says "no, show me the tiles" — suppresses the preview for
  // that text without clearing what they typed, since the words still search.
  const [smartOff, setSmartOff] = useState(false);

  const accountsQ = useQuery({
    queryKey: ["accounts", company?.id],
    queryFn: () => listAccounts(company!.id),
    enabled: !!company,
  });
  // What this business actually does, and how it is registered. Both decide
  // which tiles exist and which boxes appear inside them.
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

  const features = configQ.data?.features;
  const recipe = recipeId ? getRecipe(recipeId) : null;

  if (!recipe) {
    const all = recipesFor(company.lifecycle_phase, features);
    const shown = searchRecipes(all, query);
    // Only worth reading as a sentence once there is a sentence to read.
    const parsed = query.trim().split(/\s+/).length >= 3 ? parseEntry(query, all) : null;
    return (
      <div className="mx-auto max-w-2xl">
        <h1 className="text-xl font-extrabold text-navy">What happened?</h1>
        <p className="mt-0.5 mb-3 text-sm text-muted">
          Describe it in your own words, or pick from the list.
        </p>

        {/* Hunting through tiles is the slow way in. Type what you would say out
            loud — "loan to cafe", "rent", "advance" — and the right one comes up. */}
        <div className="mb-4">
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSmartOff(false);
            }}
            placeholder="Try: paid 25000 to Sushant for cement on 12 aug"
            aria-label="Describe what happened, or search"
            className={inputClass}
          />

          {/* A whole sentence gets read as a whole sentence. Anything less
              still behaves exactly as the old search box did, so nobody who
              types one word has to learn a new habit. */}
          {!smartOff && parsed?.recipe && (parsed.amountPaise !== null || parsed.partyName) && (
            <SmartPreview
              parsed={parsed}
              companyId={company.id}
              todayIso={today()}
              onUse={(partyName) => {
                setPrefill({
                  amount: parsed.amountPaise !== null ? fromPaise(parsed.amountPaise) : undefined,
                  date: parsed.date,
                  party: partyName ?? undefined,
                  note: parsed.note ?? undefined,
                });
                if (parsed.recipe!.redirectTo) nav({ to: parsed.recipe!.redirectTo });
                else setRecipeId(parsed.recipe!.id);
              }}
              onDismiss={() => setSmartOff(true)}
            />
          )}
          {/* Some words do not say which way the money went. Answering "loan"
              with the lending tile is a coin flip that posts the exact inverse
              entry half the time, so the app asks rather than guesses. */}
          {directionNote(query) && (
            <div className="mt-3">
              <Alert tone="warn" title="Which way round?">
                {directionNote(query)}
              </Alert>
            </div>
          )}

          {query && shown.length === 0 && (
            <div className="mt-3">
              <Alert tone="warn" title={`Nothing matches "${query}"`}>
                Try a simpler word — “lent”, “advance”, “bill”, “rent”, “capital”. If it really is
                not here, the accountant's screen at the bottom can record anything.
              </Alert>
            </div>
          )}
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          {shown.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => (r.redirectTo ? nav({ to: r.redirectTo }) : setRecipeId(r.id))}
              className="flex items-start gap-3 rounded-2xl border border-line bg-card p-4 text-left shadow-sm transition-[border-color,transform] duration-200 hover:border-navy active:scale-[0.98]"
            >
              <span
                aria-hidden
                className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-navy/5 text-lg text-navy"
              >
                {r.icon}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-bold text-ink">{r.title}</span>
                <span className="mt-0.5 block text-xs text-muted">{r.blurb}</span>
              </span>
            </button>
          ))}
        </div>

        <p className="mt-5 text-center text-xs text-muted">
          Can't find it?{" "}
          <a href="/entry/advanced" className="font-semibold text-navy underline underline-offset-2">
            Use the accountant's screen
          </a>
        </p>
      </div>
    );
  }

  return (
    <RecipeForm
      recipe={recipe}
      accounts={accountsQ.data ?? []}
      companyId={company.id}
      features={features}
      taxSetup={taxQ.data ?? null}
      onBack={() => setRecipeId(null)}
      prefill={prefill}
    />
  );
}

/**
 * Exported because the site-expense screen (`/site`) is a different way IN to
 * the same form, not a different form. Everything that decides what actually
 * posts — paise conversion, the idempotency key, the two-book rule, party
 * cleanup on failure, `validateLines` — lives here exactly once. A second
 * screen with its own copy of that logic is a second screen that can drift into
 * posting something different from what this one would.
 */
export function RecipeForm({
  recipe,
  accounts,
  companyId,
  features,
  taxSetup,
  onBack,
  backLabel = "← Something else",
  prefill,
}: {
  recipe: Recipe;
  accounts: ReturnType<typeof accountsFor>;
  companyId: string;
  features: Record<string, boolean> | undefined;
  taxSetup: TaxSetup | null;
  onBack: () => void;
  backLabel?: string;
  /** Opening values from the smart bar. Editable once the form is open. */
  prefill?: { amount?: string; date?: string; party?: string; note?: string };
}) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const { statutoryBook, managementBook, can, internalMode } = useCompany();

  // Which book this lands in. Follows whichever book the app is currently in,
  // so what you are looking at and what you are about to record can never
  // disagree. The tick-box below still lets a single entry go the other way.
  // DERIVED, never copied into state. `useState(internalMode)` captured the
  // value at first render — and on a cold load the books query had not resolved
  // yet, so internalMode was still false. The header then said "Internal" while
  // this form said "OFFICIAL" and posted to the statutory book: the exact
  // wrong-book mistake the whole mode exists to prevent.
  // null = follow the app's mode; true/false = this one entry goes the other way.
  const [override, setOverride] = useState<boolean | null>(null);
  const internal = override ?? internalMode;
  const setInternal = (v: boolean) => setOverride(v === internalMode ? null : v);
  // When the WHOLE APP is in internal mode the reason is the mode itself, so
  // it is pre-filled rather than demanded on every entry. A one-off override
  // out of the official books still has to be explained in words.
  const [reason, setReason] = useState(INTERNAL_MODE_REASON);
  const bookId = internal && managementBook ? managementBook.id : statutoryBook!.id;
  const canUseManagement = !!managementBook && can("view_management_book");

  const capital = accounts.find((a) => a.capex_role === "capital") ?? accounts.find((a) => a.account_type === "equity");
  const payables = accounts.find((a) => a.sub_group === "Trade Payables");

  // Seeded from the smart bar when the user typed a sentence instead of
  // hunting for a tile. Initial values only — once the form is open these are
  // ordinary editable fields, so a wrong guess costs one correction, never a
  // wrong entry. `date` still defaults to today when nothing was typed.
  const [amount, setAmount] = useState(prefill?.amount ?? "");
  const [gst, setGst] = useState("");
  const [tds, setTds] = useState("");
  const [date, setDate] = useState(prefill?.date ?? today());
  const [party, setParty] = useState(prefill?.party ?? "");
  const [note, setNote] = useState(prefill?.note ?? "");
  const [dueDate, setDueDate] = useState("");
  const [moneyAccountId, setMoneyAccountId] = useState<string>("");
  const [targetAccountId, setTargetAccountId] = useState<string>("");
  // `proof_url` has existed since the first migration and, until now, only the
  // bill screen could fill it — so not one of the entries recorded through this
  // form carried its receipt. On site, the photo IS the record.
  const [proof, setProof] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // One key per filled-in form, generated once and kept across retries. Without
  // it, a save that timed out on the way back looked like a failure, and the
  // obvious response — press Record again — posted the payment twice.
  const idempotencyKey = useRef(crypto.randomUUID());

  const has = (k: string) => recipe.fields.some((f) => f.key === k);
  const fieldFor = (k: string) => recipe.fields.find((f) => f.key === k);

  const moneyField = fieldFor("moneyAccount");
  const moneyFilter = moneyField && "filter" in moneyField ? moneyField.filter : undefined;
  const moneyOptions =
    moneyFilter && !moneyFilter.bookScopedMoney
      ? accountsFor(accounts, moneyFilter)
      : moneyAccountsForBook(accounts, bookId, internal);
  const noInternalCash = internal && !moneyFilter && moneyOptions.length === 0;

  const targetField = fieldFor("targetAccount");
  const targetFilter = targetField && "filter" in targetField ? targetField.filter : undefined;
  // A transfer's "to where?" is a money account too, so it obeys the same book
  // rule as the "from where?" side rather than matching on sub_group.
  const targetOptions = targetFilter?.bookScopedMoney
    ? moneyAccountsForBook(accounts, bookId, internal)
    : accountsFor(accounts, targetFilter);

  /**
   * NOTHING is pre-selected.
   *
   * This used to default to `options[0]` — the lowest account code, which for
   * both sides of a bank↔cash transfer was the same account. One tap on Record
   * posted `Dr Bank 50,000 / Cr Bank 50,000`: balanced, hash-chained, and
   * completely meaningless. A default is only safe when there is genuinely no
   * choice to make, so it is applied only when the list holds exactly one item.
   */
  const soleOption = (opts: typeof accounts) => (opts.length === 1 ? opts[0].id : "");
  const effectiveMoneyId = moneyOptions.some((a) => a.id === moneyAccountId)
    ? moneyAccountId
    : soleOption(moneyOptions);
  const effectiveTargetId = targetOptions.some((a) => a.id === targetAccountId)
    ? targetAccountId
    : soleOption(targetOptions);

  // No valid two-line entry debits and credits the same account. The database
  // rejects it too (see migration 0044) — this is so the user finds out before
  // filling the form in, not after.
  const sameAccount =
    has("moneyAccount") &&
    has("targetAccount") &&
    !!effectiveMoneyId &&
    effectiveMoneyId === effectiveTargetId;

  // A chart that genuinely lacks the account this recipe needs. `accountsFor`
  // used to hide this by falling back to the whole chart; saying so plainly and
  // refusing to post is the only honest answer.
  const missingMoneyAccounts = has("moneyAccount") && moneyOptions.length === 0 && !noInternalCash;
  const missingTargetAccounts = has("targetAccount") && targetOptions.length === 0;

  let paise = 0;
  let amountValid = false;
  try {
    paise = toPaise(amount);
    amountValid = paise > 0;
  } catch {
    amountValid = false;
  }

  // Which tax boxes exist here at all. A business that is not registered for
  // GST never sees them; a registered one on a scheme that blocks input credit
  // does not either, because for them the tax is simply part of the cost and
  // there is nothing to split out.
  const taxFields = taxFieldsFor(recipe, features, taxSetup);
  const readPaise = (s: string) => {
    if (!s.trim()) return 0;
    try {
      return toPaise(s);
    } catch {
      return -1; // junk, which the line validator will refuse
    }
  };
  const gstPaise = taxFields.gst ? readPaise(gst) : 0;
  const tdsPaise = taxFields.tds ? readPaise(tds) : 0;

  /**
   * The actual lines, built and taxed exactly as they will be sent.
   *
   * Derived on every render rather than only at submit, so the preview below
   * is the entry itself and not a second description of it that could drift
   * out of step with what gets posted.
   */
  let lines: ReturnType<typeof applyTaxes> = [];
  let lineError: string | null = null;
  if (amountValid && capital) {
    try {
      lines = applyTaxes(
        recipe.build({
          paise,
          moneyAccountId: effectiveMoneyId,
          targetAccountId: effectiveTargetId,
          capitalAccountId: capital.id,
          payablesAccountId: payables?.id ?? "",
        }),
        { gstPaise: Math.max(gstPaise, 0), tdsPaise: Math.max(tdsPaise, 0) },
        taxSetup ?? {
          gstInputAccountId: null,
          gstOutputAccountId: null,
          tdsPayableAccountId: null,
          itcClaimable: false,
        },
      );
      lineError = validateLines(lines, accounts);
      if (gstPaise < 0) lineError = "The GST amount is not a number.";
      if (tdsPaise < 0) lineError = "The TDS amount is not a number.";
    } catch (err) {
      lines = [];
      lineError = err instanceof Error ? err.message : String(err);
    }
  }

  const explainCtx = {
    amountText: amountValid ? inr(paise) : "the amount",
    partyName: party.trim() || undefined,
    targetName: accounts.find((a) => a.id === effectiveTargetId)?.name,
    moneyName: accounts.find((a) => a.id === effectiveMoneyId)?.name ?? "Your money",
    note: note.trim() || undefined,
  };

  const partyRequired = has("party") && !fieldFor("party")!.label.includes("optional");
  const needsPayables = (CREDIT_RECIPE_IDS as readonly string[]).includes(recipe.id);
  const ready =
    amountValid &&
    !!date &&
    (!has("moneyAccount") || !!effectiveMoneyId) &&
    (!has("targetAccount") || !!effectiveTargetId) &&
    (!partyRequired || party.trim().length > 0) &&
    !sameAccount &&
    !noInternalCash &&
    !missingMoneyAccounts &&
    !missingTargetAccounts &&
    !!capital &&
    (!needsPayables || !!payables) &&
    (!internal || reason.trim().length > 0) &&
    lines.length >= 2 &&
    !lineError;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    // Was this name already one of our parties before we touched anything? If
    // not, and the entry then fails to post, the party we just created is an
    // orphan — a name in the dropdown that never had a transaction.
    const partyExisted = (qc.getQueryData<{ name: string }[]>(["parties", companyId]) ?? []).some(
      (p) => p.name.trim().toLowerCase() === party.trim().toLowerCase(),
    );
    let createdPartyId: string | undefined;
    try {
      let partyId: string | undefined;
      if (party.trim()) {
        const { data, error } = await supabase.rpc("find_or_create_party", {
          p_company: companyId,
          p_name: party.trim(),
          p_type: (fieldFor("party") as { partyType?: string } | undefined)?.partyType ?? null,
        });
        if (error) throw error;
        partyId = data as string;
        if (!partyExisted) createdPartyId = partyId;
      }

      // Belt and braces. `ready` already blocks a bad set of lines, but the
      // builder is the only thing that decides what actually gets posted, so
      // the check that matters is the one on its output — re-run here rather
      // than trusting a flag computed during an earlier render.
      const problem = validateLines(lines, accounts);
      if (problem) throw new Error(problem);

      await saveJournalEntry({
        company_id: companyId,
        book_id: bookId,
        voucher_type: recipe.voucherType,
        entry_date: date,
        narration: recipe.narration(explainCtx),
        status: "posted",
        due_date: dueDate || undefined,
        proof_url: proof || undefined,
        adjustment_reason: internal ? reason.trim() : undefined,
        // Stable for the life of this filled-in form, so a retry after a
        // timeout re-posts the SAME entry rather than a second one. Reset only
        // once the entry is safely in.
        idempotency_key: idempotencyKey.current,
        // Amounts go over the wire as validated paise turned back into a
        // decimal string, never as whatever was typed. `toPaise` has already
        // rejected junk and more than two decimals; sending the raw string sent
        // "1,200" and " 500 " straight to Postgres.
        lines: lines.map((l) => ({
          account_id: l.accountId,
          debit: l.debitPaise > 0 ? fromPaise(l.debitPaise) : undefined,
          credit: l.creditPaise > 0 ? fromPaise(l.creditPaise) : undefined,
          // Each line says for itself whether it belongs to the party. The
          // engine no longer guesses from which side happens to be a bank
          // account, which is what made a two-party set-off impossible.
          party_id: l.party ? partyId : undefined,
          line_narration: l.note,
        })),
      });

      await qc.invalidateQueries();
      void nav({ to: "/entries" });
    } catch (err) {
      // Don't leave a party behind for an entry that never happened. The delete
      // is best-effort: if the party did pick up a line somehow, the foreign key
      // refuses and we quietly keep it.
      if (createdPartyId) {
        await supabase.from("parties").delete().eq("id", createdPartyId);
        void qc.invalidateQueries({ queryKey: ["parties", companyId] });
      }
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-lg">
      <button
        type="button"
        onClick={onBack}
        className="mb-3 text-sm font-semibold text-muted hover:text-navy"
      >
        {backLabel}
      </button>

      <h1 className="text-xl font-extrabold text-navy">{recipe.title}</h1>
      <p className="mt-0.5 mb-4 text-sm text-muted">{recipe.blurb}</p>

      <form onSubmit={submit}>
        <Card className="space-y-4 p-5">
          {recipe.fields.map((f) => {
            if (f.key === "amount")
              return (
                <Field key={f.key} label={f.label} required>
                  <div className="relative">
                    <span className="absolute top-1/2 left-3 -translate-y-1/2 text-sm font-semibold text-muted">
                      ₹
                    </span>
                    <input
                      className={`${inputClass} pl-7 text-lg font-bold tnum`}
                      inputMode="decimal"
                      placeholder="0.00"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      autoFocus
                    />
                  </div>
                </Field>
              );

            if (f.key === "date")
              return (
                <Field key={f.key} label={f.label} required>
                  <input
                    type="date"
                    className={inputClass}
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                  />
                </Field>
              );

            if (f.key === "party")
              return (
                <Field key={f.key} label={f.label} hint={f.hint} required={partyRequired}>
                  <PartyPicker companyId={companyId} value={party} onChange={setParty} />
                </Field>
              );

            if (f.key === "dueDate")
              return (
                <Field key={f.key} label={f.label} hint={f.hint}>
                  <input
                    type="date"
                    className={inputClass}
                    value={dueDate}
                    onChange={(e) => setDueDate(e.target.value)}
                  />
                </Field>
              );

            if (f.key === "note")
              return (
                <Field key={f.key} label={f.label} hint={f.hint}>
                  <input
                    className={inputClass}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Anything you want to remember about this"
                  />
                </Field>
              );

            if (f.key === "moneyAccount")
              return (
                <Field key={f.key} label={f.label} hint={f.hint} required>
                  <select
                    className={inputClass}
                    value={effectiveMoneyId}
                    onChange={(e) => setMoneyAccountId(e.target.value)}
                  >
                    {/* No silent default. An account picked by the app is an
                        account nobody read. */}
                    <option value="">Choose…</option>
                    {moneyOptions.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </Field>
              );

            return (
              <Field key={f.key} label={f.label} hint={f.hint} required>
                <select
                  className={inputClass}
                  value={effectiveTargetId}
                  onChange={(e) => setTargetAccountId(e.target.value)}
                >
                  <option value="">Choose…</option>
                  {targetOptions.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </Field>
            );
          })}

          {/* Tax boxes, only where they can apply. The label says what the
              number means, because "GST" alone leaves the user guessing whether
              it is included in what they typed or on top of it. */}
          {taxFields.gst && (
            <Field
              label="Of which GST"
              hint="The GST already included in the amount above. It is claimed back rather than treated as a cost, so it does not reduce your profit."
            >
              <div className="relative">
                <span className="absolute top-1/2 left-3 -translate-y-1/2 text-sm font-semibold text-muted">
                  ₹
                </span>
                <input
                  className={`${inputClass} pl-7 tnum`}
                  inputMode="decimal"
                  placeholder="0.00"
                  value={gst}
                  onChange={(e) => setGst(e.target.value)}
                />
              </div>
            </Field>
          )}

          {taxFields.tds && (
            <Field
              label="Of which TDS deducted"
              hint="Withheld from them and paid to the government instead. Enter the amount you actually deducted — your CA will tell you the rate that applies."
            >
              <div className="relative">
                <span className="absolute top-1/2 left-3 -translate-y-1/2 text-sm font-semibold text-muted">
                  ₹
                </span>
                <input
                  className={`${inputClass} pl-7 tnum`}
                  inputMode="decimal"
                  placeholder="0.00"
                  value={tds}
                  onChange={(e) => setTds(e.target.value)}
                />
              </div>
            </Field>
          )}

          {sameAccount && (
            <Alert tone="danger" title="Both sides are the same account">
              {accounts.find((a) => a.id === effectiveMoneyId)?.name} cannot be both where the money
              left and where it went. Nothing would actually change. Pick two different accounts —
              or if the money did not move at all, this is not the right screen.
            </Alert>
          )}

          {missingTargetAccounts && (
            <Alert tone="warn" title="Your chart has no account for this">
              Nothing in your chart of accounts fits “{targetField?.label}”. Add a suitable account
              first — nothing can be recorded here until there is somewhere for it to go.{" "}
              <Link to="/accounts" className="font-semibold underline underline-offset-2">
                Open chart of accounts
              </Link>
            </Alert>
          )}

          {missingMoneyAccounts && (
            <Alert tone="warn" title="No account to take the money from">
              Nothing in your chart of accounts fits “{moneyField?.label}”.{" "}
              <Link to="/accounts" className="font-semibold underline underline-offset-2">
                Open chart of accounts
              </Link>
            </Alert>
          )}

          {lineError && amountValid && <Alert tone="danger">{lineError}</Alert>}

          {/* Plain-English preview. This is what teaches the owner the accounting
              over time without ever making them learn debits and credits. */}
          {amountValid && (
            <Alert tone="info" title="What this will do">
              {recipe.explain(explainCtx)}
            </Alert>
          )}

          {/* Once an entry can have more than two lines, the sentence above is
              no longer the whole story — a payment with GST and TDS in it has
              four. This shows the lines themselves, but only when there are
              more than the two the sentence already describes, so a plain rent
              payment is not dressed up as bookkeeping homework. */}
          {lines.length > 2 && !lineError && (
            <div className="rounded-xl border border-line p-3">
              <p className="mb-2 text-xs font-bold text-ink">The {lines.length} lines</p>
              <table className="w-full text-xs">
                <tbody>
                  {lines.map((l, i) => {
                    const a = accounts.find((x) => x.id === l.accountId);
                    return (
                      <tr key={`${l.accountId}-${i}`} className="border-t border-line/60">
                        <td className="py-1 pr-2 text-muted">
                          {a?.name ?? "—"}
                          {l.note && <span className="text-muted/70"> · {l.note}</span>}
                        </td>
                        <td className="py-1 pr-2 text-right tnum text-ink">
                          {l.debitPaise > 0 ? inr(l.debitPaise) : ""}
                        </td>
                        <td className="py-1 text-right tnum text-ink">
                          {l.creditPaise > 0 ? inr(l.creditPaise) : ""}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <ProofPicker
            companyId={companyId}
            value={proof}
            onChange={setProof}
            label="Photo of the bill or receipt"
            hint="Optional — and the easiest thing to lose."
          />

          {/* Which book this lands in, stated before the button rather than
              hidden inside a tick-box. An entry in the wrong book is invisible
              in every official report, and the person posting it has no way of
              noticing — so the app has to say it out loud, every time. */}
          <div
            className={`rounded-xl border p-3 ${
              internal ? "border-warn/40 bg-warnbg" : "border-ok/30 bg-okbg"
            }`}
          >
            <p className={`text-sm font-bold ${internal ? "text-warn" : "text-ok"}`}>
              {internal
                ? "This will go into your INTERNAL book only"
                : "This will go into your OFFICIAL books"}
            </p>
            {/* The internal warning stays in full. This is the exact confusion
                that made a statutory trial balance look empty — the one place
                in the app where an extra sentence earns its keep. The official
                case only restated its own heading, so it goes. */}
            {internal && (
              <p className="mt-0.5 text-xs text-warn/90">
                It will not appear in the balance sheet, P&L or trial balance you give your CA.
              </p>
            )}
          </div>

          {canUseManagement && (
            <div className="rounded-xl border border-line p-3">
              <label className="flex cursor-pointer items-start gap-2.5">
                <input
                  type="checkbox"
                  checked={internal}
                  onChange={(e) => setInternal(e.target.checked)}
                  className="mt-0.5"
                />
                {/* The wording flips with the mode. Offering "keep this out of
                    the official books" while the app is ALREADY on the internal
                    book is a tick-box that does nothing — the useful option
                    there is the opposite one. */}
                <span>
                  <span className="block text-sm font-semibold text-ink">
                    {internalMode
                      ? "Actually, put just this one in the official books"
                      : "Keep this out of the official books"}
                  </span>
                  {/* Kept: both state a rule the software enforces — which book
                      it lands in, and that official bank accounts are refused.
                      Trimmed to the rule, without the explanation of it. */}
                  <span className="mt-0.5 block text-xs text-muted">
                    {internalMode
                      ? "For a single entry that did go through the company bank."
                      : "Uses “Cash in Hand (internal only)”. Official bank and cash accounts are not allowed here."}
                  </span>
                </span>
              </label>
              {internal && (
                <div className="mt-3">
                  <Field label="Why is this internal only?" required>
                    <input
                      className={inputClass}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="e.g. paid personally by a partner, not through the company"
                    />
                  </Field>
                </div>
              )}
            </div>
          )}

          {noInternalCash && (
            <Alert tone="warn" title="No internal cash account yet">
              An internal-only entry cannot use your official bank or cash, so it needs a separate
              internal cash account. Untick the box above, or ask your accountant to add one.
            </Alert>
          )}

          {error && <Alert tone="danger">{error}</Alert>}

          <Button type="submit" disabled={!ready || busy} className="w-full">
            {busy ? "Saving…" : amountValid ? `Record ${inr(paise)}` : "Record"}
          </Button>

          {needsPayables && !payables && (
            <p className="text-xs text-danger">
              No "Trade Payables - Suppliers" account found in your chart of accounts. Add one
              before recording credit bills.
            </p>
          )}

          {!capital && (
            <p className="text-xs text-danger">
              No capital account found in your chart of accounts. Add one before recording investor
              money.
            </p>
          )}
        </Card>
      </form>
    </div>
  );
}
