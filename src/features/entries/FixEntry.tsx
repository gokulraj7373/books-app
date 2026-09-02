import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../auth/AuthProvider";
import { useCompany } from "../company/CompanyProvider";
import { amendEntry, entryDetail, listAccounts, reverseEntry, voidEntry } from "../../lib/queries";
import { pinIsSet } from "../../lib/pinLock";
import { Alert, Button, Field, inputClass, Skeleton } from "../../components/ui";
import { errorMessage } from "../../lib/errors";

/* ============================================================================
   Correcting a posted entry.

   A posted entry is never edited and never deleted — that is the whole basis on
   which these books can be trusted. Correcting means posting an equal and
   opposite entry today, with a reason, and then recording the right version.
   Both stay on the record.

   This is exactly how Tally, Zoho and every audited system handle it. It is
   also why "I can't change a wrong entry" is not a limitation: you can, and the
   correction is visible rather than silent.

   Shared by the entries list (inline "Fix" button) and the voucher overlay
   (click any voucher number, anywhere) — one panel, one code path, so a fix
   made from a party statement behaves identically to one made from the ledger.
   -------------------------------------------------------------------------- */
type Mode = "menu" | "edit" | "cancel" | "remove";

export function FixEntry({
  entryId,
  voucherNo,
  narration,
  onClose,
  onDone,
}: {
  entryId: string;
  voucherNo: string;
  narration: string;
  onClose: () => void;
  /** called after a successful action, with the plain-English result */
  onDone?: (message: string) => void;
}) {
  const qc = useQueryClient();
  const { company } = useCompany();
  const { user } = useAuth();
  // Whether to ask for a PIN at all. The server treats a user with no PIN as
  // already authorised, so asking them for one would be a field they can never
  // satisfy. Defaults to false while the answer is loading, which only means
  // the button stays enabled — the server still decides.
  const hasPinQ = useQuery({
    queryKey: ["has-pin", user?.id ?? ""],
    queryFn: pinIsSet,
    enabled: !!user,
  });
  const hasPin = hasPinQ.data === true;
  const [mode, setMode] = useState<Mode>("menu");
  const [reason, setReason] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState("");
  const [narrationEdit, setNarrationEdit] = useState("");
  const [debitId, setDebitId] = useState("");
  const [creditId, setCreditId] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const detailQ = useQuery({
    queryKey: ["entry-detail", entryId],
    queryFn: () => entryDetail(entryId),
  });
  const accountsQ = useQuery({
    queryKey: ["accounts", company?.id],
    queryFn: () => listAccounts(company!.id),
    enabled: !!company,
  });
  const accounts = (accountsQ.data ?? []).filter((a) => !a.is_group && a.is_active);

  useEffect(() => {
    const d = detailQ.data;
    if (!d) return;
    const dr = d.lines.find((l) => Number(l.debit) > 0);
    const cr = d.lines.find((l) => Number(l.credit) > 0);
    setAmount(dr ? String(Number(dr.debit)) : "");
    setDate(d.entry_date);
    setNarrationEdit(d.narration ?? "");
    setDebitId(dr?.account_id ?? "");
    setCreditId(cr?.account_id ?? "");
  }, [detailQ.data]);

  const splitEntry = (detailQ.data?.lines.length ?? 2) !== 2;
  const canRun = reason.trim().length >= 3;

  async function run(fn: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await qc.invalidateQueries();
      setDone(message);
      onDone?.(message);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="space-y-3 p-5">
        <Alert tone="ok" title={`${voucherNo} sorted`}>
          {done}
        </Alert>
        <div className="flex flex-wrap gap-2">
          <Link to="/entry/new">
            <Button>Record something else</Button>
          </Link>
          <Button variant="secondary" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3 p-5">
      <div>
        <p className="text-sm font-bold text-ink">Fix {voucherNo}</p>
        <p className="mt-0.5 text-sm text-muted">{narration}</p>
      </div>

      {mode === "menu" && (
        <>
          <div className="space-y-2">
            <FixOption
              title="Something in it is wrong"
              body="Change the amount, the date, the wording, or which accounts it went between. The old version is cancelled and the corrected one posted, in one step."
              onClick={() => setMode("edit")}
            />
            <FixOption
              title="Start it again from scratch"
              body="Cancels it out and leaves you to record it fresh. Use this for an entry with more than two lines, like a bill."
              onClick={() => setMode("cancel")}
            />
            <FixOption
              title="This should never have been entered"
              body="Removes it from every report completely. Needs your PIN, and what it said is kept on the record."
              danger
              onClick={() => setMode("remove")}
            />
          </div>
          <Button variant="secondary" onClick={onClose}>
            Leave it alone
          </Button>
        </>
      )}

      {mode !== "menu" && (
        <>
          {mode === "edit" && (
            <>
              <Alert tone="info" title="What happens">
                Change anything below. The old version is cancelled and the corrected one posted,
                both dated and linked. It behaves like editing, but nothing disappears — which is
                what keeps the books acceptable to your CA.
              </Alert>

              {detailQ.isLoading ? (
                <Skeleton rows={4} />
              ) : splitEntry ? (
                <Alert tone="warn" title="This entry has more than two lines">
                  A bill with several items has no single amount to change. Use “Start it again from
                  scratch” instead.
                </Alert>
              ) : (
                <>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Amount" required>
                      <input
                        className={`${inputClass} text-right tnum`}
                        inputMode="decimal"
                        placeholder="0.00"
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                      />
                    </Field>
                    <Field label="Date">
                      <input
                        type="date"
                        className={inputClass}
                        value={date}
                        onChange={(e) => setDate(e.target.value)}
                      />
                    </Field>
                  </div>

                  <Field label="What it was for">
                    <input
                      className={inputClass}
                      value={narrationEdit}
                      onChange={(e) => setNarrationEdit(e.target.value)}
                    />
                  </Field>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Where it went to" hint="What you got, or who owes you">
                      <select
                        className={inputClass}
                        value={debitId}
                        onChange={(e) => setDebitId(e.target.value)}
                      >
                        {accounts.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.code} · {a.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Where it came from" hint="The bank, cash, or who you now owe">
                      <select
                        className={inputClass}
                        value={creditId}
                        onChange={(e) => setCreditId(e.target.value)}
                      >
                        {accounts.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.code} · {a.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                </>
              )}
            </>
          )}

          {mode === "cancel" && (
            <Alert tone="info" title="What happens">
              An opposite entry is posted today, cancelling this one out of every report. Both stay
              visible. You then record the right version.
            </Alert>
          )}

          {mode === "remove" && (
            <Alert tone="warn" title="Read this first">
              The entry leaves every report — trial balance, ledgers, balance sheet, all of it. What
              it said, who removed it, when and why is kept permanently and cannot be edited or
              deleted by anyone, including you. That record is what lets your auditor accept the rest
              of the books.
            </Alert>
          )}

          <Field
            label={mode === "remove" ? "Why should this go?" : "Why is this being corrected?"}
            required
            hint="Your CA will read this in a year's time"
          >
            <input
              className={inputClass}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={
                mode === "edit"
                  ? "e.g. typed 50,000 instead of 35,000"
                  : "e.g. entered twice by mistake"
              }
            />
          </Field>

          {/* Asked for on ALL THREE actions, not just removal. Correcting and
              cancelling both undo a posted voucher, which is precisely what
              Settings tells the owner the PIN is there to protect. It used to
              be asked only on "remove", which made that promise untrue.

              Shown only to people who actually have a PIN — the server accepts
              anything from a user who has not set one, so demanding a field
              they cannot fill would be theatre. */}
          {hasPin && (
            <Field
              label="Your PIN"
              required
              hint="This undoes a posted entry, so it needs your PIN"
            >
              <input
                type="password"
                inputMode="numeric"
                className={inputClass}
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))}
              />
            </Field>
          )}

          {error && <Alert tone="danger">{error}</Alert>}

          <div className="flex flex-wrap gap-2">
            <Button
              variant="danger"
              disabled={
                busy ||
                !canRun ||
                (mode === "edit" && (!amount.trim() || splitEntry)) ||
                (hasPin && pin.length < 4)
              }
              onClick={() => {
                if (mode === "edit") {
                  void run(
                    () =>
                      amendEntry(
                        entryId,
                        {
                          reason: reason.trim(),
                          amount: amount.trim(),
                          date: date || undefined,
                          narration: narrationEdit.trim() || undefined,
                          debitAccountId: debitId || undefined,
                          creditAccountId: creditId || undefined,
                        },
                        pin,
                      ),
                    "The old version has been cancelled and the corrected entry posted. Both are on the record.",
                  );
                } else if (mode === "cancel") {
                  void run(
                    () => reverseEntry(entryId, reason.trim(), pin),
                    "Cancelled out. Record the right version when you are ready.",
                  );
                } else {
                  void run(
                    () => voidEntry(entryId, reason.trim(), pin),
                    "Removed from every report. What it said is kept on the record.",
                  );
                }
              }}
            >
              {busy
                ? "Working…"
                : mode === "edit"
                  ? "Save the correction"
                  : mode === "cancel"
                    ? "Cancel this entry out"
                    : "Remove it"}
            </Button>
            <Button variant="secondary" onClick={() => setMode("menu")}>
              Back
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function FixOption({
  title,
  body,
  danger,
  onClick,
}: {
  title: string;
  body: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`block w-full rounded-2xl border p-4 text-left transition-[border-color,transform] duration-200 active:scale-[0.99] ${
        danger ? "border-danger/30 bg-dangerbg hover:border-danger" : "border-line hover:border-navy"
      }`}
    >
      <span className={`block text-sm font-bold ${danger ? "text-danger" : "text-ink"}`}>
        {title}
      </span>
      <span className="mt-0.5 block text-xs text-muted">{body}</span>
    </button>
  );
}
