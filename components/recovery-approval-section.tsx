import { realApprovalDeps, type ApprovalRow, type ExecutionRow } from "@/lib/recovery-approvals";
import RecoveryApprovalActions from "@/components/recovery-approval-actions";

function approvalLabel(s: ApprovalRow["status"]): { text: string; cls: string } {
  switch (s) {
    case "requested":
      return { text: "APPROVAL REQUESTED", cls: "text-amber-200 border-[rgba(255,180,120,0.4)]" };
    case "approved":
      return { text: "APPROVED — manual work only, nothing auto-executes", cls: "text-[#9AFF8D] border-[rgba(119,255,117,0.4)]" };
    case "rejected":
      return { text: "APPROVAL REJECTED", cls: "text-red-300 border-[rgba(255,120,120,0.4)]" };
    case "revoked":
      return { text: "APPROVAL REVOKED", cls: "text-red-300 border-[rgba(255,120,120,0.4)]" };
    case "expired":
      return { text: "APPROVAL EXPIRED", cls: "text-neutral-500 border-[rgba(255,255,255,0.15)]" };
    case "invalidated":
      return { text: "APPROVAL INVALIDATED (plan or evidence changed)", cls: "text-neutral-500 border-[rgba(255,255,255,0.15)]" };
  }
}

function execLabel(s: ExecutionRow["status"]): string {
  switch (s) {
    case "verified_success":
      return "VERIFIED SUCCESS (reported work checked out)";
    case "verified_failure":
      return "VERIFIED FAILURE (reported work did not hold)";
    case "provider_accepted":
      return "PROVIDER ACCEPTED (not proof of recovery)";
    case "in_progress":
      return "IN PROGRESS";
    case "pending":
      return "PENDING";
    case "unknown_outcome":
      return "UNKNOWN OUTCOME — needs independent verification";
  }
}

/**
 * S10 approval + execution-control section. Read-only when data is missing;
 * never executes anything. Degrades without breaking the incident page.
 */
export default async function RecoveryApprovalSection({
  workspaceSlug,
  workspaceId,
  incidentId,
  planId,
  planStatus,
  planVersion,
  briefFingerprint,
  stepCount,
  fresh,
}: {
  workspaceSlug: string;
  workspaceId: string;
  incidentId: string;
  planId: string;
  planStatus: string;
  planVersion: number;
  briefFingerprint: string;
  stepCount: number;
  fresh: boolean;
}) {
  void incidentId;
  let approvals: ApprovalRow[] = [];
  let executions: ExecutionRow[] = [];
  try {
    const deps = await realApprovalDeps();
    [approvals, executions] = await Promise.all([
      deps.approvals.listForPlan(planId, workspaceId).catch(() => []),
      deps.executions.listForPlan(planId, workspaceId).catch(() => []),
    ]);
  } catch {
    return (
      <div className="mt-2 rounded border border-[rgba(255,255,255,0.1)] px-2 py-1.5">
        <p className="text-[11px] text-neutral-500">Approval controls unavailable right now (database unreachable).</p>
      </div>
    );
  }

  const current = approvals.find((a) => ["requested", "approved"].includes(a.status)) ?? approvals[0] ?? null;
  const past = current ? approvals.filter((a) => a.id !== current.id) : approvals;
  const planExecs = executions.filter((e) => !current || e.approval_id === current.id);

  return (
    <div className="mt-2 rounded border border-[rgba(255,255,255,0.1)] bg-black/20 px-2 py-1.5">
      <p className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-medium text-neutral-300">APPROVAL CONTROL</span>
        <span className="font-mono text-[10px] text-neutral-600">
          plan v{planVersion} · fp {briefFingerprint.slice(0, 8)}
          {!fresh && " · stale evidence"}
        </span>
        <span className="ml-auto">
          <RecoveryApprovalActions
            workspaceSlug={workspaceSlug}
            incidentId={incidentId}
            planId={planId}
            planStatus={planStatus}
            stepCount={stepCount}
            approval={
              current
                ? { id: current.id, status: current.status, highImpact: current.high_impact, scopeHash: current.scope_hash, expiresAt: current.expires_at, decidedBy: current.decided_by_user_id }
                : null
            }
            executions={planExecs.map((e) => ({ id: e.id, approvalId: e.approval_id, status: e.status, providerRef: e.provider_ref, resultNote: e.result_note }))}
          />
        </span>
      </p>

      {planStatus !== "staged" && (
        <p className="mt-1 text-[11px] text-neutral-500">Only staged plans can be approved. This proposal is {planStatus}.</p>
      )}

      {!current && planStatus === "staged" && (
        <p className="mt-1 text-[11px] text-neutral-400">
          No approval yet. Requesting approval scopes this exact plan version and evidence fingerprint — any change
          invalidates it. Meros runs no automatic recovery: approved work is recorded as manual, operator-reported
          steps with independent verification.
        </p>
      )}

      {current && (
        <div className="mt-1">
          {(() => {
            const l = approvalLabel(current.status);
            return (
              <p className="flex flex-wrap items-center gap-2">
                <span className={`rounded border px-1.5 py-px font-mono text-[10px] ${l.cls}`}>{l.text}</span>
                <span className="font-mono text-[10px] text-neutral-600">
                  scope {current.scope_hash.slice(0, 8)} · steps {current.scope.steps.map((s) => s + 1).join(",") || "—"}
                  {current.high_impact ? " · high-impact" : ""}
                  {current.expires_at ? ` · expires ${new Date(current.expires_at).toLocaleString()}` : ""}
                </span>
              </p>
            );
          })()}
          <p className="mt-0.5 text-[11px] text-neutral-500">
            Automatic execution: unsupported — no verified provider adapter exists for recovery operations. Use manual
            fallback below.
          </p>
        </div>
      )}

      {planExecs.length > 0 && (
        <ul className="mt-1 space-y-1">
          {planExecs.map((e) => (
            <li key={e.id} className="rounded border border-[rgba(255,255,255,0.08)] px-2 py-1">
              <p className="font-mono text-[10px] text-neutral-400">
                {execLabel(e.status)} · manual record {e.id.slice(0, 8)}
                {e.provider_ref ? ` · ref ${e.provider_ref}` : ""}
              </p>
              {e.result_note && <p className="mt-0.5 text-[11px] text-neutral-400">Reported: {e.result_note}</p>}
              {e.verification_evidence && (
                <p className="mt-0.5 text-[11px] text-neutral-400">Verification: {e.verification_evidence}</p>
              )}
              {e.status === "unknown_outcome" && (
                <p className="mt-0.5 text-[10px] text-amber-200/80">
                  Requires manual intervention + independent verification before any success can be claimed.
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      {past.length > 0 && (
        <p className="mt-1 text-[10px] text-neutral-600">
          Approval history: {past.slice(0, 6).map((a) => `${a.status}`).join(" · ")}
          {past.length > 6 ? ` · +${past.length - 6} more` : ""} (preserved for audit)
        </p>
      )}
      <p className="mt-1 text-[10px] text-neutral-600">
        Approval ≠ execution. Verified manual work ≠ customer recovery. Incidents are never auto-resolved.
      </p>
    </div>
  );
}
