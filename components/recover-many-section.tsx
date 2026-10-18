import { realRecoverManyDeps } from "@/lib/recover-many";
import RecoverManyActions from "@/components/recover-many-actions";
import RecoverManyRecipientCard from "@/components/recover-many-recipient";

/**
 * S15E Recover Many: per-customer reviewable recovery guidance for one
 * incident. Server-rendered from persisted records; all mutations go
 * through staff-gated routes with exact-payload checks. Degrades without
 * breaking the incident page.
 */
export default async function RecoverManySection({
  workspaceSlug,
  workspaceId,
  incidentId,
}: {
  workspaceSlug: string;
  workspaceId: string;
  incidentId: string;
}) {
  let batch: {
    id: string;
    status: string;
    high_impact: boolean;
  } | null = null;
  let recipients: {
    id: string;
    conversation_id: string;
    customer_id: string;
    eligibility: string;
    reason_code: string;
    evidence_refs: string[];
    draft_text: string;
    status: string;
    provider_message_id: string | null;
    error_note: string | null;
  }[] = [];
  let failed = false;
  try {
    const deps = await realRecoverManyDeps();
    const b = await deps.batches.activeForIncident(incidentId, workspaceId).catch(() => null);
    batch = b ? { id: b.id, status: b.status, high_impact: b.high_impact } : null;
    if (batch) {
      recipients = await deps.recipients.listForBatch(batch.id, workspaceId).catch(() => []);
    }
  } catch {
    failed = true;
  }

  const counts = {
    eligible: recipients.filter((r) => r.eligibility === "eligible").length,
    review: recipients.filter((r) => r.eligibility === "needs_review").length,
    excluded: recipients.filter((r) => r.eligibility === "excluded").length,
  };

  return (
    <div className="mt-4 rounded-md border border-[rgba(119,255,117,0.14)] bg-[rgba(10,27,18,0.72)] px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xs font-medium text-neutral-100">
          Recover Many
          {batch ? (
            <span className="ml-2 font-mono text-[10px] text-neutral-500">
              {counts.eligible} eligible · {counts.review} need review · {counts.excluded} excluded
            </span>
          ) : null}
        </h2>
        {!failed && (
          <RecoverManyActions
            workspaceSlug={workspaceSlug}
            incidentId={incidentId}
            batch={batch ? { id: batch.id, status: batch.status, highImpact: batch.high_impact } : null}
          />
        )}
      </div>

      {failed && (
        <p className="mt-1 text-[11px] text-neutral-500">
          Recovery staging is unavailable right now (database unreachable). Incident data is unaffected.
        </p>
      )}

      {!failed && !batch && (
        <p className="mt-1.5 text-[11px] text-neutral-400">
          No customer batch yet. Proposing one evaluates every linked customer against the current evidence and stages
          individualized drafts — nothing is sent, and only eligible recipients can ever be published.
        </p>
      )}

      {!failed && batch && (
        <div className="mt-2 space-y-2">
          {recipients.map((r) => (
            <RecoverManyRecipientCard
              key={r.id}
              workspaceSlug={workspaceSlug}
              incidentId={incidentId}
              batchId={batch!.id}
              batchStatus={batch!.status}
              recipient={{
                id: r.id,
                conversationId: r.conversation_id,
                customerId: r.customer_id,
                eligibility: r.eligibility,
                reasonCode: r.reason_code,
                evidenceRefs: r.evidence_refs,
                draft: r.draft_text,
                status: r.status,
                providerMessageId: r.provider_message_id,
                errorNote: r.error_note,
              }}
            />
          ))}
          {recipients.length === 0 && (
            <p className="text-[11px] text-neutral-500">Batch has no recipients.</p>
          )}
        </div>
      )}
      <p className="mt-1 text-[10px] text-neutral-600">
        Approval authorizes exact drafts only; editing invalidates it. Publishing writes to that customer&apos;s own
        conversation as a staff message — never a delivery or recovery claim.
      </p>
    </div>
  );
}
