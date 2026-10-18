"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const NEXT_LABELS: Record<string, string> = {
  investigating: "Start investigating",
  ready_for_action: "Mark ready for action",
  recovering: "Start recovering",
  monitoring: "Move to monitoring",
  resolved: "Resolve",
  dismissed: "Dismiss",
};

function postJson(url: string, body: Record<string, unknown>) {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

/**
 * Operator actions for one incident: lifecycle transitions, linking existing
 * records, and explicit split/merge. Every control calls a staff-gated API
 * with existing IDs only — nothing here invents associated records.
 */
export default function IncidentActions({
  workspaceSlug,
  incidentId,
  status,
  nextStates,
  unlinkedConversations,
  unlinkedCustomers,
  mergeTargets,
  linkedConversationIds,
  linkedCustomerIds,
}: {
  workspaceSlug: string;
  incidentId: string;
  status: string;
  nextStates: string[];
  unlinkedConversations: { id: string; title: string }[];
  unlinkedCustomers: { id: string; label: string }[];
  mergeTargets: { id: string; title: string }[];
  linkedConversationIds: string[];
  linkedCustomerIds: string[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [mergeTarget, setMergeTarget] = useState("");
  const [splitTitle, setSplitTitle] = useState("");
  const [showSplit, setShowSplit] = useState(false);
  const [showMerge, setShowMerge] = useState(false);
  const [showResolution, setShowResolution] = useState<string | null>(null);
  const [convSel, setConvSel] = useState("");
  const [custSel, setCustSel] = useState("");
  const [note, setNote] = useState("");

  async function run(key: string, fn: () => Promise<Response>) {
    if (busy) return;
    setBusy(key);
    setError(null);
    try {
      const res = await fn();
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setError(data.error ?? `request failed (${res.status})`);
        return;
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "request failed");
    } finally {
      setBusy(null);
    }
  }

  const transition = (to: string) =>
    run(`to-${to}`, () =>
      postJson(`/api/incidents/${incidentId}/transition`, {
        workspaceSlug,
        to,
        ...(to === "dismissed" ? { reason } : {}),
      }),
    );

  const linkConversation = () =>
    convSel &&
    run("link-conv", () =>
      postJson(`/api/incidents/${incidentId}/associations`, { workspaceSlug, conversationId: convSel }),
    );

  const linkCustomer = () =>
    custSel &&
    run("link-cust", () =>
      postJson(`/api/incidents/${incidentId}/associations`, { workspaceSlug, customerId: custSel }),
    );

  const addNote = () =>
    note.trim() &&
    run("add-note", () =>
      postJson(`/api/incidents/${incidentId}/associations`, {
        workspaceSlug,
        evidence: { kind: "note", note: note.trim() },
      }),
    );

  const doMerge = () =>
    mergeTarget &&
    run("merge", () =>
      postJson(`/api/incidents/${incidentId}/merge`, { workspaceSlug, targetIncidentId: mergeTarget }),
    );

  const doSplit = () =>
    splitTitle.trim() &&
    run("split", () =>
      postJson(`/api/incidents/${incidentId}/split`, {
        workspaceSlug,
        childTitle: splitTitle.trim(),
        moveConversationIds: linkedConversationIds,
        moveCustomerIds: linkedCustomerIds,
      }),
    );

  return (
    <div className="mt-4 space-y-3">
      {error && <p className="text-[11px] text-red-300">Failed: {error}</p>}

      {nextStates.length > 0 && (
        <div>
          <p className="text-xs font-medium text-neutral-300">Change status <span className="text-neutral-500">(now: {status.replace(/_/g, " ")})</span></p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {nextStates.map((to) => (
              <span key={to}>
                {to === "resolved" ? (
                  <a
                    href="#closure-readiness"
                    className="inline-block rounded-md border border-[rgba(119,255,117,0.3)] px-3 py-1.5 text-xs text-[#9AFF8D]"
                  >
                    {NEXT_LABELS[to] ?? to} — via closure review
                  </a>
                ) : to === "dismissed" && showResolution !== to ? (
                  <button
                    type="button"
                    onClick={() => setShowResolution(to)}
                    className="rounded-md border border-[rgba(255,120,120,0.4)] px-3 py-1.5 text-xs text-red-200"
                  >
                    {NEXT_LABELS[to] ?? to}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => transition(to)}
                    className="rounded-md bg-[#77FF75] px-3 py-1.5 text-xs font-medium text-[#030806] hover:bg-[#9AFF8D] disabled:cursor-wait disabled:opacity-60"
                  >
                    {busy === `to-${to}` ? "Working…" : NEXT_LABELS[to] ?? to}
                  </button>
                )}
              </span>
            ))}
          </div>
          {showResolution === "dismissed" && (
            <div className="mt-2">
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Dismissal reason (optional)"
                className="w-full rounded bg-[#06100B] px-2 py-1.5 text-xs text-neutral-100"
              />
              <div className="mt-1 flex gap-2">
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => transition("dismissed")}
                  className="rounded-md border border-[rgba(255,120,120,0.4)] px-3 py-1.5 text-xs text-red-200 disabled:opacity-60"
                >
                  Confirm dismiss
                </button>
                <button type="button" onClick={() => setShowResolution(null)} className="text-xs text-neutral-400">
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {(unlinkedConversations.length > 0 || unlinkedCustomers.length > 0) && (
        <div className="border-t border-[rgba(119,255,117,0.12)] pt-2.5">
          <p className="text-xs font-medium text-neutral-300">Link existing records</p>
          {unlinkedConversations.length > 0 && (
            <div className="mt-1.5 flex gap-2">
              <select
                value={convSel}
                onChange={(e) => setConvSel(e.target.value)}
                className="min-w-0 flex-1 rounded bg-[#06100B] px-2 py-1.5 text-xs text-neutral-100"
              >
                <option value="">Select conversation…</option>
                {unlinkedConversations.map((c) => (
                  <option key={c.id} value={c.id}>{c.title}</option>
                ))}
              </select>
              <button
                type="button"
                disabled={!convSel || busy !== null}
                onClick={linkConversation}
                className="shrink-0 rounded-md border border-[rgba(119,255,117,0.3)] px-3 py-1.5 text-xs text-[#9AFF8D] disabled:opacity-40"
              >
                Link
              </button>
            </div>
          )}
          {unlinkedCustomers.length > 0 && (
            <div className="mt-1.5 flex gap-2">
              <select
                value={custSel}
                onChange={(e) => setCustSel(e.target.value)}
                className="min-w-0 flex-1 rounded bg-[#06100B] px-2 py-1.5 text-xs text-neutral-100"
              >
                <option value="">Select customer…</option>
                {unlinkedCustomers.map((c) => (
                  <option key={c.id} value={c.id}>{c.label}</option>
                ))}
              </select>
              <button
                type="button"
                disabled={!custSel || busy !== null}
                onClick={linkCustomer}
                className="shrink-0 rounded-md border border-[rgba(119,255,117,0.3)] px-3 py-1.5 text-xs text-[#9AFF8D] disabled:opacity-40"
              >
                Link
              </button>
            </div>
          )}
          <div className="mt-1.5 flex gap-2">
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Operator note (stored as evidence)"
              className="min-w-0 flex-1 rounded bg-[#06100B] px-2 py-1.5 text-xs text-neutral-100"
            />
            <button
              type="button"
              disabled={!note.trim() || busy !== null}
              onClick={addNote}
              className="shrink-0 rounded-md border border-[rgba(119,255,117,0.3)] px-3 py-1.5 text-xs text-[#9AFF8D] disabled:opacity-40"
            >
              Add
            </button>
          </div>
        </div>
      )}

      {(mergeTargets.length > 0 || linkedConversationIds.length + linkedCustomerIds.length > 0) && (
        <div className="border-t border-[rgba(119,255,117,0.12)] pt-2.5">
          <div className="flex flex-wrap gap-2">
            {mergeTargets.length > 0 && (
              <button
                type="button"
                onClick={() => setShowMerge((v) => !v)}
                className="text-[11px] text-neutral-400 hover:text-neutral-200"
              >
                {showMerge ? "Hide merge" : "Merge into another incident…"}
              </button>
            )}
            {(linkedConversationIds.length + linkedCustomerIds.length > 0) && (
              <button
                type="button"
                onClick={() => setShowSplit((v) => !v)}
                className="text-[11px] text-neutral-400 hover:text-neutral-200"
              >
                {showSplit ? "Hide split" : "Split off a child incident…"}
              </button>
            )}
          </div>
          {showMerge && mergeTargets.length > 0 && (
            <div className="mt-1.5 flex gap-2">
              <select
                value={mergeTarget}
                onChange={(e) => setMergeTarget(e.target.value)}
                className="min-w-0 flex-1 rounded bg-[#06100B] px-2 py-1.5 text-xs text-neutral-100"
              >
                <option value="">Select target incident…</option>
                {mergeTargets.map((t) => (
                  <option key={t.id} value={t.id}>{t.title}</option>
                ))}
              </select>
              <button
                type="button"
                disabled={!mergeTarget || busy !== null}
                onClick={doMerge}
                className="shrink-0 rounded-md border border-[rgba(255,180,120,0.4)] px-3 py-1.5 text-xs text-amber-200 disabled:opacity-40"
              >
                Merge
              </button>
            </div>
          )}
          {showSplit && (
            <div className="mt-1.5">
              <input
                value={splitTitle}
                onChange={(e) => setSplitTitle(e.target.value)}
                placeholder="Child incident title"
                className="w-full rounded bg-[#06100B] px-2 py-1.5 text-xs text-neutral-100"
              />
              <p className="mt-1 text-[11px] text-neutral-500">
                Moves all {linkedConversationIds.length + linkedCustomerIds.length} linked record{linkedConversationIds.length + linkedCustomerIds.length === 1 ? "" : "s"} to the child.
              </p>
              <button
                type="button"
                disabled={!splitTitle.trim() || busy !== null}
                onClick={doSplit}
                className="mt-1 rounded-md border border-[rgba(255,180,120,0.4)] px-3 py-1.5 text-xs text-amber-200 disabled:opacity-40"
              >
                Create split
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
