"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * S14 finding actions. Refresh, acknowledge, dismiss (reason required),
 * mark addressed, and explicit provenance repair. Advisory only — nothing
 * here writes memory, executes, or closes anything.
 */
export default function KnowledgeHealthActions({
  workspaceSlug,
  findingId,
  repairable,
}: {
  workspaceSlug: string;
  findingId: string | null;
  repairable?: boolean;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<"idle" | "working" | "failed" | "confirm">("idle");
  const [message, setMessage] = useState("");
  const [note, setNote] = useState("");

  async function post(url: string, body: Record<string, unknown>, label: string) {
    if (phase === "working") return;
    setPhase("working");
    setMessage(label);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (res.ok && data.ok) {
        setPhase("idle");
        setMessage("");
        setNote("");
        router.refresh();
        return;
      }
      setPhase("failed");
      setMessage(data.error ?? `request failed (${res.status})`);
    } catch (e) {
      setPhase("failed");
      setMessage(e instanceof Error ? e.message : "request failed");
    }
  }

  const refresh = () => post(`/api/workspaces/${workspaceSlug}/knowledge-health`, {}, "Analyzing…");

  const review = (decision: "acknowledged" | "dismissed" | "addressed") => {
    if (!findingId) return;
    if (decision === "dismissed" && !note.trim()) {
      setPhase("failed");
      setMessage("Dismissal needs a reason.");
      return;
    }
    post(`/api/workspaces/${workspaceSlug}/knowledge-health/${findingId}/review`, { decision, note: note.trim() || undefined }, "Saving…");
  };

  const repair = () => {
    if (!findingId) return;
    post(`/api/workspaces/${workspaceSlug}/knowledge-health/${findingId}/repair`, {}, "Repairing…");
  };

  if (!findingId) {
    return (
      <button
        type="button"
        onClick={refresh}
        disabled={phase === "working"}
        className="rounded-md border border-[rgba(255,255,255,0.2)] px-2.5 py-1 text-[11px] text-neutral-200 hover:bg-[rgba(255,255,255,0.06)] disabled:cursor-wait disabled:opacity-60"
      >
        {phase === "working" ? message : "Refresh analysis"}
      </button>
    );
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="review note (required to dismiss)"
        className="w-52 rounded-md border border-[rgba(255,255,255,0.15)] bg-black/30 px-2 py-1 text-[11px] text-neutral-200 placeholder:text-neutral-600"
      />
      <button type="button" onClick={() => review("acknowledged")} disabled={phase === "working"} className="rounded-md border border-[rgba(255,255,255,0.2)] px-2 py-1 text-[10px] text-neutral-200 hover:bg-[rgba(255,255,255,0.06)] disabled:opacity-60">
        Acknowledge
      </button>
      <button type="button" onClick={() => review("dismissed")} disabled={phase === "working"} className="rounded-md border border-[rgba(255,120,120,0.3)] px-2 py-1 text-[10px] text-red-300 hover:bg-[rgba(255,120,120,0.06)] disabled:opacity-60">
        Dismiss
      </button>
      <button type="button" onClick={() => review("addressed")} disabled={phase === "working"} className="rounded-md border border-[rgba(119,255,117,0.3)] px-2 py-1 text-[10px] text-[#9AFF8D] hover:bg-[rgba(119,255,117,0.08)] disabled:opacity-60">
        Mark addressed
      </button>
      {repairable && (
        <button type="button" onClick={repair} disabled={phase === "working"} className="rounded-md border border-[rgba(255,180,120,0.4)] px-2 py-1 text-[10px] text-amber-200 hover:bg-[rgba(255,180,120,0.06)] disabled:opacity-60">
          Repair provenance link
        </button>
      )}
      {(phase === "failed" || phase === "working") && (
        <span className={`text-[11px] ${phase === "failed" ? "text-red-300" : "text-neutral-400"}`}>{message}</span>
      )}
    </span>
  );
}
