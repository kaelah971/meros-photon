"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type ActionState =
  | { phase: "idle" }
  | { phase: "working"; label: string }
  | { phase: "failed"; message: string };

/**
 * S9 operator actions: explicit generate/refresh and review transitions.
 * There is deliberately NO execute button anywhere in this component.
 */
export default function RecoveryPlanActions({
  workspaceSlug,
  incidentId,
  plan,
}: {
  workspaceSlug: string;
  incidentId: string;
  plan?: { id: string; status: string } | null;
}) {
  const router = useRouter();
  const [state, setState] = useState<ActionState>({ phase: "idle" });

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
        router.refresh();
        return;
      }
      setState({ phase: "failed", message: data.error ?? `request failed (${res.status})` });
    } catch (e) {
      setState({ phase: "failed", message: e instanceof Error ? e.message : "request failed" });
    }
  }

  const generate = () => call(`/api/incidents/${incidentId}/plans/generate`, {}, "Preparing…");
  const review = (action: "submit_for_review" | "stage" | "reject") =>
    plan ? call(`/api/incidents/${incidentId}/plans/${plan.id}/review`, { action }, "Saving…") : null;

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={generate}
        disabled={state.phase === "working"}
        className="rounded-md border border-[rgba(119,255,117,0.3)] px-2.5 py-1 text-[11px] text-[#9AFF8D] hover:bg-[rgba(119,255,117,0.08)] disabled:cursor-wait disabled:opacity-60"
      >
        {state.phase === "working" ? state.label : plan ? "Refresh proposal" : "Generate proposal"}
      </button>
      {plan?.status === "draft" && (
        <>
          <button
            type="button"
            onClick={() => review("submit_for_review")}
            disabled={state.phase === "working"}
            className="rounded-md border border-[rgba(255,255,255,0.2)] px-2.5 py-1 text-[11px] text-neutral-200 hover:bg-[rgba(255,255,255,0.06)] disabled:cursor-wait disabled:opacity-60"
          >
            Submit for review
          </button>
          <button
            type="button"
            onClick={() => review("reject")}
            disabled={state.phase === "working"}
            className="rounded-md border border-[rgba(255,120,120,0.3)] px-2.5 py-1 text-[11px] text-red-300 hover:bg-[rgba(255,120,120,0.06)] disabled:cursor-wait disabled:opacity-60"
          >
            Reject
          </button>
        </>
      )}
      {plan?.status === "under_review" && (
        <>
          <button
            type="button"
            onClick={() => review("stage")}
            disabled={state.phase === "working"}
            className="rounded-md bg-[#77FF75] px-2.5 py-1 text-[11px] font-medium text-[#030806] hover:bg-[#9AFF8D] disabled:cursor-wait disabled:opacity-60"
          >
            Stage for consideration
          </button>
          <button
            type="button"
            onClick={() => review("reject")}
            disabled={state.phase === "working"}
            className="rounded-md border border-[rgba(255,120,120,0.3)] px-2.5 py-1 text-[11px] text-red-300 hover:bg-[rgba(255,120,120,0.06)] disabled:cursor-wait disabled:opacity-60"
          >
            Reject
          </button>
        </>
      )}
      {state.phase === "failed" && (
        <span className="text-[11px] text-red-300">Failed: {state.message}</span>
      )}
    </span>
  );
}
