import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../company/CompanyProvider";
import {
  checkBackup,
  exportSnapshot,
  listAccounts,
  listBackups,
  recordBackup,
  saveJournalEntry,
  type BackupCheck,
  type Snapshot,
} from "../../lib/queries";
import { parseAmount, parseCsv, parseDate, pick, toObjects } from "../../lib/csv";
import { downloadBlob, exportWorkbook } from "../../lib/exportBooks";
import { inr, toPaise } from "../../lib/money";
import { moneyAccounts } from "../../lib/recipes";
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

type Draft = {
  n: number;
  date: string | null;
  narration: string;
  party: string;
  debit: string | null;
  credit: string | null;
  problem: string | null;
};

/**
 * Import and export.
 *
 * The import NEVER writes straight from the file. It parses, shows exactly what
 * it understood, names every row it could not read, and only then offers to
 * post. Importing silently is how a set of books quietly acquires wrong data.
 */
export function ImportExport() {
  const { company, statutoryBook, activeBookId, can } = useCompany();

  if (!company) return <p className="text-sm text-muted">Create a company first.</p>;

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div>
        <h1 className="text-xl font-extrabold text-navy">Backup, import and export</h1>
        <p className="mt-0.5 text-sm text-muted">
          Keep your own copy of everything, bring old records in, and take the books out whenever you
          want.
        </p>
      </div>

      <BackupCard company={company} />
      <ExportCard company={company} bookId={activeBookId ?? statutoryBook?.id ?? ""} />
      {can("import_data") && <ImportCard companyId={company.id} bookId={statutoryBook?.id ?? ""} />}
    </div>
  );
}

/* ----------------------------------------------------------------------------
   Backup.

   A complete copy of this company — every entry, every line, every account,
   plus the audit-trail fingerprint of each book — as one JSON file that lives
   on the owner's own disk. Nothing about it depends on this app continuing to
   exist.

   There is deliberately no "restore" button. Restoring would mean writing to
   the ledger without going through the one function that enforces balance,
   gapless voucher numbers, period locks and the hash chain — and books that
   arrived by a side door are exactly what this system exists to prevent.
   -------------------------------------------------------------------------- */
function BackupCard({ company }: { company: NonNullable<ReturnType<typeof useCompany>["company"]> }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checks, setChecks] = useState<BackupCheck[] | null>(null);
  const [checkedFile, setCheckedFile] = useState("");

  const logQ = useQuery({
    queryKey: ["backups", company.id],
    queryFn: () => listBackups(company.id),
  });
  const last = (logQ.data ?? []).find((b) => b.kind === "snapshot");
  const daysOld = last
    ? Math.floor((Date.now() - new Date(last.taken_at).getTime()) / 86_400_000)
    : null;

  async function takeBackup() {
    setBusy(true);
    setError(null);
    setChecks(null);
    try {
      const snap = await exportSnapshot(company.id);
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      const name = `${company.name.replace(/[^\w -]/g, "")} backup ${stamp}.json`;
      downloadBlob(
        new Blob([JSON.stringify(snap, null, 2)], { type: "application/json" }),
        name,
      );
      // Logged only after the file has actually been produced, so the record
      // never claims a backup that does not exist.
      await recordBackup(
        company.id,
        "snapshot",
        Array.isArray(snap.entries) ? snap.entries.length : 0,
        snap.integrity?.[0]?.head_hash ?? null,
      );
      await qc.invalidateQueries({ queryKey: ["backups", company.id] });
      await qc.invalidateQueries({ queryKey: ["alerts"] });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function verifyFile(f: File) {
    setBusy(true);
    setError(null);
    setChecks(null);
    setCheckedFile(f.name);
    try {
      const parsed = JSON.parse(await f.text()) as Snapshot;
      if (parsed.format !== "books-app-snapshot") {
        throw new Error("That is not a backup file from this app.");
      }
      if (parsed.company_id !== company.id) {
        throw new Error("That backup belongs to a different company.");
      }
      setChecks(await checkBackup(company.id, parsed.integrity ?? []));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-4 p-5">
      <SectionTitle>Backup</SectionTitle>

      {daysOld === null ? (
        <Alert tone="warn" title="You have never taken a backup">
          One file, kept somewhere this app cannot reach, is the only thing that protects you if an
          account is lost or a service goes down.
        </Alert>
      ) : daysOld > 7 ? (
        <Alert tone="warn" title={`Your last backup is ${daysOld} days old`}>
          Taken by {last!.taken_by_name ?? "someone"} with {last!.entry_count} entries in it. Take a
          fresh one.
        </Alert>
      ) : (
        <Alert tone="ok" title={daysOld === 0 ? "Backed up today" : `Backed up ${daysOld} day${daysOld === 1 ? "" : "s"} ago`}>
          {last!.entry_count} entries, taken by {last!.taken_by_name ?? "someone"}.
        </Alert>
      )}

      <p className="text-sm text-muted">
        This is a complete copy of everything in this company — every entry and every line, your
        accounts, parties, investors, projects and bills, plus the audit-trail fingerprint of each
        book. Keep it on your own computer, and put a copy somewhere else too: a pen drive, or Drive,
        or email it to yourself.
      </p>

      {error && <Alert tone="danger">{error}</Alert>}

      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={takeBackup}>
          {busy ? "Working…" : "Take a backup now"}
        </Button>
        <label className="cursor-pointer rounded-xl border border-line px-4 py-2 text-sm font-semibold text-ink hover:bg-canvas">
          Check a backup file
          <input
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void verifyFile(f);
              e.target.value = "";
            }}
          />
        </label>
      </div>

      {checks && (
        <div className="space-y-2">
          <p className="text-sm font-bold text-ink">{checkedFile}</p>
          {checks.map((c) => (
            <Alert key={c.book_name} tone={c.matches ? "ok" : "warn"} title={c.book_name}>
              {c.detail}
            </Alert>
          ))}
          <p className="text-xs text-muted">
            This compares the file's fingerprint against the database as it stands right now. Matching
            means neither has been altered. A different entry count just means you have carried on
            working since the backup — that is normal.
          </p>
        </div>
      )}

      <details className="rounded-xl border border-line bg-canvas p-3">
        <summary className="cursor-pointer text-sm font-semibold text-ink">
          What if I ever need to use this file?
        </summary>
        <p className="mt-2 text-sm text-muted">
          The file is plain JSON, so any accountant or developer can read it and any system can be
          loaded from it. There is no one-click restore inside this app on purpose: putting entries
          back without going through the normal checks is how a set of books quietly ends up not
          adding up. If you ever need to rebuild, start a fresh company and import — slower, but the
          result is books that are provably correct.
        </p>
      </details>

      {(logQ.data ?? []).length > 0 && (
        <details className="rounded-xl border border-line p-3">
          <summary className="cursor-pointer text-sm font-semibold text-ink">
            Backup history
          </summary>
          <ul className="mt-2 space-y-1">
            {(logQ.data ?? []).map((b) => (
              <li key={b.id} className="flex flex-wrap justify-between gap-2 text-xs text-muted">
                <span>
                  {new Date(b.taken_at).toLocaleString("en-IN", {
                    day: "2-digit",
                    month: "short",
                    year: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                  {" · "}
                  {b.kind === "snapshot" ? "Full backup" : "Excel export"}
                </span>
                <span>
                  {b.taken_by_name ?? "—"}
                  {b.entry_count ? ` · ${b.entry_count} entries` : ""}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">
            This history cannot be edited or deleted by anyone, including an owner.
          </p>
        </details>
      )}
    </Card>
  );
}

function ExportCard({
  company,
  bookId,
}: {
  company: NonNullable<ReturnType<typeof useCompany>["company"]>;
  bookId: string;
}) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Card className="space-y-4 p-5">
      <SectionTitle>Take your books out</SectionTitle>
      <p className="text-sm text-muted">
        One Excel file with every sheet an accountant expects: the full journal line by line, trial
        balance, chart of accounts, cash and bank book, parties, bills and investors.
      </p>
      <Alert tone="info">
        This is your escape hatch. If this app ever disappears, your books still exist in a form
        anyone can open. Take a copy whenever you like — you do not need our permission or our
        servers to read it.
      </Alert>
      {error && <Alert tone="danger">{error}</Alert>}
      <Button
        disabled={busy || !bookId}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const blob = await exportWorkbook(company, bookId);
            const stamp = new Date().toISOString().slice(0, 10);
            downloadBlob(blob, `${company.name.replace(/[^\w -]/g, "")} books ${stamp}.xlsx`);
            // Logged as an export, not a backup — it does not satisfy the
            // backup reminder, because a spreadsheet drops the audit trail.
            await recordBackup(company.id, "excel", 0, null);
            await qc.invalidateQueries({ queryKey: ["backups", company.id] });
          } catch (err) {
            setError(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Preparing…" : "Download Excel file"}
      </Button>
    </Card>
  );
}

function ImportCard({ companyId, bookId }: { companyId: string; bookId: string }) {
  const qc = useQueryClient();
  const accountsQ = useQuery({
    queryKey: ["accounts", companyId],
    queryFn: () => listAccounts(companyId),
  });
  const accounts = accountsQ.data ?? [];
  // The importer always posts to the statutory book, so internal-only cash
  // must not be offered here at all.
  const money = moneyAccounts(accounts).filter((a) => !a.restricted_to_book_id);

  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [fileName, setFileName] = useState("");
  const [moneyAccount, setMoneyAccount] = useState("");
  const [counterAccount, setCounterAccount] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const postable = (drafts ?? []).filter((d) => !d.problem);
  const broken = (drafts ?? []).filter((d) => d.problem);
  const totalDr = postable.reduce((n, d) => n + (d.debit ? toPaise(d.debit) : 0), 0);
  const totalCr = postable.reduce((n, d) => n + (d.credit ? toPaise(d.credit) : 0), 0);

  async function onFile(f: File) {
    setError(null);
    setResult(null);
    setFileName(f.name);
    try {
      const rows = toObjects(parseCsv(await f.text()));
      const out: Draft[] = rows.map((r, i) => {
        const date = parseDate(pick(r, "date", "txndate", "entrydate", "voucherdate"));
        const narration = pick(r, "narration", "particulars", "description", "details", "remarks");
        const party = pick(r, "party", "ledger", "vendor", "supplier", "name", "account");
        const debit = parseAmount(pick(r, "debit", "debitamount", "dr", "withdrawal", "paid"));
        const credit = parseAmount(pick(r, "credit", "creditamount", "cr", "deposit", "received"));

        let problem: string | null = null;
        if (!date) problem = "could not read the date";
        else if (!debit && !credit) problem = "no amount found";
        else if (debit && credit) problem = "has both a debit and a credit";
        else if (!narration && !party) problem = "no narration or party to identify it";

        return { n: i + 2, date, narration, party, debit, credit, problem };
      });
      setDrafts(out);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function commit() {
    if (!moneyAccount || !counterAccount) return;
    setBusy(true);
    setError(null);
    let ok = 0;
    const failures: string[] = [];
    try {
      for (const d of postable) {
        const amt = (d.debit ?? d.credit)!.replace("-", "");
        // A credit column on a bank statement is money IN, so the bank is debited.
        const bankIsDebit = !!d.credit;
        try {
          await saveJournalEntry({
            company_id: companyId,
            book_id: bookId,
            voucher_type: bankIsDebit ? "receipt" : "payment",
            entry_date: d.date!,
            narration: d.narration || d.party || "Imported entry",
            status: "posted",
            source: "import",
            idempotency_key: `import:${fileName}:${d.n}`,
            lines: bankIsDebit
              ? [
                  { account_id: moneyAccount, debit: amt },
                  { account_id: counterAccount, credit: amt },
                ]
              : [
                  { account_id: counterAccount, debit: amt },
                  { account_id: moneyAccount, credit: amt },
                ],
          });
          ok++;
        } catch (err) {
          failures.push(`row ${d.n}: ${errorMessage(err)}`);
        }
      }
      await qc.invalidateQueries();
      setResult(
        `${ok} of ${postable.length} rows posted.` +
          (failures.length ? ` ${failures.length} refused: ${failures.slice(0, 3).join("; ")}` : ""),
      );
      setDrafts(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-4 p-5">
      <SectionTitle>Bring records in</SectionTitle>
      <p className="text-sm text-muted">
        A CSV from your old spreadsheet, Tally, or a bank statement. Columns are matched by name, so
        “Date / Particulars / Debit / Credit” or “Txn Date / Narration / Withdrawal / Deposit” both
        work.
      </p>

      <input
        type="file"
        accept=".csv,text/csv"
        className={inputClass}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void onFile(f);
        }}
      />

      {accountsQ.isLoading && <Skeleton rows={2} />}

      {drafts && (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Which bank or cash account is this?" required>
              <select
                className={inputClass}
                value={moneyAccount}
                onChange={(e) => setMoneyAccount(e.target.value)}
              >
                <option value="">Choose…</option>
                {money.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Post the other side to"
              required
              hint="You can reclassify individual entries afterwards"
            >
              <select
                className={inputClass}
                value={counterAccount}
                onChange={(e) => setCounterAccount(e.target.value)}
              >
                <option value="">Choose…</option>
                {accounts
                  .filter((a) => !a.is_group && !a.is_bank_or_cash)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} · {a.name}
                    </option>
                  ))}
              </select>
            </Field>
          </div>

          <div className="flex flex-wrap gap-2">
            <Badge tone="ok">{postable.length} ready</Badge>
            {broken.length > 0 && <Badge tone="danger">{broken.length} could not be read</Badge>}
            <Badge>Money in {inr(totalCr)}</Badge>
            <Badge>Money out {inr(totalDr)}</Badge>
          </div>

          {broken.length > 0 && (
            <Alert tone="warn" title="These rows will be skipped">
              {broken.slice(0, 5).map((d) => (
                <div key={d.n}>
                  Row {d.n}: {d.problem}
                </div>
              ))}
              {broken.length > 5 && <div>…and {broken.length - 5} more.</div>}
              Nothing is guessed — fix them in the file and import again, or enter them by hand.
            </Alert>
          )}

          <div className="max-h-72 overflow-auto rounded-xl border border-line">
            <table className="w-full min-w-[34rem] text-sm">
              <thead className="sticky top-0 bg-canvas">
                <tr className="text-xs tracking-wide text-muted uppercase">
                  <th className="px-3 py-2 text-left font-bold">Row</th>
                  <th className="px-3 py-2 text-left font-bold">Date</th>
                  <th className="px-3 py-2 text-left font-bold">Narration</th>
                  <th className="px-3 py-2 text-right font-bold">Out</th>
                  <th className="px-3 py-2 text-right font-bold">In</th>
                </tr>
              </thead>
              <tbody>
                {drafts.slice(0, 200).map((d) => (
                  <tr
                    key={d.n}
                    className={`border-t border-line ${d.problem ? "bg-dangerbg" : ""}`}
                  >
                    <td className="px-3 py-1.5 text-muted tnum">{d.n}</td>
                    <td className="px-3 py-1.5 tnum">{d.date ?? "—"}</td>
                    <td className="max-w-[16rem] truncate px-3 py-1.5">
                      {d.problem ? (
                        <span className="text-danger">{d.problem}</span>
                      ) : (
                        d.narration || d.party
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right tnum">
                      {d.debit ? inr(toPaise(d.debit)) : "—"}
                    </td>
                    <td className="px-3 py-1.5 text-right tnum">
                      {d.credit ? inr(toPaise(d.credit)) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Alert tone="info">
            Importing the same file twice will not create duplicates — each row carries a key made
            from the file name and its row number.
          </Alert>

          <div className="flex gap-2">
            <Button
              onClick={commit}
              disabled={busy || !moneyAccount || !counterAccount || postable.length === 0}
            >
              {busy ? "Posting…" : `Post ${postable.length} entries`}
            </Button>
            <Button variant="secondary" onClick={() => setDrafts(null)}>
              Cancel
            </Button>
          </div>
        </>
      )}

      {result && <Alert tone="ok">{result}</Alert>}
      {error && <Alert tone="danger">{error}</Alert>}
    </Card>
  );
}
