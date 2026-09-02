import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../auth/AuthProvider";
import { CompanySetup } from "./CompanySetup";
import { useCompany } from "../company/CompanyProvider";
import {
  companyPeople,
  createInvite,
  investorMaster,
  lockPeriod,
  listInvites,
  periodLockStatus,
  removePerson,
  revokeInvite,
  setPersonRole,
  unlockPeriod,
  updateCompanyPlan,
} from "../../lib/queries";
import { inr, toPaise } from "../../lib/money";
import {
  Alert,
  Badge,
  Button,
  Card,
  Field,
  inputClass,
  SectionTitle,
  Skeleton,
} from "../../components/ui";
import { errorMessage } from "../../lib/errors";
import { clearPin, LOCK_AFTER_MINUTES, lockNow, pinIsSet, setPin } from "../../lib/pinLock";

/** Codes are fixed by the companies_legal_form_check constraint. */
const LEGAL_FORMS = [
  ["pvt_ltd", "Private Limited Company"],
  ["ltd", "Public Limited Company"],
  ["llp", "Limited Liability Partnership"],
  ["partnership", "Partnership"],
  ["proprietorship", "Sole Proprietorship"],
  ["trust", "Trust"],
  ["society", "Society"],
  ["other", "Other"],
] as const;

const ROLES = [
  ["owner", "Owner / CEO", "Runs everything. Can close periods, manage people and see both books."],
  ["accountant", "Accountant", "Posts entries, edits accounts, closes periods, sees both books."],
  ["project_coordinator", "Project coordinator", "Drafts entries and manages building work. Cannot post."],
  ["cashier", "Cashier", "Records receipts and payments only. Cannot see the ledger or reports."],
  ["investor", "Investor", "Sees their own money and whatever you publish. No access to the books."],
  ["auditor", "Auditor / CA", "Reads everything, writes nothing, ever."],
] as const;

export function Settings() {
  const { company, can, refetch } = useCompany();
  const qc = useQueryClient();

  if (!company) return <p className="text-sm text-muted">Create a company first.</p>;

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div>
        <h1 className="text-xl font-extrabold text-navy">Settings</h1>
        <p className="mt-0.5 text-sm text-muted">{company.name}</p>
      </div>

      <CompanyDetails
        company={company}
        canEdit={can("manage_company")}
        onSaved={() => {
          void qc.invalidateQueries();
          refetch();
        }}
      />

      <CompanySetup companyId={company.id} canEdit={can("manage_company")} />

      <LifecyclePhase
        company={company}
        canEdit={can("manage_company")}
        onSaved={() => {
          void qc.invalidateQueries();
          refetch();
        }}
      />

      <InvestmentPlan
        company={company}
        canEdit={can("manage_company")}
        onSaved={() => {
          void qc.invalidateQueries();
          refetch();
        }}
      />

      {can("close_period") && <PeriodLockSettings company={company} canUnlock={can("unlock_period")} />}

      <PinSettings />

      {can("manage_members") && <People companyId={company.id} />}

      {!can("manage_members") && (
        <Alert tone="info">
          Only an owner can manage people and company settings. Ask whoever set this company up.
        </Alert>
      )}

      <p className="pt-2 text-center text-xs text-muted">
        Version <span className="font-mono">{__BUILD_ID__}</span>
      </p>
    </div>
  );
}

/* ----------------------------------------------------------------------------
   Screen lock.

   Personal to this device, so it is not behind `manage_company` — everyone who
   uses the app on a phone should be able to lock their own copy of it.
   -------------------------------------------------------------------------- */
function PinSettings() {
  // Scoped to the user: `["has-pin"]` alone meant that on a shared browser the
  // next person to sign in was shown the previous person's answer.
  const { user } = useAuth();
  const userId = user?.id ?? "";
  const haveQ = useQuery({
    queryKey: ["has-pin", userId],
    queryFn: pinIsSet,
    enabled: !!userId,
  });
  const have = haveQ.data ?? false;
  const [mode, setMode] = useState<"idle" | "set" | "remove">("idle");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  // Without this the button gave no feedback at all: a slow save looked
  // identical to nothing happening, and a second click fired a second request.
  const [busy, setBusy] = useState(false);

  function reset() {
    setMode("idle");
    setCurrent("");
    setNext("");
    setAgain("");
    setError(null);
  }

  const digits = (v: string) => v.replace(/\D/g, "").slice(0, 8);

  async function save() {
    setError(null);
    setBusy(true);
    try {
      if (next.length < 4) throw new Error("Use at least 4 digits.");
      if (next !== again) throw new Error("The two PINs do not match.");
      // The server checks the current PIN — doing it here as well would only
      // be a second, weaker copy of the same rule.
      await setPin(next, userId, have ? current : undefined);
      // Read it back from the server rather than assuming: if this says false,
      // the PIN genuinely did not save and the user must be told so.
      const confirmed = await haveQ.refetch();
      if (confirmed.data !== true) {
        throw new Error("The PIN did not save. Check your connection and try again.");
      }
      setDone("PIN saved. It works on every device you sign in from.");
      reset();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setError(null);
    setBusy(true);
    try {
      await clearPin(current, userId);
      await haveQ.refetch();
      setDone("PIN removed. Nothing asks for it now.");
      reset();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-4 p-5">
      <SectionTitle>Your PIN</SectionTitle>

      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={have ? "ok" : "warn"}>{have ? "PIN is on" : "No PIN set"}</Badge>
        <span className="text-sm text-muted">
          {have
            ? `Asked for every time the app is opened or refreshed, and again after ${LOCK_AFTER_MINUTES} minutes idle.`
            : "Anyone who opens this app on your device can read and change the books."}
        </span>
      </div>

      {/* This list is checked against the database, not written from memory.
          It used to say the PIN guarded "any action that takes an entry out of
          the books" while only `void_entry` actually asked for it; correcting
          and cancelling asked for nothing. Migration 0045 made the sentence
          true rather than softening it. */}
      <Alert tone="info" title="What the PIN protects">
        Opening the app, and every action that undoes a posted entry — correcting one, cancelling
        one out, and removing one. All three ask, and the database is what asks, so it cannot be
        stepped around from outside the app. It belongs to <strong>you</strong>, not to this
        browser, so it follows you to your phone and survives clearing the cache. It is stored only
        as a one-way hash — nobody, including us, can read it back. Five wrong tries lock it for 15
        minutes.
        <br />
        <br />
        It is not a substitute for your email password: someone who knows that can still sign in.
        Keep both.
      </Alert>

      {done && <Alert tone="ok">{done}</Alert>}
      {error && <Alert tone="danger">{error}</Alert>}

      {mode === "idle" && (
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => {
              setDone(null);
              setMode("set");
            }}
          >
            {have ? "Change PIN" : "Set a PIN"}
          </Button>
          {have && (
            <Button
              variant="secondary"
              onClick={() => {
                setDone(null);
                setMode("remove");
              }}
            >
              Remove PIN
            </Button>
          )}
          {have && (
            <Button
              variant="secondary"
              onClick={() => {
                lockNow();
                window.location.reload();
              }}
            >
              Lock now
            </Button>
          )}
        </div>
      )}

      {mode === "set" && (
        <div className="space-y-3">
          {have && (
            <Field label="Current PIN" required>
              <input
                type="password"
                inputMode="numeric"
                className={inputClass}
                value={current}
                onChange={(e) => setCurrent(digits(e.target.value))}
              />
            </Field>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="New PIN" required hint="4 to 8 digits">
              <input
                type="password"
                inputMode="numeric"
                className={inputClass}
                value={next}
                onChange={(e) => setNext(digits(e.target.value))}
              />
            </Field>
            <Field label="Type it again" required>
              <input
                type="password"
                inputMode="numeric"
                className={inputClass}
                value={again}
                onChange={(e) => setAgain(digits(e.target.value))}
              />
            </Field>
          </div>
          <div className="flex gap-2">
            <Button onClick={() => void save()} disabled={busy || next.length < 4}>
              {busy ? "Saving…" : "Save PIN"}
            </Button>
            <Button variant="secondary" onClick={reset}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {mode === "remove" && (
        <div className="space-y-3">
          <Field label="Current PIN" required>
            <input
              type="password"
              inputMode="numeric"
              className={inputClass}
              value={current}
              onChange={(e) => setCurrent(digits(e.target.value))}
            />
          </Field>
          <div className="flex gap-2">
            <Button variant="danger" disabled={busy || current.length < 4} onClick={() => void remove()}>
              Remove PIN
            </Button>
            <Button variant="secondary" onClick={reset}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

/* ----------------------------------------------------------------------------
   Company legal details.

   None of this affects the ledger — it is what goes on a printed statement,
   a GST return, or an ROC filing. Kept optional and separate from the
   investment plan because a company usually has these BEFORE it has decided
   its funding shape, and sometimes the other way round.
   -------------------------------------------------------------------------- */
function CompanyDetails({
  company,
  canEdit,
  onSaved,
}: {
  company: NonNullable<ReturnType<typeof useCompany>["company"]>;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const [legalName, setLegalName] = useState(company.legal_name ?? "");
  const [legalForm, setLegalForm] = useState(company.legal_form ?? "");
  const [pan, setPan] = useState(company.pan ?? "");
  const [gstin, setGstin] = useState(company.gstin ?? "");
  const [cin, setCin] = useState(company.cin ?? "");
  const [stateCode, setStateCode] = useState(company.state_code ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      // Blank stays blank — an empty GSTIN before registration is a normal
      // state, not a value to store as "".
      const orNull = (v: string) => (v.trim() === "" ? null : v.trim());
      await updateCompanyPlan({
        id: company.id,
        legal_name: orNull(legalName),
        legal_form: orNull(legalForm),
        pan: orNull(pan.toUpperCase()),
        gstin: orNull(gstin.toUpperCase()),
        cin: orNull(cin.toUpperCase()),
        state_code: orNull(stateCode),
      });
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-4 p-5">
      <SectionTitle>Company details</SectionTitle>
      {/* Kept the "changes no entry" half: it is the reassurance that actually
          stops someone hesitating over a compliance field. The rest was filler. */}
      <p className="text-sm text-muted">Optional. Nothing here changes how an entry is recorded.</p>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Legal name" hint="As it appears on the incorporation certificate">
          <input
            className={inputClass}
            value={legalName}
            onChange={(e) => setLegalName(e.target.value)}
            disabled={!canEdit}
            placeholder={company.name}
          />
        </Field>
        <Field label="Legal form">
          {/* The VALUES here must match the companies_legal_form_check
              constraint exactly — sending the display label instead of the
              code failed the whole save, which is why an empty GSTIN looked
              like the culprit when it never was. */}
          <select
            className={inputClass}
            value={legalForm}
            onChange={(e) => setLegalForm(e.target.value)}
            disabled={!canEdit}
          >
            <option value="">Not set</option>
            {LEGAL_FORMS.map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="CIN" hint="Corporate Identity Number, issued by the MCA on incorporation">
          <input
            className={inputClass}
            value={cin}
            onChange={(e) => setCin(e.target.value)}
            disabled={!canEdit}
            placeholder="U01100TN2026PTC000000"
          />
        </Field>
        <Field label="PAN">
          <input
            className={inputClass}
            value={pan}
            onChange={(e) => setPan(e.target.value)}
            disabled={!canEdit}
            placeholder="ABCDE1234F"
          />
        </Field>
        <Field label="GSTIN" hint="Once registered — a restaurant usually registers before opening">
          <input
            className={inputClass}
            value={gstin}
            onChange={(e) => setGstin(e.target.value)}
            disabled={!canEdit}
            placeholder="33ABCDE1234F1Z5"
          />
        </Field>
        <Field label="State code" hint="The two digits GSTIN starts with — 33 for Tamil Nadu">
          <input
            className={inputClass}
            value={stateCode}
            onChange={(e) => setStateCode(e.target.value)}
            disabled={!canEdit}
            placeholder="33"
          />
        </Field>
      </div>

      {error && <Alert tone="danger">{error}</Alert>}
      {saved && !error && <Alert tone="ok">Saved.</Alert>}

      {canEdit && (
        <Button onClick={() => void save()} disabled={busy}>
          {busy ? "Saving…" : "Save details"}
        </Button>
      )}
    </Card>
  );
}

/* ----------------------------------------------------------------------------
   Which stage the business is in.

   This is the gate the owner is picturing when they ask "should sales be
   switched on yet" — capex, transition or operations. Honestly, right now it
   mainly changes one thing you'll notice: building/fit-out spend disappears
   from "Record something" once you move past transition, because by then it
   should be finished or capitalised, not still being paid for as a line item.
   A sales module gated the same way is the natural next thing to build once
   there is a till to connect it to — this setting is what that will hang off.
   -------------------------------------------------------------------------- */
const PHASES = [
  ["capex", "Building", "Before you have opened. Raising capital and spending it on the premises."],
  ["transition", "Opening up", "Construction is finishing. Getting ready for the first day of trading."],
  ["operations", "Trading", "Open and running. Day-to-day income and costs, not capital spend."],
] as const;

function LifecyclePhase({
  company,
  canEdit,
  onSaved,
}: {
  company: NonNullable<ReturnType<typeof useCompany>["company"]>;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function set(phase: "capex" | "transition" | "operations") {
    if (phase === company.lifecycle_phase) return;
    setBusy(true);
    setError(null);
    try {
      await updateCompanyPlan({ id: company.id, lifecycle_phase: phase });
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-4 p-5">
      <SectionTitle>Which stage are you in</SectionTitle>
      <div className="grid gap-2 sm:grid-cols-3">
        {PHASES.map(([key, label, body]) => (
          <button
            key={key}
            disabled={!canEdit || busy}
            onClick={() => void set(key)}
            className={`rounded-2xl border p-3 text-left transition-colors duration-200 disabled:opacity-60 ${
              company.lifecycle_phase === key
                ? "border-navy bg-navy/5"
                : "border-line hover:border-navy/50"
            }`}
          >
            <span className="flex items-center gap-1.5">
              <span className="text-sm font-bold text-ink">{label}</span>
              {company.lifecycle_phase === key && <Badge tone="gold">current</Badge>}
            </span>
            <span className="mt-0.5 block text-xs text-muted">{body}</span>
          </button>
        ))}
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      <p className="text-xs text-muted">
        Changes what is offered for new entries. Everything already recorded stays as it is.
      </p>
    </Card>
  );
}

/* ----------------------------------------------------------------------------
   Closing a period.

   Locks every date up to and including the one chosen: nobody without the
   right to reopen it can post, correct, or remove anything dated on or
   before it. An owner can still post through their own lock — this is a
   guard against everyone else, not a wall nobody including you can get past.
   -------------------------------------------------------------------------- */
function PeriodLockSettings({
  company,
  canUnlock,
}: {
  company: NonNullable<ReturnType<typeof useCompany>["company"]>;
  canUnlock: boolean;
}) {
  const { statutoryBook } = useCompany();
  const qc = useQueryClient();
  const [through, setThrough] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmUnlock, setConfirmUnlock] = useState(false);

  const statusQ = useQuery({
    queryKey: ["period-lock", company.id, statutoryBook?.id],
    queryFn: () => periodLockStatus(company.id, statutoryBook!.id),
    enabled: !!statutoryBook,
  });

  async function lock() {
    if (!statutoryBook || !through) return;
    setBusy(true);
    setError(null);
    try {
      await lockPeriod(company.id, statutoryBook.id, through);
      await statusQ.refetch();
      await qc.invalidateQueries();
      setThrough("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function unlock() {
    if (!statutoryBook) return;
    setBusy(true);
    setError(null);
    try {
      await unlockPeriod(company.id, statutoryBook.id);
      await statusQ.refetch();
      await qc.invalidateQueries();
      setConfirmUnlock(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const locked = statusQ.data;

  return (
    <Card className="space-y-4 p-5">
      <SectionTitle>Close a period</SectionTitle>
      {/* Kept: locking is irreversible-feeling and affects everyone on the
          team, so what it does to THEM has to be on screen. */}
      <p className="text-sm text-muted">
        Nobody can post, correct or remove anything dated on or before the locked day. Official
        books only. Lock after handing figures to your CA, so they never move underneath them.
      </p>

      {statusQ.isLoading ? (
        <Skeleton rows={1} />
      ) : locked?.locked_through ? (
        <Alert tone="warn" title={`Locked through ${new Date(locked.locked_through + "T00:00:00").toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}`}>
          Closed by {locked.locked_by_name ?? "someone"}
          {locked.locked_at &&
            ` on ${new Date(locked.locked_at).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}`}
          .
        </Alert>
      ) : (
        <Alert tone="ok">Nothing is locked. Every date is still open to correction.</Alert>
      )}

      {error && <Alert tone="danger">{error}</Alert>}

      <div className="flex flex-wrap items-end gap-2">
        <Field label="Lock everything up to and including">
          <input
            type="date"
            className={inputClass}
            value={through}
            onChange={(e) => setThrough(e.target.value)}
            max={new Date().toISOString().slice(0, 10)}
          />
        </Field>
        <Button onClick={() => void lock()} disabled={busy || !through}>
          {busy ? "Working…" : locked?.locked_through ? "Move the lock" : "Lock"}
        </Button>
      </div>

      {locked?.locked_through && canUnlock && (
        <div className="border-t border-line pt-3">
          {!confirmUnlock ? (
            <button
              onClick={() => setConfirmUnlock(true)}
              className="text-xs font-semibold text-danger underline underline-offset-2"
            >
              Reopen this period
            </button>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted">
                Anyone with posting access can then change anything in this period again. Sure?
              </span>
              <Button variant="danger" onClick={() => void unlock()} disabled={busy}>
                Yes, reopen it
              </Button>
              <Button variant="secondary" onClick={() => setConfirmUnlock(false)}>
                No
              </Button>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function InvestmentPlan({
  company,
  canEdit,
  onSaved,
}: {
  company: NonNullable<ReturnType<typeof useCompany>["company"]>;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const [target, setTarget] = useState(company.target_investment ?? "0");
  const [authorised, setAuthorised] = useState(company.authorised_capital ?? "0");
  const [share, setShare] = useState(!!company.show_internal_to_investors);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save(patch?: { show_internal_to_investors?: boolean }) {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await updateCompanyPlan({
        id: company.id,
        target_investment: target || "0",
        authorised_capital: authorised || "0",
        ...patch,
      });
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  let targetPaise = 0;
  try {
    targetPaise = toPaise(target || "0");
  } catch {
    targetPaise = 0;
  }

  return (
    <Card className="space-y-4 p-5">
      <SectionTitle>The investment plan</SectionTitle>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Total project investment"
          hint="What the whole project needs. Each investor's commitment comes from their share of this."
        >
          <input
            className={`${inputClass} text-right tnum`}
            inputMode="decimal"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            disabled={!canEdit}
          />
        </Field>
        <Field
          label="Authorised share capital"
          hint="From your legal documents. Money above this is usually recorded as repayable funding."
        >
          <input
            className={`${inputClass} text-right tnum`}
            inputMode="decimal"
            value={authorised}
            onChange={(e) => setAuthorised(e.target.value)}
            disabled={!canEdit}
          />
        </Field>
      </div>

      {targetPaise > 0 && (
        <p className="text-xs text-muted">
          A 20% share of {inr(targetPaise)} is a commitment of{" "}
          <strong className="text-ink">{inr(Math.round(targetPaise / 5))}</strong> per investor.
        </p>
      )}

      {canEdit && (
        <div className="rounded-xl border border-line p-3">
          <label className="flex cursor-pointer items-start gap-2.5">
            <input
              type="checkbox"
              checked={share}
              onChange={(e) => {
                setShare(e.target.checked);
                void save({ show_internal_to_investors: e.target.checked });
              }}
              className="mt-0.5"
            />
            <span>
              <span className="block text-sm font-semibold text-ink">
                Let investors see the internal book
              </span>
              <span className="mt-0.5 block text-xs text-muted">
                Off by default. Investors always see their own money and the official books; this
                also reveals internal-only entries to them. You can switch it back at any time —
                but anything they have already seen, they have seen.
              </span>
            </span>
          </label>
          {share && (
            <div className="mt-2">
              <Badge tone="warn">Investors can currently see the internal book</Badge>
            </div>
          )}
        </div>
      )}

      {error && <Alert tone="danger">{error}</Alert>}
      {saved && !error && <Alert tone="ok">Saved.</Alert>}

      {canEdit && (
        <Button onClick={() => void save()} disabled={busy}>
          {busy ? "Saving…" : "Save plan"}
        </Button>
      )}
    </Card>
  );
}

function People({ companyId }: { companyId: string }) {
  const qc = useQueryClient();
  const peopleQ = useQuery({
    queryKey: ["people", companyId],
    queryFn: () => companyPeople(companyId),
  });
  const invitesQ = useQuery({
    queryKey: ["invites", companyId],
    queryFn: () => listInvites(companyId),
  });
  const investorsQ = useQuery({
    queryKey: ["investor-master", companyId],
    queryFn: () => investorMaster(companyId),
  });

  const [email, setEmail] = useState("");
  const [role, setRole] = useState("investor");
  const [investorId, setInvestorId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const people = peopleQ.data ?? [];
  const invites = (invitesQ.data ?? []).filter((i) => !i.claimed_at);
  const investors = investorsQ.data ?? [];
  const linked = new Set(people.map((p) => p.investor_name).filter(Boolean));

  return (
    <>
      <Card className="space-y-4 p-5">
        <SectionTitle>Invite someone</SectionTitle>
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              await createInvite({
                company_id: companyId,
                email,
                role_key: role,
                investor_id: role === "investor" && investorId ? investorId : null,
              });
              setEmail("");
              setInvestorId("");
              await qc.invalidateQueries({ queryKey: ["invites", companyId] });
            } catch (err) {
              setError(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Their email" required>
              <input
                type="email"
                required
                className={inputClass}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="anand@example.com"
              />
            </Field>
            <Field label="What can they do?">
              <select className={inputClass} value={role} onChange={(e) => setRole(e.target.value)}>
                {ROLES.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <p className="text-xs text-muted">{ROLES.find(([v]) => v === role)?.[2]}</p>

          {role === "investor" && (
            <Field
              label="Which investor is this?"
              hint="Links their login to their capital account, so they see their own money"
            >
              <select
                className={inputClass}
                value={investorId}
                onChange={(e) => setInvestorId(e.target.value)}
              >
                <option value="">Not linked to an investor record</option>
                {investors.map((i) => (
                  <option key={i.investor_id} value={i.investor_id}>
                    {i.name}
                    {linked.has(i.name) ? " (already has a login)" : ""}
                  </option>
                ))}
              </select>
            </Field>
          )}

          {error && <Alert tone="danger">{error}</Alert>}

          <Alert tone="info">
            They sign up at this site with that exact email address and are added automatically on
            their first login. No invitation email is sent from here — send them the link yourself.
          </Alert>

          <Button type="submit" disabled={busy || !email.trim()}>
            {busy ? "Saving…" : "Create invitation"}
          </Button>
        </form>
      </Card>

      {invites.length > 0 && (
        <Card className="p-5">
          <SectionTitle>Waiting to join</SectionTitle>
          <div className="space-y-2">
            {invites.map((i) => (
              <div
                key={i.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line p-3"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold text-ink">{i.email}</span>
                  <span className="text-xs text-muted">
                    {ROLES.find(([v]) => v === i.role_key)?.[1] ?? i.role_key} · invited{" "}
                    {new Date(i.invited_at).toLocaleDateString("en-IN")}
                  </span>
                </span>
                <button
                  className="text-xs font-semibold text-danger"
                  onClick={async () => {
                    await revokeInvite(i.id);
                    await qc.invalidateQueries({ queryKey: ["invites", companyId] });
                  }}
                >
                  Cancel
                </button>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card className="p-5">
        <SectionTitle>People with access</SectionTitle>
        {peopleQ.isLoading ? (
          <Skeleton rows={3} />
        ) : (
          <div className="space-y-2">
            {people.map((p) => (
              <div
                key={p.user_id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line p-3"
              >
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-bold text-ink">
                      {p.full_name || p.email}
                    </span>
                    {p.is_you && <Badge tone="gold">you</Badge>}
                    {p.investor_name && <Badge tone="info">{p.investor_name}</Badge>}
                  </span>
                  <span className="block truncate text-xs text-muted">{p.email}</span>
                </span>
                <span className="flex items-center gap-2">
                  <select
                    className={`${inputClass} w-auto py-1.5 text-xs`}
                    value={p.role_key}
                    disabled={p.is_you}
                    onChange={async (e) => {
                      await setPersonRole(companyId, p.user_id, e.target.value);
                      await qc.invalidateQueries();
                    }}
                  >
                    {ROLES.map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                  {!p.is_you && (
                    <button
                      className="text-xs font-semibold text-danger"
                      onClick={async () => {
                        await removePerson(companyId, p.user_id);
                        await qc.invalidateQueries();
                      }}
                    >
                      Remove
                    </button>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
        {/* Kept: states a limit the software enforces, which would otherwise
            look like a bug when the control is missing. */}
        <p className="mt-3 text-xs text-muted">
          You cannot change your own access — that is what stops a company locking everyone out.
        </p>
      </Card>
    </>
  );
}
