import { getIncidentBrief } from "@/lib/evidence-brief";
import { realPlanStore, type PlanRow } from "@/lib/recovery-plans";
import RecoveryPlanActions from "@/components/recovery-plan-actions";

function statusLabel(status: PlanRow["status"]): { text: string; cls: string } {
  switch (status) {
    case "draft":
      return { text: "DRAFT — not reviewed", cls: "text-neutral-300 border-[rgba(255,255,255,0.25)]" };
    case "under_review":
      return { text: "UNDER REVIEW", cls: "text-amber-200 border-[rgba(255,180,120,0.4)]" };
    case "staged":
      return { text: "STAGED — for consideration, NOT approved", cls: "text-[#9AFF8D] border-[rgba(119,255,117,0.4)]" };
    case "rejected":
      return { text: "REJECTED", cls: "text-red-300 border-[rgba(255,120,120,0.4)]" };
    case "superseded":
      return { text: "SUPERSEDED by newer evidence", cls: "text-neutral-500 border-[rgba(255,255,255,0.15)]" };
  }
}

function basisLabel(tier: string): string {
  if (tier === "verified_fix") return "VERIFIED HISTORICAL FIX";
  if (tier === "documented_unverified") return "DOCUMENTED BUT UNVERIFIED";
  return "POSSIBLE MATCH";
}

/**
 * S9 Recovery Plan: durable, grounded proposals tied to the current brief
 * fingerprint. Planning and review only — this section never executes
 * anything and renders no execute control. Degrades without breaking the
 * incident page.
 */
export default async function IncidentRecoveryPlan({
  workspaceSlug,
  workspaceId,
  incidentId,
}: {
  workspaceSlug: string;
  workspaceId: string;
  incidentId: string;
}) {
  let briefFp: string | null = null;
  let briefCurrent = false;
  try {
    const brief = await getIncidentBrief(incidentId, workspaceId);
    briefFp = brief?.fingerprint ?? null;
    briefCurrent = brief?.status === "current";
  } catch {
    return (
      <div className="mt-4">
        <h2 className="text-xs font-medium text-neutral-100">Recovery Plan</h2>
        <p className="mt-1 text-[11px] text-neutral-500">
          Proposal unavailable right now (database unreachable). Incident data is unaffected.
        </p>
      </div>
    );
  }

  let store: Awaited<ReturnType<typeof realPlanStore>> | null = null;
  try {
    store = await realPlanStore();
  } catch {
    store = null;
  }
  const active = store ? await store.loadActive(incidentId, workspaceId).catch(() => []) : [];
  const history = store ? await store.loadHistory(incidentId, workspaceId).catch(() => []) : [];
  const past = history.filter((h) => !active.some((a) => a.id === h.id));

  const currentPlan = briefFp ? active.find((p) => p.brief_fingerprint === briefFp) ?? null : null;
  const stalePlans = briefFp ? active.filter((p) => p.brief_fingerprint !== briefFp) : active;

  return (
    <div className="mt-4 rounded-md border border-[rgba(119,255,117,0.14)] bg-[rgba(10,27,18,0.72)] px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xs font-medium text-neutral-100">Recovery Plan</h2>
        <RecoveryPlanActions workspaceSlug={workspaceSlug} incidentId={incidentId} plan={null} />
      </div>

      {!briefCurrent && (
        <p className="mt-1.5 text-[11px] text-neutral-400">
          No current evidence brief — proposals need grounded evidence. Generate will report what is missing
          instead of inventing a plan.
        </p>
      )}

      {!currentPlan && stalePlans.length === 0 && past.length === 0 && (
        <p className="mt-1.5 text-[11px] text-neutral-400">
          No proposal yet. Generate prepares a draft from the current evidence for human review — nothing is
          executed.
        </p>
      )}

      {currentPlan && <PlanCard plan={currentPlan} fresh workspaceSlug={workspaceSlug} incidentId={incidentId} />}

      {stalePlans.map((p) => (
        <PlanCard key={p.id} plan={p} fresh={false} workspaceSlug={workspaceSlug} incidentId={incidentId} />
      ))}

      {past.length > 0 && (
        <p className="mt-2 text-[10px] text-neutral-600">
          History:{" "}
          {past
            .slice(0, 8)
            .map((p) => `v${p.plan_version} ${p.status}`)
            .join(" · ")}
          {past.length > 8 ? ` · +${past.length - 8} more` : ""} (preserved for audit; superseded proposals are never
          deleted automatically)
        </p>
      )}
      <p className="mt-1 text-[10px] text-neutral-600">
        Proposals are review-only. Staging documents a plan for later approval consideration — it is not approval
        and triggers no action.
      </p>
    </div>
  );
}

function PlanCard({
  plan,
  fresh,
  workspaceSlug,
  incidentId,
}: {
  plan: PlanRow;
  fresh: boolean;
  workspaceSlug: string;
  incidentId: string;
}) {
  const st = statusLabel(plan.status);
  const p = plan.payload;
  return (
    <div className="mt-2 rounded-md border border-[rgba(255,255,255,0.12)] bg-[rgba(0,0,0,0.25)] px-3 py-2">
      <p className="flex flex-wrap items-center gap-2">
        <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${st.cls}`}>{st.text}</span>
        <span className="font-mono text-[10px] text-neutral-500">
          v{plan.plan_version} · brief fp {plan.brief_fingerprint.slice(0, 8)}
          {!fresh && " · stale evidence"}
        </span>
        <span className="ml-auto">
          <RecoveryPlanActions
            workspaceSlug={workspaceSlug}
            incidentId={incidentId}
            plan={{ id: plan.id, status: plan.status }}
          />
        </span>
      </p>

      <p className="mt-1.5 text-xs text-neutral-100">{p.problemSummary}</p>
      <p className="mt-0.5 text-[11px] text-neutral-400">{p.approach}</p>

      <p className="mt-2 text-[11px] font-medium text-neutral-300">
        PROPOSED STEPS ({p.steps.length}) — review only, nothing executes
      </p>
      <ol className="mt-1 space-y-1.5">
        {p.steps.map((s, i) => (
          <li key={i} className="rounded border border-[rgba(255,255,255,0.1)] px-2 py-1.5">
            <p className="text-[11px] text-neutral-100">
              <span className="font-mono text-neutral-500">{i + 1}.</span> {s.description}
            </p>
            <p className="mt-0.5 flex flex-wrap gap-1.5 text-[10px]">
              <span
                className={`rounded border px-1 py-px ${
                  s.kind === "corrective"
                    ? "border-[rgba(255,180,120,0.4)] text-amber-200"
                    : "border-[rgba(255,255,255,0.2)] text-neutral-400"
                }`}
              >
                {s.kind}
              </span>
              <span
                className={`rounded border px-1 py-px ${
                  s.risk === "high"
                    ? "border-[rgba(255,120,120,0.4)] text-red-300"
                    : s.risk === "medium"
                      ? "border-[rgba(255,180,120,0.35)] text-amber-200/90"
                      : "border-[rgba(119,255,117,0.3)] text-[#9AFF8D]"
                }`}
              >
                risk: {s.risk}
              </span>
              {s.humanRequired && (
                <span className="rounded border border-[rgba(255,255,255,0.2)] px-1 py-px text-neutral-400">
                  human required
                </span>
              )}
            </p>
            <p className="mt-0.5 text-[11px] text-neutral-400">
              <span className="text-neutral-500">Why:</span> {s.purpose}
            </p>
            {s.prerequisites.length > 0 && (
              <p className="mt-0.5 text-[11px] text-neutral-400">
                <span className="text-neutral-500">Needs first:</span> {s.prerequisites.join(" · ")}
              </p>
            )}
            <p className="mt-0.5 text-[11px] text-neutral-400">
              <span className="text-neutral-500">Expect:</span> {s.expectedResult}
            </p>
            <p className="mt-0.5 text-[11px] text-neutral-400">
              <span className="text-neutral-500">Verify by:</span> {s.verification}
            </p>
            {(s.evidenceRefs.length > 0 || s.matchRefs.length > 0) && (
              <p className="mt-0.5 font-mono text-[10px] text-neutral-600">
                grounded in:{" "}
                {[...s.evidenceRefs.map((r) => `msg ${r.slice(0, 8)}`), ...s.matchRefs.map((r) => `fix ${r.slice(0, 8)}`)].join(
                  " · ",
                )}
              </p>
            )}
          </li>
        ))}
      </ol>

      {p.prerequisites.length > 0 && (
        <p className="mt-1.5 text-[11px] text-neutral-400">
          <span className="text-neutral-500">Plan prerequisites:</span> {p.prerequisites.join(" · ")}
        </p>
      )}
      {p.missingInfo.length > 0 && (
        <p className="mt-1 text-[11px] text-neutral-400">
          <span className="text-neutral-500">Still unknown:</span> {p.missingInfo.join(" · ")}
        </p>
      )}
      {p.safetyWarnings.length > 0 && (
        <div className="mt-1.5 rounded border border-dashed border-[rgba(255,180,120,0.4)] px-2 py-1">
          {p.safetyWarnings.map((w, i) => (
            <p key={i} className="text-[11px] text-amber-200">
              ⚠ {w}
            </p>
          ))}
        </div>
      )}
      {p.expectedOutcomes.length > 0 && (
        <p className="mt-1 text-[11px] text-neutral-400">
          <span className="text-neutral-500">Expected outcomes:</span> {p.expectedOutcomes.join(" · ")}
        </p>
      )}
      {p.verificationChecks.length > 0 && (
        <p className="mt-1 text-[11px] text-neutral-400">
          <span className="text-neutral-500">Acceptance checks:</span> {p.verificationChecks.join(" · ")}
        </p>
      )}
      {p.rollbackNotes && (
        <p className="mt-1 text-[11px] text-neutral-400">
          <span className="text-neutral-500">Back-out:</span> {p.rollbackNotes}
        </p>
      )}

      {p.historicalBasis.length > 0 && (
        <div className="mt-1.5">
          <p className="text-[11px] font-medium text-neutral-300">HISTORICAL BASIS (leads, not prescriptions)</p>
          <ul className="mt-0.5 space-y-1">
            {p.historicalBasis.map((h) => (
              <li key={h.refId} className="text-[11px] text-neutral-400">
                <span className="font-mono text-[10px] text-[#9AFF8D]">fix {h.refId.slice(0, 8)}</span>{" "}
                <span className="text-neutral-500">[{basisLabel(h.tier)}]</span> {h.whatWasDocumented}{" "}
                <span className="text-neutral-500">May apply because:</span> {h.whyMayApply}{" "}
                {h.differences && (
                  <span className="text-amber-200/90">Differs: {h.differences} </span>
                )}
                {h.caution && <span className="text-amber-200">[caution] {h.caution}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {plan.review_note && (
        <p className="mt-1 text-[11px] text-neutral-500">Review note: {plan.review_note}</p>
      )}
    </div>
  );
}
