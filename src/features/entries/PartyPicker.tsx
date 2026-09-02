import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "../../lib/supabase";
import { inputClass } from "../../components/ui";

type Party = { id: string; name: string; party_type: string | null };

async function listParties(companyId: string): Promise<Party[]> {
  const { data, error } = await supabase
    .from("parties")
    .select("id,name,party_type")
    .eq("company_id", companyId)
    .order("name");
  if (error) throw error;
  return data ?? [];
}

/**
 * The answer to "where do I create the ledger?" — you don't. You type the name.
 * If it exists you pick it; if it doesn't, it is created when the entry posts.
 * No separate "create a ledger" step to learn or forget.
 */
export function PartyPicker({
  companyId,
  value,
  onChange,
  placeholder,
}: {
  companyId: string;
  value: string;
  onChange: (name: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["parties", companyId],
    queryFn: () => listParties(companyId),
  });

  const all = q.data ?? [];
  const typed = value.trim().toLowerCase();
  const matches = typed
    ? all.filter((p) => p.name.toLowerCase().includes(typed)).slice(0, 6)
    : all.slice(0, 6);
  const exact = all.some((p) => p.name.trim().toLowerCase() === typed);
  const isNew = typed.length > 0 && !exact;

  return (
    <div className="relative">
      <input
        className={inputClass}
        value={value}
        placeholder={placeholder ?? "Type a name"}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        autoComplete="off"
      />

      {isNew && !open && (
        <p className="mt-1 text-xs font-semibold text-ok">
          New — “{value.trim()}” will be added to your parties
        </p>
      )}

      {open && (matches.length > 0 || isNew) && (
        <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-xl border border-line bg-card shadow-lg">
          {matches.map((p) => (
            <button
              key={p.id}
              type="button"
              className="block w-full px-3 py-2 text-left text-sm hover:bg-canvas"
              onMouseDown={() => {
                onChange(p.name);
                setOpen(false);
                void qc.invalidateQueries({ queryKey: ["parties", companyId] });
              }}
            >
              {p.name}
              {p.party_type && <span className="ml-2 text-xs text-muted">{p.party_type}</span>}
            </button>
          ))}
          {isNew && (
            <div className="border-t border-line bg-okbg px-3 py-2 text-xs font-semibold text-ok">
              “{value.trim()}” is new — it will be added automatically
            </div>
          )}
        </div>
      )}
    </div>
  );
}
