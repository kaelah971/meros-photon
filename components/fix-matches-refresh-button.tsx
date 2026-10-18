"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type RefreshState =
  | { phase: "idle" }
  | { phase: "working" }
  | { phase: "done"; action: string }
  | { phase: "failed"; message: string };

/**
 * S8 explicit match refresh: staff-triggered recompute for the current
 * brief fingerprint. Idempotent and read-only — safe to retry when
 * retrieval was unavailable. Disables mid-flight.
 */
export default function FixMatchesRefreshButton({
  workspaceSlug,
  incidentId,
}: {
  workspaceSlug: string;
  incidentId: string;
}) {
  const router = useRouter();
  const [state, setState] = useState<RefreshState>({ phase: "idle" });

  async function refresh() {
    if (state.phase === "working") return;
    setState({ phase: "working" });
    try {
      const res = await fetch(`/api/incidents/${incidentId}/fix-matches/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceSlug }),
      });
      const data = (await res.json()) as { ok?: boolean; action?: string; error?: string };
      if (res.ok && data.ok) {
        setState({ phase: "done", action: data.action ?? "done" });
        router.refresh();
        return;
      }
      setState({ phase: "failed", message: data.error ?? `request failed (${res.status})` });
    } catch (e) {
      setState({ phase: "failed", message: e instanceof Error ? e.message : "request failed" });
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={refresh}
        disabled={state.phase === "working"}
        className="rounded-md border border-[rgba(119,255,117,0.3)] px-2.5 py-1 text-[11px] text-[#9AFF8D] hover:bg-[rgba(119,255,117,0.08)] disabled:cursor-wait disabled:opacity-60"
      >
        {state.phase === "working" ? "Matching…" : "Refresh matches"}
      </button>
      {state.phase === "done" && (
        <span className="text-[11px] text-neutral-500">
          {state.action === "unchanged"
            ? "Already current — no recompute needed."
            : state.action === "built"
              ? "Recommendations updated."
              : state.action === "no_match" || state.action === "no_signals"
                ? "No relevant historical cases found."
                : `Refresh ${state.action}.`}
        </span>
      )}
      {state.phase === "failed" && (
        <span className="text-[11px] text-red-300">Failed: {state.message}</span>
      )}
    </span>
  );
}
