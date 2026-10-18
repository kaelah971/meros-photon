import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getWorkspaceBySlug } from "@/lib/db";
import { proposeBatch, realRecoverManyDeps } from "@/lib/recover-many";
import { requireStaff } from "@/lib/support-ops";

function statusOf(e: unknown, fallback: number): number {
  const s = (e as { status?: unknown })?.status;
  return typeof s === "number" ? s : fallback;
}

function serializeBatch(b: {
  id: string;
  status: string;
  plan_version: number;
  brief_fingerprint: string;
  fingerprint: string;
  high_impact: boolean;
  approved_by_user_id: string | null;
  approved_at: string | null;
}) {
  return {
    id: b.id,
    status: b.status,
    planVersion: b.plan_version,
    briefFingerprint: b.brief_fingerprint,
    fingerprint: b.fingerprint,
    highImpact: b.high_impact,
    approvedBy: b.approved_by_user_id,
    approvedAt: b.approved_at,
  };
}

function serializeRecipient(r: {
  id: string;
  conversation_id: string;
  customer_id: string;
  eligibility: string;
  reason_code: string;
  evidence_refs: string[];
  draft_text: string;
  payload_hash: string;
  status: string;
  provider_message_id: string | null;
  error_note: string | null;
  decided_at: string | null;
}) {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    customerId: r.customer_id,
    eligibility: r.eligibility,
    reasonCode: r.reason_code,
    evidenceRefs: r.evidence_refs,
    draft: r.draft_text,
    payloadHash: r.payload_hash,
    status: r.status,
    providerMessageId: r.provider_message_id,
    errorNote: r.error_note,
    decidedAt: r.decided_at,
  };
}

/**
 * S15E Recover Many: per-recipient grounding is derived from persisted
 * evidence; proposing never sends. Idempotent per incident+evidence.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const slug = new URL(req.url).searchParams.get("workspaceSlug") ?? "";
    const ws = slug ? await getWorkspaceBySlug(slug) : null;
    if (!ws) return NextResponse.json({ ok: false, error: "workspace not found" }, { status: 404 });
    await requireStaff(user.id, ws.id);
    const { id } = await ctx.params;
    const deps = await realRecoverManyDeps();
    const batch = await deps.batches.activeForIncident(id, ws.id);
    if (!batch) return NextResponse.json({ ok: true, batch: null, recipients: [] });
    const recipients = await deps.recipients.listForBatch(batch.id, ws.id).catch(() => []);
    return NextResponse.json({ ok: true, batch: serializeBatch(batch), recipients: recipients.map(serializeRecipient) });
  } catch (e) {
    const status = statusOf(e, 503);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "request failed" },
      { status: status === 401 ? 401 : status },
    );
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let body: { workspaceSlug?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  try {
    const user = await requireUser();
    const slug = typeof body.workspaceSlug === "string" ? body.workspaceSlug.trim() : "";
    const ws = slug ? await getWorkspaceBySlug(slug) : null;
    if (!ws) return NextResponse.json({ ok: false, error: "workspace not found" }, { status: 404 });
    await requireStaff(user.id, ws.id);
    const { id } = await ctx.params;
    const result = await proposeBatch(id, ws.id, user.id, await realRecoverManyDeps());
    if (result.action === "deferred") {
      return NextResponse.json({ ok: false, error: result.reason }, { status: 409 });
    }
    return NextResponse.json({
      ok: true,
      action: result.action,
      batch: serializeBatch(result.batch),
      recipients: result.recipients.map(serializeRecipient),
    });
  } catch (e) {
    const status = statusOf(e, 503);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "request failed" },
      { status: status === 401 ? 401 : status },
    );
  }
}
