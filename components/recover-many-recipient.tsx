"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Recipient = {
  id: string;
  conversationId: string;
  customerId: string;
  eligibility: string;
  reasonCode: string;
  evidenceRefs: string[];
  draft: string;
  status: string;
  providerMessageId: string | null;
  errorNote: string | null;
};

function eligibilityLabel(e: string): { text: string; cls: string } {
  if (e === "eligible") return { text: "ELIGIBLE", cls: "text-[#9AFF8D] border-[rgba(119,255,117,0.4)]" };
  if (e === "needs_review") return { text: "NEEDS REVIEW", cls: "text-amber-200 border-[rgba(255,180,120,0.4)]" };
  return { text: "EXCLUDED", cls: "text-neutral-500 border-[rgba(255,255,255,0.15)]" };
}

function statusLabel(s: string): { text: string; cls: string } {
  switch (s) {
    case "approved":
      return { text: "APPROVED — awaiting explicit publish", cls: "text-[#9AFF8D] border-[rgba(119,255,117,0.4)]" };
    case "published_to_conversation":
      return { text: "PUBLISHED TO CONVERSATION (not confirmed delivered)", cls: "text-[#9AFF8D] border-[rgba(119,255,117,0.4)]" };
    case "failed":
      return { text: "FAILED", cls: "text-red-300 border-[rgba(255,120,120,0.4)]" };
    case "unknown":
      return { text: "UNKNOWN OUTCOME — verify in the conversation", cls: "text-amber-200 border-[rgba(255,180,120,0.4)]" };
    default:
      return { text: "DRAFT — not approved", cls: "text-neutral-300 border-[rgba(255,255,255,0.25)]" };
  }
}

/**
 * S15E per-recipient card: eligibility, evidence, editable draft (which
 * invalidates prior approval), and an explicit per-recipient publish.
 * Publishing writes ONLY this customer's own conversation.
 */
export default function RecoverManyRecipientCard({
  workspaceSlug,
  incidentId,
  batchId,
  batchStatus,
  recipient,
}: {
  workspaceSlug: string;
  incidentId: string;
  batchId: string;
  batchStatus: string;
  recipient: Recipient;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState(recipient.draft);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const dirty = draft !== recipient.draft;

  async function call(url: string, init: RequestInit, working: string): Promise<boolean> {
    if (busy) return false;
    setBusy(working);
    setError(null);
    try {
      const res = await fetch(url, {
        ...init,
        headers: { "content-type": "application/json", ...(init.headers ?? {}) },
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (res.ok && data.ok) {
        setBusy(null);
        setArmed(null);
        router.refresh();
        return true;
      }
      setError(data.error ?? `request failed (${res.status})`);
      setBusy(null);
      return false;
    } catch (e) {
      setError(e instanceof Error ? e.message : "request failed");
      setBusy(null);
      return false;
    }
  }

  const save = () =>
    call(`/api/incidents/${incidentId}/recover-many/${batchId}/recipients/${recipient.id}`, {
      method: "PATCH",
      body: JSON.stringify({ workspaceSlug, text: draft }),
    }, "Saving…");

  const publish = () => {
    if (armed !== "publish") {
      setArmed("publish");
      return;
    }
    void call(`/api/incidents/${incidentId}/recover-many/${batchId}/recipients/${recipient.id}`, {
      method: "POST",
      body: JSON.stringify({ workspaceSlug }),
    }, "Publishing…");
  };

  const eg = eligibilityLabel(recipient.eligibility);
  const st = statusLabel(recipient.status);
  const canEdit = batchStatus === "draft" || batchStatus === "approved";
  const canPublish =
    batchStatus === "approved" &&
    recipient.eligibility === "eligible" &&
    (recipient.status === "approved" || recipient.status === "unknown");

  return (
    <div className="rounded border border-[rgba(255,255,255,0.1)] px-2.5 py-2">
      <p className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10px] text-neutral-500">customer {recipient.customerId.slice(0, 8)} · conv {recipient.conversationId.slice(0, 8)}</span>
        <span className={`rounded border px-1.5 py-px font-mono text-[10px] ${eg.cls}`}>{eg.text}</span>
        <span className={`rounded border px-1.5 py-px font-mono text-[10px] ${st.cls}`}>{st.text}</span>
      </p>
      <p className="mt-1 font-mono text-[10px] text-neutral-500">
        {recipient.reasonCode}
        {recipient.evidenceRefs.length > 0 ? ` · evidence: ${recipient.evidenceRefs.map((e) => e.slice(0, 8)).join(", ")}` : ""}
      </p>
      {recipient.errorNote && <p className="mt-1 text-[11px] text-red-300">{recipient.errorNote}</p>}
      {recipient.providerMessageId && (
        <p className="mt-1 font-mono text-[10px] text-neutral-500">message {recipient.providerMessageId.slice(0, 8)} (in-conversation record only — not delivery proof)</p>
      )}
      {recipient.eligibility === "eligible" && (
        <>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={!canEdit || busy !== null}
            rows={5}
            className="mt-1.5 w-full rounded border border-[rgba(255,255,255,0.15)] bg-black/30 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-neutral-200 disabled:opacity-60"
          />
          <span className="mt-1.5 inline-flex flex-wrap items-center gap-2">
            {canEdit && dirty && (
              <button
                type="button"
                onClick={save}
                disabled={busy !== null}
                className="rounded-md border border-[rgba(255,255,255,0.2)] px-2.5 py-1 text-[11px] text-neutral-200 hover:bg-[rgba(255,255,255,0.06)] disabled:cursor-wait disabled:opacity-60"
              >
                {busy ? busy : "Save draft (invalidates approval)"}
              </button>
            )}
            {canPublish && (
              <button
                type="button"
                onClick={publish}
                disabled={busy !== null}
                className="rounded-md border border-[rgba(119,255,117,0.35)] px-2.5 py-1 text-[11px] text-[#9AFF8D] hover:bg-[rgba(119,255,117,0.08)] disabled:cursor-wait disabled:opacity-60"
              >
                {armed === "publish" ? "Confirm publish to this conversation" : busy ? busy : "Publish to this conversation"}
              </button>
            )}
            {!canPublish && batchStatus === "approved" && recipient.eligibility === "eligible" && (
              <span className="text-[11px] text-neutral-500">Already handled — see status above.</span>
            )}
          </span>
        </>
      )}
      {error && <p className="mt-1 text-[11px] text-red-300">{error}</p>}
    </div>
  );
}
