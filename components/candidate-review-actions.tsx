"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

function postJson(url: string, body: Record<string, unknown>) {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

/**
 * Operator review of one detected pattern: accept into a new or existing
 * S4 incident, or dismiss with an optional note. Confirmation stays human;
 * nothing here moves incidents toward recovery.
 */
export default function CandidateReviewActions({
  workspaceSlug,
  candidateId,
  incidents,
}: {
  workspaceSlug: string;
  candidateId: string;
  incidents: { id: string; title: string; status: string }[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [severity, setSeverity] = useState("medium");
  const [existingId, setExistingId] = useState("");
  const [note, setNote] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [showExisting, setShowExisting] = useState(false);
  const [showDismiss, setShowDismiss] = useState(false);

  async function run(key: string, fn: () => Promise<Response>, done?: (id?: string) => void) {
    if (busy) return;
    setBusy(key);
    setError(null);
    try {
      const res = await fn();
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; incident?: { id: string } };
      if (!res.ok || !data.ok) {
        setError(data.error ?? `request failed (${res.status})`);
        return;
      }
      if (done) done(data.incident?.id);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "request failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-4 space-y-3">
      {error && <p className="text-[11px] text-red-300">Failed: {error}</p>}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => { setShowNew(true); setShowExisting(false); setShowDismiss(false); }}
          className="rounded-md bg-[#77FF75] px-3 py-1.5 text-xs font-medium text-[#030806] hover:bg-[#9AFF8D]"
        >
          Accept as new incident
        </button>
        <button
          type="button"
          onClick={() => { setShowExisting(true); setShowNew(false); setShowDismiss(false); }}
          disabled={incidents.length === 0}
          className="rounded-md border border-[rgba(119,255,117,0.3)] px-3 py-1.5 text-xs text-[#9AFF8D] disabled:opacity-40"
        >
          Link to existing incident
        </button>
        <button
          type="button"
          onClick={() => { setShowDismiss(true); setShowNew(false); setShowExisting(false); }}
          className="rounded-md border border-[rgba(255,120,120,0.4)] px-3 py-1.5 text-xs text-red-200"
        >
          Dismiss
        </button>
      </div>
      {showNew && (
        <div className="rounded-md border border-[rgba(119,255,117,0.3)] bg-[rgba(10,27,18,0.72)] px-3 py-2">
          <p className="text-[11px] text-neutral-400">Creates a real incident and links every member conversation.</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-neutral-400">Severity</span>
            {(["low", "medium", "high", "critical"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSeverity(s)}
                className={`rounded-full border px-2.5 py-1 text-[11px] ${severity === s ? "border-[rgba(119,255,117,0.5)] text-[#9AFF8D]" : "border-[rgba(255,255,255,0.14)] text-neutral-400"}`}
              >
                {s}
              </button>
            ))}
          </div>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => run("accept-new", () => postJson(`/api/issue-candidates/${candidateId}/review`, { workspaceSlug, action: "accept_new", severity }), (id) => { if (id) router.push(`/app/workspaces/${workspaceSlug}/incidents/${id}`); })}
            className="mt-2 rounded-md bg-[#77FF75] px-3 py-1.5 text-xs font-medium text-[#030806] disabled:opacity-60"
          >
            {busy === "accept-new" ? "Creating…" : "Confirm accept"}
          </button>
        </div>
      )}
      {showExisting && (
        <div className="rounded-md border border-[rgba(119,255,117,0.3)] bg-[rgba(10,27,18,0.72)] px-3 py-2">
          <p className="text-[11px] text-neutral-400">Links every member conversation to a compatible open incident.</p>
          <div className="mt-1.5 flex gap-2">
            <select
              value={existingId}
              onChange={(e) => setExistingId(e.target.value)}
              className="min-w-0 flex-1 rounded bg-[#06100B] px-2 py-1.5 text-xs text-neutral-100"
            >
              <option value="">Select incident…</option>
              {incidents.map((i) => (
                <option key={i.id} value={i.id}>{i.title} ({i.status})</option>
              ))}
            </select>
            <button
              type="button"
              disabled={!existingId || busy !== null}
              onClick={() => run("accept-existing", () => postJson(`/api/issue-candidates/${candidateId}/review`, { workspaceSlug, action: "accept_existing", incidentId: existingId }), (id) => { if (id) router.push(`/app/workspaces/${workspaceSlug}/incidents/${id}`); })}
              className="shrink-0 rounded-md bg-[#77FF75] px-3 py-1.5 text-xs font-medium text-[#030806] disabled:opacity-60"
            >
              {busy === "accept-existing" ? "Linking…" : "Confirm link"}
            </button>
          </div>
        </div>
      )}
      {showDismiss && (
        <div className="rounded-md border border-[rgba(255,120,120,0.3)] bg-[rgba(10,27,18,0.72)] px-3 py-2">
          <p className="text-[11px] text-neutral-400">Dismissal is recorded; unchanged evidence will not re-surface this suggestion.</p>
          <div className="mt-1.5 flex gap-2">
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Reason (optional)"
              className="min-w-0 flex-1 rounded bg-[#06100B] px-2 py-1.5 text-xs text-neutral-100"
            />
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => run("dismiss", () => postJson(`/api/issue-candidates/${candidateId}/review`, { workspaceSlug, action: "dismiss", note: note.trim() }), () => router.push(`/app/workspaces/${workspaceSlug}/incidents`))}
              className="shrink-0 rounded-md border border-[rgba(255,120,120,0.4)] px-3 py-1.5 text-xs text-red-200 disabled:opacity-60"
            >
              {busy === "dismiss" ? "Dismissing…" : "Confirm dismiss"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
