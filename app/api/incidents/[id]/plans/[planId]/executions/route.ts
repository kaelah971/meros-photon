import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getWorkspaceBySlug } from "@/lib/db";
import { claimManualExecution, realApprovalDeps } from "@/lib/recovery-approvals";
import { requireStaff } from "@/lib/support-ops";

function statusOf(e: unknown, fallback: number): number {
  const s = (e as { status?: unknown })?.status;
  return typeof s === "number" ? s : fallback;
}

/**
 * S10 manual-work claim: staff-only, idempotent on (workspace,
 * idempotencyKey). Records that an APPROVED scope was handled OUTSIDE
 * Meros — initial state is unknown_outcome until independent verification.
 * Meros executes nothing here.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string; planId: string }> }) {
  let body: {
    workspaceSlug?: unknown;
    approvalId?: unknown;
    idempotencyKey?: unknown;
    externalRef?: unknown;
    resultNote?: unknown;
  };
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
    const approvalId = typeof body.approvalId === "string" ? body.approvalId : "";
    if (!approvalId) return NextResponse.json({ ok: false, error: "approvalId is required" }, { status: 400 });
    const key =
      typeof body.idempotencyKey === "string" && body.idempotencyKey.trim()
        ? body.idempotencyKey.trim().slice(0, 128)
        : randomUUID();
    const result = await claimManualExecution(approvalId, ws.id, user.id, {
      idempotencyKey: key,
      externalRef: typeof body.externalRef === "string" ? body.externalRef : null,
      resultNote: typeof body.resultNote === "string" ? body.resultNote : null,
    }, await realApprovalDeps());
    if (result.action === "claimed" || result.action === "duplicate") {
      return NextResponse.json({
        ok: true,
        action: result.action,
        execution: { id: result.execution.id, status: result.execution.status },
        idempotencyKey: key,
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
