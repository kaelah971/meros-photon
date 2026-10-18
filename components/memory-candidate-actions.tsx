"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * S13 memory candidate proposal. One explicit action per finalized
 * postmortem; repeated clicks dedupe server-side. Approval happens in
 * Fix Card review, not here.
 */
export default function MemoryCandidateActions({
  workspaceSlug,
  incidentId,
  postmortemId,
}: {
  workspaceSlug: string;
  incidentId: string;
  postmortemId: string;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<"idle" | "working" | "failed" | "confirm">("idle");
  const [message, setMessage] = useState("");

  async function propose(confirmed: boolean) {
    if (!confirmed) {
      setPhase("confirm");
      setMessage("Click again to propose this postmortem as reusable operator memory.");
      return;
    }
    setPhase("working");
    setMessage("Proposing…");
    try {
      const res = await fetch(`/api/incidents/${incidentId}/memory-candidate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceSlug, postmortemId }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string; action?: string };
      if (res.ok && data.ok) {
        setPhase("idle");
        setMessage("");
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

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => propose(phase === "confirm")}
        disabled={phase === "working"}
        className="rounded-md border border-[rgba(119,255,117,0.3)] px-2.5 py-1 text-[11px] text-[#9AFF8D] hover:bg-[rgba(119,255,117,0.08)] disabled:cursor-wait disabled:opacity-60"
      >
        {phase === "working" ? "Proposing…" : phase === "confirm" ? "Confirm proposal" : "Propose as memory"}
      </button>
      {phase !== "idle" && (
        <span className={`text-[11px] ${phase === "failed" ? "text-red-300" : "text-amber-200"}`}>{message}</span>
      )}
    </span>
  );
}
