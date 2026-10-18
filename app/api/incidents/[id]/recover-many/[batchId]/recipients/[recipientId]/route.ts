import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getWorkspaceBySlug } from "@/lib/db";
import { editRecipientDraft, publishRecipient, realRecoverManyDeps } from "@/lib/recover-many";
import { requireStaff } from "@/lib/support-ops";

function statusOf(e: unknown, fallback: number): number {
  const s = (e as { status?: unknown })?.status;
  return typeof s === "number" ? s : fallback;
}

function serializeRecipient(r: {
  id: string;
  eligibility: string;
  reason_code: string;
  evidence_refs: string[];
  draft_text: string;
  payload_hash: string;
  status: string;
  provider_message_id: string | null;
  error_note: string | null;
}) {
  return {
    id: r.id,
    eligibility: r.eligibility,
    reasonCode: r.reason_code,
    evidenceRefs: r.evidence_refs,
    draft: r.draft_text,
    payloadHash: r.payload_hash,
    status: r.status,
    providerMessageId: r.provider_message_id,
    errorNote: r.error_note,
  };
}

/**
 * S15E per-recipient draft edit: staff-only. Any edit invalidates an
 * existing batch approval (re-review required before any publish).
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string; batchId: string; recipientId: string }> }) {
  let body: { workspaceSlug?: unknown; text?: unknown };
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
    const { id, batchId, recipientId } = await ctx.params;
    const deps = await realRecoverManyDeps();
    const batch = await deps.batches.loadById(batchId, ws.id);
    if (!batch || batch.incident_id !== id) {
      return NextResponse.json({ ok: false, error: "batch not found for this incident" }, { status: 404 });
    }
    const result = await editRecipientDraft(
      batchId,
      recipientId,
      ws.id,
      user.id,
      typeof body.text === "string" ? body.text : "",
      deps,
    );
    if (result.action === "updated") {
      return NextResponse.json({ ok: true, recipient: serializeRecipient(result.recipient) });
    }
    const status = result.reason.includes("not found") ? 404 : 409;
    return NextResponse.json({ ok: false, error: result.reason }, { status });
  } catch (e) {
    const status = statusOf(e, 503);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "request failed" },
      { status: status === 401 ? 401 : status },
    );
  }
}

/**
 * S15E per-recipient publish: staff-only, explicit, separate from approval.
 * Writes the EXACT approved draft into that customer's own conversation as
 * a staff-authored message. Idempotent; freshness-gated; never implies
 * delivery, reading, or recovery.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string; batchId: string; recipientId: string }> }) {
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
    const { id, batchId, recipientId } = await ctx.params;
    const deps = await realRecoverManyDeps();
    const batch = await deps.batches.loadById(batchId, ws.id);
    if (!batch || batch.incident_id !== id) {
      return NextResponse.json({ ok: false, error: "batch not found for this incident" }, { status: 404 });
    }
    const result = await publishRecipient(batchId, recipientId, ws.id, user.id, deps);
    if (result.action === "published") {
      return NextResponse.json({
        ok: true,
        deduped: result.deduped,
        recipient: serializeRecipient(result.recipient),
      });
    }
    const status = result.reason.includes("not found") ? 404 : 409;
    return NextResponse.json({ ok: false, error: result.reason }, { status });
  } catch (e) {
    const status = statusOf(e, 503);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "request failed" },
      { status: status === 401 ? 401 : status },
    );
  }
}
