"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const SEVERITIES = ["low", "medium", "high", "critical"] as const;

/** Operator-created incident from real workspace records only. */
export default function IncidentCreateForm({
  workspaceSlug,
  conversations,
}: {
  workspaceSlug: string;
  conversations: { id: string; title: string }[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState<string>("medium");
  const [selected, setSelected] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(id: string) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id].slice(0, 20)));
  }

  async function submit() {
    if (saving || !title.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/incidents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceSlug, title, description, severity, conversationIds: selected }),
      });
      const data = (await res.json()) as { ok?: boolean; incident?: { id: string }; error?: string };
      if (!res.ok || !data.ok || !data.incident) {
        setError(data.error ?? `request failed (${res.status})`);
        return;
      }
      router.push(`/app/workspaces/${workspaceSlug}/incidents/${data.incident.id}`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "request failed");
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md bg-[#77FF75] px-3 py-1.5 text-xs font-medium text-[#030806] hover:bg-[#9AFF8D]"
      >
        New incident
      </button>
    );
  }

  return (
    <div className="mt-2 rounded-md border border-[rgba(119,255,117,0.3)] bg-[rgba(10,27,18,0.72)] px-3 py-2.5">
      <label className="block">
        <span className="text-[11px] text-neutral-400">Title</span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Checkout 500s on Visa payments"
          className="mt-1 w-full rounded bg-[#06100B] px-2 py-1.5 text-xs text-neutral-100"
        />
      </label>
      <label className="mt-2 block">
        <span className="text-[11px] text-neutral-400">Description</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          className="mt-1 w-full rounded bg-[#06100B] px-2 py-1.5 text-xs text-neutral-100"
        />
      </label>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="text-[11px] text-neutral-400">Severity</span>
        {SEVERITIES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSeverity(s)}
            className={`rounded-full border px-2.5 py-1 text-[11px] ${
              severity === s
                ? "border-[rgba(119,255,117,0.5)] text-[#9AFF8D]"
                : "border-[rgba(255,255,255,0.14)] text-neutral-400"
            }`}
          >
            {s}
          </button>
        ))}
      </div>
      {conversations.length > 0 && (
        <div className="mt-2">
          <p className="text-[11px] text-neutral-400">Link existing conversations (optional)</p>
          <ul className="mt-1 max-h-32 space-y-1 overflow-auto">
            {conversations.map((c) => (
              <li key={c.id}>
                <label className="flex cursor-pointer items-center gap-2 text-[11px] text-neutral-300">
                  <input type="checkbox" checked={selected.includes(c.id)} onChange={() => toggle(c.id)} />
                  <span className="truncate">{c.title}</span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}
      {error && <p className="mt-1.5 text-[11px] text-red-300">Failed: {error}</p>}
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={saving || !title.trim()}
          className="rounded-md bg-[#77FF75] px-3 py-1.5 text-xs font-medium text-[#030806] hover:bg-[#9AFF8D] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving ? "Creating…" : "Create incident"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-md border border-[rgba(255,255,255,0.14)] px-3 py-1.5 text-xs text-neutral-300"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
