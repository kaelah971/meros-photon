"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Phase = { name: "idle" } | { name: "working"; label: string } | { name: "failed"; message: string } | { name: "confirm"; label: string };

export type ApprovalLite = {
  id: string;
  status: string;
  highImpact: boolean;
  scopeHash: string;
  expiresAt: string | null;
  decidedBy: string | null;
};

export type ExecutionLite = {
  id: string;
  approvalId: string;
  status: string;
  providerRef: string | null;
  resultNote: string | null;
};

/**
 * S10 operator approval + manual-work controls. Every mutating action needs
 * an explicit second click (confirm). Approve of high-impact scopes
 * additionally needs the risk checkbox. Claims record operator-reported
 * manual work only — Meros executes nothing automatically.
 */
export default function RecoveryApprovalActions({
  workspaceSlug,
  incidentId,
  planId,
  planStatus,
  stepCount,
  approval,
  executions,
}: {
  workspaceSlug: string;
  incidentId: string;
  planId: string;
  planStatus: string;
  stepCount: number;
  approval: ApprovalLite | null;
  executions: ExecutionLite[];
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ name: "idle" });
  const [riskAck, setRiskAck] = useState(false);
  const [armed, setArmed] = useState<string | null>(null);
  const [externalRef, setExternalRef] = useState("");
  const [resultNote, setResultNote] = useState("");
  const [evidence, setEvidence] = useState("");
  const [claimKey, setClaimKey] = useState<string | null>(null);

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
        router.refresh();
        return;
      }
      setPhase({ name: "failed", message: data.error ?? `request failed (${res.status})` });
    } catch (e) {
      setPhase({ name: "failed", message: e instanceof Error ? e.message : "request failed" });
    }
  }

  /** First click arms, second click confirms. Returns true when confirmed. */
  function ask(key: string, label: string): boolean {
    if (armed === key) {
      setArmed(null);
      return true;
    }
    setArmed(key);
    setPhase({ name: "confirm", label });
    return false;
  }

  const request = () =>
    post(
      `/api/incidents/${incidentId}/plans/${planId}/approvals`,
      {
        actionType: "manual_external_record",
        steps: Array.from({ length: stepCount }, (_, i) => i),
        params: {},
        riskAck: true,
      },
      "Requesting…",
    );

  const decide = (decision: "approve" | "reject" | "revoke") => {
    if (!approval) return;
    if (!ask(decision, `Click again to confirm ${decision}`)) return;
    if (decision === "approve" && approval.highImpact && !riskAck) {
      setPhase({ name: "failed", message: "High-impact approval needs the risk checkbox first." });
      return;
    }
    post(`/api/incidents/${incidentId}/plans/${planId}/approvals/${approval.id}/decision`, { decision }, "Saving…");
  };

  const claim = () => {
    if (!approval) return;
    if (!ask("claim", "Click again to confirm: work was done OUTSIDE Meros")) return;
    const key = claimKey ?? (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
    setClaimKey(key);
    post(
      `/api/incidents/${incidentId}/plans/${planId}/executions`,
      { approvalId: approval.id, idempotencyKey: key, externalRef: externalRef.trim() || undefined, resultNote: resultNote.trim() || undefined },
      "Recording…",
    );
  };

  const verify = (executionId: string, outcome: "verified_success" | "verified_failure") => {
    if (!ask(`verify-${executionId}-${outcome}`, `Click again to confirm ${outcome.replace("verified_", "")}`)) return;
    if (!evidence.trim()) {
      setPhase({ name: "failed", message: "Verification evidence is required." });
      return;
    }
    post(`/api/incidents/${incidentId}/plans/${planId}/executions/${executionId}/verify`, { outcome, evidence: evidence.trim() }, "Verifying…");
  };

  if (planStatus !== "staged") return null;
  const needsRequest = !approval || ["rejected", "revoked", "expired", "invalidated"].includes(approval.status);
  const pendingExecs = executions.filter((e) => e.approvalId === approval?.id && !["verified_success", "verified_failure"].includes(e.status));

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {needsRequest && (
        <button
          type="button"
          onClick={() => (ask("request", "Click again to request approval") ? request() : null)}
          disabled={phase.name === "working"}
          className="rounded-md border border-[rgba(119,255,117,0.3)] px-2.5 py-1 text-[11px] text-[#9AFF8D] hover:bg-[rgba(119,255,117,0.08)] disabled:cursor-wait disabled:opacity-60"
        >
          {phase.name === "working" ? phase.label : armed === "request" ? "Confirm request" : "Request approval"}
        </button>
      )}
      {approval?.status === "requested" && (
        <>
          <label className="inline-flex items-center gap-1 text-[11px] text-neutral-400">
            <input type="checkbox" checked={riskAck} onChange={(e) => setRiskAck(e.target.checked)} />
            risk acknowledged
          </label>
          <button
            type="button"
            onClick={() => decide("approve")}
            disabled={phase.name === "working"}
            className="rounded-md border border-[rgba(119,255,117,0.3)] px-2.5 py-1 text-[11px] text-[#9AFF8D] hover:bg-[rgba(119,255,117,0.08)] disabled:cursor-wait disabled:opacity-60"
          >
            {armed === "approve" ? "Confirm approve" : "Approve"}
          </button>
          <button
            type="button"
            onClick={() => decide("reject")}
            disabled={phase.name === "working"}
            className="rounded-md border border-[rgba(255,120,120,0.3)] px-2.5 py-1 text-[11px] text-red-300 hover:bg-[rgba(255,120,120,0.06)] disabled:cursor-wait disabled:opacity-60"
          >
            {armed === "reject" ? "Confirm reject" : "Reject"}
          </button>
        </>
      )}
      {approval?.status === "approved" && (
        <>
          <button
            type="button"
            onClick={() => decide("revoke")}
            disabled={phase.name === "working"}
            className="rounded-md border border-[rgba(255,120,120,0.3)] px-2.5 py-1 text-[11px] text-red-300 hover:bg-[rgba(255,120,120,0.06)] disabled:cursor-wait disabled:opacity-60"
          >
            {armed === "revoke" ? "Confirm revoke" : "Revoke"}
          </button>
          <input
            value={externalRef}
            onChange={(e) => setExternalRef(e.target.value)}
            placeholder="external ref (ticket, change #)"
            className="w-44 rounded-md border border-[rgba(255,255,255,0.15)] bg-black/30 px-2 py-1 text-[11px] text-neutral-200 placeholder:text-neutral-600"
          />
          <input
            value={resultNote}
            onChange={(e) => setResultNote(e.target.value)}
            placeholder="what was done outside Meros"
            className="w-52 rounded-md border border-[rgba(255,255,255,0.15)] bg-black/30 px-2 py-1 text-[11px] text-neutral-200 placeholder:text-neutral-600"
          />
          <button
            type="button"
            onClick={claim}
            disabled={phase.name === "working"}
            className="rounded-md border border-[rgba(255,255,255,0.2)] px-2.5 py-1 text-[11px] text-neutral-200 hover:bg-[rgba(255,255,255,0.06)] disabled:cursor-wait disabled:opacity-60"
          >
            {armed === "claim" ? "Confirm manual record" : "Record manual work"}
          </button>
        </>
      )}
      {pendingExecs.length > 0 && (
        <span className="inline-flex flex-wrap items-center gap-2">
          <input
            value={evidence}
            onChange={(e) => setEvidence(e.target.value)}
            placeholder="verification evidence (required)"
            className="w-52 rounded-md border border-[rgba(255,255,255,0.15)] bg-black/30 px-2 py-1 text-[11px] text-neutral-200 placeholder:text-neutral-600"
          />
          {pendingExecs.map((e) => (
            <span key={e.id} className="inline-flex items-center gap-1">
              <button
                type="button"
                onClick={() => verify(e.id, "verified_success")}
                disabled={phase.name === "working"}
                className="rounded-md border border-[rgba(119,255,117,0.3)] px-2 py-1 text-[10px] text-[#9AFF8D] hover:bg-[rgba(119,255,117,0.08)] disabled:opacity-60"
              >
                Verify success
              </button>
              <button
                type="button"
                onClick={() => verify(e.id, "verified_failure")}
                disabled={phase.name === "working"}
                className="rounded-md border border-[rgba(255,120,120,0.3)] px-2 py-1 text-[10px] text-red-300 hover:bg-[rgba(255,120,120,0.06)] disabled:opacity-60"
              >
                Verify failure
              </button>
            </span>
          ))}
        </span>
      )}
      {phase.name === "failed" && <span className="text-[11px] text-red-300">{phase.message}</span>}
      {phase.name === "confirm" && <span className="text-[11px] text-amber-200">{phase.label}</span>}
    </span>
  );
}
