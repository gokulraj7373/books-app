import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  companyConfig,
  listFeatureKeys,
  setCompanyConfig,
  type CompanyConfig,
} from "../../lib/queries";
import { Alert, Button, Card, Field, inputClass, SectionTitle, Skeleton } from "../../components/ui";
import { errorMessage } from "../../lib/errors";

/* ============================================================================
   What kind of business this is — and therefore which parts of the app exist.

   THE PRINCIPLE
   A business that is not registered for GST should never see the letters GST.
   Not greyed out, not hidden behind a toggle — absent. Every field the owner
   has to read and skip is a small tax on using the software, and an invitation
   to record something wrong.

   That is what makes this a product any Indian business can use rather than
   one restaurant's books: nothing is assumed about the trade, and each owner
   turns on only what they actually do.
   ========================================================================= */

const REGIMES: [CompanyConfig["gst_regime"], string, string][] = [
  ["unregistered", "Not registered for GST", "Turnover below the threshold, or not registered yet. No GST anywhere in the app."],
  ["regular", "Registered — normal scheme", "You charge GST and claim input credit on what you buy."],
  ["composition", "Registered — composition scheme", "You pay a flat rate on turnover and cannot claim input credit."],
];

export function CompanySetup({ companyId, canEdit }: { companyId: string; canEdit: boolean }) {
  const qc = useQueryClient();
  const cfgQ = useQuery({
    queryKey: ["company-config", companyId],
    queryFn: () => companyConfig(companyId),
  });
  const featQ = useQuery({ queryKey: ["feature-keys"], queryFn: listFeatureKeys });

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [draft, setDraft] = useState<Partial<CompanyConfig> | null>(null);

  if (cfgQ.isLoading || featQ.isLoading) return <Skeleton rows={5} />;
  const cfg = cfgQ.data;
  if (!cfg) return null;

  const v = { ...cfg, ...draft } as CompanyConfig;
  const set = <K extends keyof CompanyConfig>(k: K, val: CompanyConfig[K]) =>
    setDraft((d) => ({ ...d, [k]: val }));

  async function save(patch: Omit<Parameters<typeof setCompanyConfig>[0], "company_id">) {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await setCompanyConfig({ ...patch, company_id: companyId });
      await qc.invalidateQueries({ queryKey: ["company-config", companyId] });
      setDraft(null);
      setDone("Saved.");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-5 p-5">
      <div>
        <SectionTitle>What kind of business is this?</SectionTitle>
        <p className="text-sm text-muted">
          This decides what the app shows you. Nothing here changes a single entry you have already
          recorded.
        </p>
      </div>

      {/* ---------------------------------------------------------- GST ---- */}
      <div className="space-y-2">
        <p className="text-sm font-bold text-ink">GST</p>
        {REGIMES.map(([key, label, blurb]) => (
          <label
            key={key}
            className={`flex cursor-pointer items-start gap-2.5 rounded-xl border p-3 ${
              v.gst_regime === key ? "border-navy bg-navy/5" : "border-line"
            }`}
          >
            <input
              type="radio"
              name="gst_regime"
              checked={v.gst_regime === key}
              disabled={!canEdit}
              onChange={() => set("gst_regime", key)}
              className="mt-0.5"
            />
            <span>
              <span className="block text-sm font-semibold text-ink">{label}</span>
              <span className="mt-0.5 block text-xs text-muted">{blurb}</span>
            </span>
          </label>
        ))}

        {v.gst_regime !== "unregistered" && (
          <div className="grid gap-4 pt-1 sm:grid-cols-2">
            <Field
              label="Registered from"
              required
              hint="Input credit cannot be claimed on anything bought before this date."
            >
              <input
                type="date"
                className={inputClass}
                disabled={!canEdit}
                value={v.gst_registered_from ?? ""}
                onChange={(e) => set("gst_registered_from", e.target.value)}
              />
            </Field>
            {v.gst_regime === "composition" && (
              <Field label="Composition rate" required hint="e.g. 1% for a trader, 5% for a restaurant.">
                <div className="relative">
                  <input
                    className={`${inputClass} pr-8 tnum`}
                    inputMode="decimal"
                    disabled={!canEdit}
                    value={
                      v.composition_rate_bps === null || v.composition_rate_bps === undefined
                        ? ""
                        : String(v.composition_rate_bps / 100)
                    }
                    onChange={(e) =>
                      set(
                        "composition_rate_bps",
                        e.target.value === "" ? null : Math.round(Number(e.target.value) * 100),
                      )
                    }
                  />
                  <span className="absolute top-1/2 right-3 -translate-y-1/2 text-sm font-semibold text-muted">
                    %
                  </span>
                </div>
              </Field>
            )}
          </div>
        )}

        {v.gst_regime === "regular" && (
          <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-line p-3">
            <input
              type="checkbox"
              checked={v.itc_blocked_by_scheme}
              disabled={!canEdit}
              onChange={(e) => set("itc_blocked_by_scheme", e.target.checked)}
              className="mt-0.5"
            />
            <span>
              <span className="block text-sm font-semibold text-ink">
                My scheme does not let me claim input credit
              </span>
              <span className="mt-0.5 block text-xs text-muted">
                Restaurants charging 5% are the common case: you charge GST but cannot claim it back
                on what you buy, so the tax on a purchase is part of its cost. Tick this and the app
                will stop offering to claim it.
              </span>
            </span>
          </label>
        )}

        {!cfg.gstin && v.gst_regime !== "unregistered" && (
          <Alert tone="warn">
            Add your GSTIN in company details above before saving — a registered business cannot be
            set up without it.
          </Alert>
        )}
      </div>

      {/* ---------------------------------------------------------- TDS ---- */}
      <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-line p-3">
        <input
          type="checkbox"
          checked={v.tds_deductor}
          disabled={!canEdit}
          onChange={(e) => set("tds_deductor", e.target.checked)}
          className="mt-0.5"
        />
        <span>
          <span className="block text-sm font-semibold text-ink">
            I deduct TDS when paying contractors, rent or professional fees
          </span>
          <span className="mt-0.5 block text-xs text-muted">
            Adds an "of which TDS" box to those payments, so the deduction is recorded as owed to
            the government rather than paid to the supplier.
          </span>
        </span>
      </label>

      {/* ------------------------------------------------------ features ---- */}
      <div className="space-y-2">
        <p className="text-sm font-bold text-ink">What does this business actually do?</p>
        <p className="text-xs text-muted">
          Switch off what you do not do. Anything switched off disappears from the app — it is not
          hidden behind a menu, it simply is not there.
        </p>
        {(featQ.data ?? [])
          .filter((f) => f.key !== "gst" && f.key !== "tds")
          .map((f) => (
            <label
              key={f.key}
              className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-line p-3"
            >
              <input
                type="checkbox"
                checked={v.features?.[f.key] ?? f.default_enabled}
                disabled={!canEdit}
                onChange={(e) =>
                  set("features", { ...v.features, [f.key]: e.target.checked })
                }
                className="mt-0.5"
              />
              <span>
                <span className="block text-sm font-semibold text-ink">{f.label}</span>
                {f.blurb && <span className="mt-0.5 block text-xs text-muted">{f.blurb}</span>}
              </span>
            </label>
          ))}
      </div>

      {error && <Alert tone="danger">{error}</Alert>}
      {done && <Alert tone="ok">{done}</Alert>}

      {canEdit && (
        <Button
          onClick={() =>
            save({
              gst_regime: v.gst_regime,
              gst_registered_from: v.gst_registered_from ?? undefined,
              composition_rate_bps: v.composition_rate_bps ?? undefined,
              itc_blocked_by_scheme: v.itc_blocked_by_scheme,
              tds_deductor: v.tds_deductor,
              // GST and TDS follow the answers above rather than being separate
              // switches — two places to say the same thing is two places to
              // disagree.
              features: {
                ...v.features,
                gst: v.gst_regime !== "unregistered",
                tds: v.tds_deductor,
              },
            })
          }
          disabled={busy || !draft}
        >
          {busy ? "Saving…" : "Save setup"}
        </Button>
      )}
    </Card>
  );
}
