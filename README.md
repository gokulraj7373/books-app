# Books

Double-entry accounting for businesses that **start by building something** — raising
investor capital, paying builders and suppliers, buying equipment — and only later
become a trading business.

That transition is the point. Tally and Zoho assume you are already selling, so they
show a meaningless pre-revenue profit & loss and have no concept of construction spend
turning into an asset. This app treats the capital-expenditure phase as a first-class
stage of a company's life.

> **About this repository.** This is the public copy of a system I built for my own
> venture and still run. The code is the code. The figures in the test fixtures are
> not: every amount, party and investor name in `supabase/tests/`, `src/lib/reports.test.ts`
> and `src/features/capex/buckets.test.ts` has been replaced with an illustrative set
> that is internally consistent and exercises the same paths. The real books are not here.
>
> I am not a trained developer. I run a café. This was built with agentic AI tooling,
> which is why the tests, the migrations and the ship gate matter more than usual —
> they are what makes the output trustworthy rather than merely plausible.

---

## Run it locally

```bash
npm install
cp .env.example .env     # then paste the two Supabase values in
npm run dev              # http://localhost:5174
```

```bash
npx tsc --noEmit && npx vitest run && npm run build
```

---

## Where things live

| Path | What |
|---|---|
| `supabase/migrations/` | The database. Numbered, applied in order. **The schema is the product** — correctness lives here, not in the UI. |
| `supabase/tests/` | SQL suites. Run these before trusting any change to the ledger. |
| `src/lib/money.ts` | Amounts as integer paise. Never do money arithmetic anywhere else. |
| `src/lib/reports.ts` | Statement shaping, as pure functions so the numbers are testable without rendering. |
| `src/features/<feature>/` | Each feature owns its screens and logic. |
| `src/components/ui.tsx` | The design-system primitives. Compose from these; never restyle inline. |

---

## The rules that keep the books trustworthy

These are enforced by the **database**, so no UI bug and no direct API call can get
around them.

1. **Every entry balances.** A deferred constraint trigger checks at COMMIT, so an
   unbalanced entry cannot exist even momentarily.
2. **Posted entries are immutable.** Corrections happen only by reversal and re-entry.
   This is what makes the books CA-acceptable.
3. **`save_journal_entry` is the only way in.** `authenticated` has no INSERT, UPDATE or
   DELETE grant on the ledger at all.
4. **Voucher numbers are gapless**, allocated under an advisory lock.
5. **A tamper-evident hash chain** links every posted entry to the one before it.
6. **A management-book entry may never touch a bank or cash account.**

### Rule 6 is the one people ask about

Money that moved through the company's bank account **must** be in the statutory book,
because the bank statement is third-party evidence and statutory cash has to reconcile
to it. So the split between books is decided by *which account the money physically
moved through* — not by preference.

Worked example. ₹1,00,000 from an investor: ₹70,000 arrives in the company bank,
₹30,000 is paid by that investor directly to a labourer and never enters the company.

| | Statutory | Management |
|---|---|---|
| Capital | ₹70,000 | ₹1,00,000 |
| Expenses | ₹70,000 | ₹1,00,000 |
| **Cash & bank** | **₹0** | **₹0** |
| Reconciles to the bank statement? | Yes | Yes |

The counter-entry for the off-statutory ₹30,000 is **the investor's own capital
contribution**, not a suspense account. Both books balance independently.

The management book is for management-basis depreciation, notional owner rent or
salary, cost allocations, provisions, timing differences, and genuinely-not-the-entity
spend. **Holding real entity revenue out of the statutory book is tax evasion**, which
is why every management entry requires a reason from a controlled list and why a
statutory-vs-management reconciliation exists.

> Get your CA to sign off on the adjustment-reason list before anyone relies on these
> books.

---

## Verifying the books

```bash
psql "$DB_URL" -f supabase/tests/ledger_guarantees.sql
```

```bash
psql "$DB_URL" -f supabase/tests/rls_isolation.sql
```

```bash
psql "$DB_URL" -f supabase/tests/workbook_parity.sql
```

`workbook_parity.sql` is the gate that decides whether this app can replace the
spreadsheet. It loads 16 real transactions and asserts:

```
Trial balance  7,45,000 Dr = 7,45,000 Cr
Total assets   7,20,000        Capital   7,45,000
Net loss         -25,000       Cash      1,00,000
CWIP           4,05,000        Advances    40,000    Deposits 1,00,000
```

---

## What the audit trail actually proves

The hash chain **detects** tampering. It does **not** prevent it — anyone holding the
service-role key could recompute the entire chain.

It becomes evidence a third party can rely on only once the nightly job writes the
chain's head hash into a Google Sheet **and** emails it to the CA, because two
independent copies cannot both be quietly rewritten. **That job is not built yet.**
Until it is, this is self-attestation. Do not describe it to investors as more than
that.

---

## Deploying

Static SPA. `public/_redirects` routes every path to `index.html`;
`public/_headers` sets the security headers.

```bash
npm run build
```

```bash
npx wrangler pages deploy dist --project-name books-app
```

Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` as build environment
variables. Both are **publishable** — they carry no privileges and every read and write
is still decided by RLS. The **service-role key must never** appear in this repo, in a
build environment variable, or in any bundle; CI fails the build if it finds one.

---

## Things that will bite you

- **Supabase free projects pause after ~7 days idle.** Fine while you use it daily,
  fatal the moment a real customer goes quiet for a week. Production means Pro.
- **Vercel Hobby forbids commercial use.** Hence Cloudflare Pages.
- **Turn on PITR** the day the first customer's real data lands. Then rehearse a
  restore *before* you need one.
- **Enable leaked-password protection** in Supabase Auth.
