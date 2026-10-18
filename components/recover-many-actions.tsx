"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type ActionState = { phase: "idle" } | { phase: "working"; label: string } | { phase: "failed"; message: string };

/**
 * S15E batch-level operator actions: propose, approve (exact payload),
 * revoke. Every mutating action needs an explicit second click.
 * Approving never sends anything; publishing is per-recipient below.
 */
export default function RecoverManyActions({
  workspaceSlug,
  incidentId,
  batch,
}: {
  workspaceSlug: string;
  incidentId: string;
  batch: { id: string; status: string; highImpact: boolean } | null;
}) {
  const router = useRouter();
  const [state, setState] = useState<ActionState>({ phase: "idle" });
  const [armed, setArmed] = useState<string | null>(null);

  async function call(url: string, body: Record<string, unknown>, label: string) {
    if (state.phase === "working") return;
    setState({ phase: "working", label });
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceSlug, ...body }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (res.ok && data.ok) {
        setState({ phase: "idle" });
        setArmed(null);
        router.refresh();
        return;
      }
      setState({ phase: "failed", message: data.error ?? `request failed (${res.status})` });
    } catch (e) {
      setState({ phase: "failed", message: e instanceof Error ? e.message : "request failed" });
    }
  }

  function ask(key: string): boolean {
    if (armed === key) {
      setArmed(null);
      return true;
    }
    setArmed(key);
    return false;
  }

  if (!batch) {
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => ask("propose") && call(`/api/incidents/${incidentId}/recover-many`, {}, "Preparing…")}
          disabled={state.phase === "working"}
          className="rounded-md border border-[rgba(119,255,117,0.3)] px-2.5 py-1 text-[11px] text-[#9AFF8D] hover:bg-[rgba(119,255,117,0.08)] disabled:cursor-wait disabled:opacity-60"
        >
          {armed === "propose" ? "Confirm propose" : "Propose customer replies"}
        </button>
        {state.phase === "failed" && <span className="text-[11px] text-red-300">{state.message}</span>}
      </span>
    );
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span className="font-mono text-[10px] text-neutral-500">
        batch {batch.id.slice(0, 8)} · {batch.status}
        {batch.highImpact ? " · high-impact (independent review required)" : ""}
      </span>
      {batch.status === "draft" && (
        <button
          type="button"
          onClick={() => ask("approve") && call(`/api/incidents/${incidentId}/recover-many/${batch.id}/approve`, {}, "Approving…")}
          disabled={state.phase === "working"}
          className="rounded-md border border-[rgba(119,255,117,0.3)] px-2.5 py-1 text-[11px] text-[#9AFF8D] hover:bg-[rgba(119,255,117,0.08)] disabled:cursor-wait disabled:opacity-60"
        >
          {armed === "approve" ? "Confirm approval (no sends)" : "Approve exact payload"}
        </button>
      )}
      {batch.status === "approved" && (
        <button
          type="button"
          onClick={() => ask("revoke") && call(`/api/incidents/${incidentId}/recover-many/${batch.id}/revoke`, {}, "Revoking…")}
          disabled={state.phase === "working"}
          className="rounded-md border border-[rgba(255,120,120,0.3)] px-2.5 py-1 text-[11px] text-red-300 hover:bg-[rgba(255,120,120,0.06)] disabled:cursor-wait disabled:opacity-60"
        >
          {armed === "revoke" ? "Confirm revoke" : "Revoke approval"}
        </button>
      )}
      {state.phase === "working" && <span className="text-[11px] text-neutral-400">{state.label}</span>}
      {state.phase === "failed" && <span className="text-[11px] text-red-300">{state.message}</span>}
    </span>
  );
}
