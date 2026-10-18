"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Phase = { name: "idle" } | { name: "working"; label: string } | { name: "failed"; message: string } | { name: "confirm"; label: string };

/**
 * S11 operator watch controls. Every mutating action needs an explicit
 * second click (confirm). Confirming resolution is a deliberate,
 * evidence-checked act — never a one-click shortcut — and it never
 * closes the incident.
 */
export default function ResolutionWatchActions({
  workspaceSlug,
  incidentId,
  watchId,
  watchStatus,
  stagedPlans,
}: {
  workspaceSlug: string;
  incidentId: string;
  watchId: string | null;
  watchStatus: string | null;
  stagedPlans: { id: string; version: number }[];
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ name: "idle" });
  const [armed, setArmed] = useState<string | null>(null);
  const [planId, setPlanId] = useState(stagedPlans[0]?.id ?? "");
  const [text, setText] = useState("");

  async function post(url: string, body: Record<string, unknown>, label: string) {
    if (phase.name === "working") return;
    setPhase({ name: "working", label });
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceSlug, ...body }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (res.ok && data.ok) {
        setPhase({ name: "idle" });
        setArmed(null);
        setText("");
        router.refresh();
        return;
      }
      setPhase({ name: "failed", message: data.error ?? `request failed (${res.status})` });
    } catch (e) {
      setPhase({ name: "failed", message: e instanceof Error ? e.message : "request failed" });
    }
  }

  function ask(key: string, label: string): boolean {
    if (armed === key) {
      setArmed(null);
      return true;
    }
    setArmed(null);
    setArmed(key);
    setPhase({ name: "confirm", label });
    return false;
  }

  const start = () => {
    if (!planId) {
      setPhase({ name: "failed", message: "Choose a staged plan with a recorded intervention first." });
      return;
    }
    if (!ask("start", "Click again to start watching this intervention")) return;
    post(`/api/incidents/${incidentId}/watches`, { planId }, "Starting…");
  };

  const refresh = () => post(`/api/incidents/${incidentId}/watches/${watchId}/refresh`, {}, "Evaluating…");

  const observe = (kind: "operator_note" | "verification") => {
    if (!text.trim()) {
      setPhase({ name: "failed", message: "Write the observation first." });
      return;
    }
    post(`/api/incidents/${incidentId}/watches/${watchId}/observe`, { kind, text: text.trim() }, "Recording…");
  };

  const confirm = () => {
    if (!ask("confirm", "Click again to confirm RESOLUTION (evidence-checked, reversible only by history)")) return;
    post(`/api/incidents/${incidentId}/watches/${watchId}/confirm`, { note: text.trim() || undefined }, "Confirming…");
  };

  const mark = (to: "still_affected" | "insufficient_evidence" | "watching") => {
    if (!ask(`mark-${to}`, `Click again to mark ${to.replace(/_/g, " ")}`)) return;
    post(`/api/incidents/${incidentId}/watches/${watchId}/mark`, { to, note: text.trim() || undefined }, "Saving…");
  };

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {!watchId && stagedPlans.length > 0 && (
        <>
          <select
            value={planId}
            onChange={(e) => setPlanId(e.target.value)}
            className="rounded-md border border-[rgba(255,255,255,0.15)] bg-black/30 px-2 py-1 font-mono text-[11px] text-neutral-200"
          >
            {stagedPlans.map((p) => (
              <option key={p.id} value={p.id}>
                plan v{p.version} {p.id.slice(0, 8)}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={start}
            disabled={phase.name === "working"}
            className="rounded-md border border-[rgba(119,255,117,0.3)] px-2.5 py-1 text-[11px] text-[#9AFF8D] hover:bg-[rgba(119,255,117,0.08)] disabled:cursor-wait disabled:opacity-60"
          >
            {armed === "start" ? "Confirm start" : "Start watch"}
          </button>
        </>
      )}
      {watchId && watchStatus !== "resolution_confirmed" && (
        <>
          <button
            type="button"
            onClick={refresh}
            disabled={phase.name === "working"}
            className="rounded-md border border-[rgba(255,255,255,0.2)] px-2.5 py-1 text-[11px] text-neutral-200 hover:bg-[rgba(255,255,255,0.06)] disabled:cursor-wait disabled:opacity-60"
          >
            Refresh evaluation
          </button>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="observation or confirm note"
            className="w-52 rounded-md border border-[rgba(255,255,255,0.15)] bg-black/30 px-2 py-1 text-[11px] text-neutral-200 placeholder:text-neutral-600"
          />
          <button
            type="button"
            onClick={() => observe("operator_note")}
            disabled={phase.name === "working"}
            className="rounded-md border border-[rgba(255,255,255,0.2)] px-2.5 py-1 text-[11px] text-neutral-200 hover:bg-[rgba(255,255,255,0.06)] disabled:cursor-wait disabled:opacity-60"
          >
            Record note
          </button>
          <button
            type="button"
            onClick={() => observe("verification")}
            disabled={phase.name === "working"}
            className="rounded-md border border-[rgba(255,255,255,0.2)] px-2.5 py-1 text-[11px] text-neutral-200 hover:bg-[rgba(255,255,255,0.06)] disabled:cursor-wait disabled:opacity-60"
          >
            Record verification
          </button>
          <button
            type="button"
            onClick={() => mark("still_affected")}
            disabled={phase.name === "working"}
            className="rounded-md border border-[rgba(255,180,120,0.4)] px-2.5 py-1 text-[11px] text-amber-200 hover:bg-[rgba(255,180,120,0.06)] disabled:cursor-wait disabled:opacity-60"
          >
            {armed === "mark-still_affected" ? "Confirm still affected" : "Still affected"}
          </button>
          <button
            type="button"
            onClick={() => mark("insufficient_evidence")}
            disabled={phase.name === "working"}
            className="rounded-md border border-[rgba(255,255,255,0.2)] px-2.5 py-1 text-[11px] text-neutral-400 hover:bg-[rgba(255,255,255,0.06)] disabled:cursor-wait disabled:opacity-60"
          >
            {armed === "mark-insufficient_evidence" ? "Confirm insufficient" : "Insufficient evidence"}
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={phase.name === "working"}
            className="rounded-md border border-[rgba(119,255,117,0.3)] px-2.5 py-1 text-[11px] text-[#9AFF8D] hover:bg-[rgba(119,255,117,0.08)] disabled:cursor-wait disabled:opacity-60"
          >
            {armed === "confirm" ? "Confirm RESOLUTION" : "Confirm resolution"}
          </button>
        </>
      )}
      {phase.name === "failed" && <span className="text-[11px] text-red-300">{phase.message}</span>}
      {phase.name === "confirm" && <span className="text-[11px] text-amber-200">{phase.label}</span>}
      {phase.name === "working" && <span className="text-[11px] text-neutral-400">{phase.label}</span>}
    </span>
  );
}
