import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getWorkspaceBySlug } from "@/lib/db";
import { realApprovalDeps, requestApproval, SUPPORTED_ACTION_TYPES } from "@/lib/recovery-approvals";
import { requireStaff } from "@/lib/support-ops";

function statusOf(e: unknown, fallback: number): number {
  const s = (e as { status?: unknown })?.status;
  return typeof s === "number" ? s : fallback;
}

/**
 * S10 approval request: staff-only, staged plans only, exact scope.
 * Only `manual_external_record` is supported — Meros runs no automatic
 * provider-backed recovery. High-impact scopes require riskAck.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string; planId: string }> }) {
  let body: {
    workspaceSlug?: unknown;
    actionType?: unknown;
    steps?: unknown;
    params?: unknown;
    riskAck?: unknown;
    expiresInHours?: unknown;
    note?: unknown;
    idempotencyKey?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  void body.idempotencyKey;
  try {
    const user = await requireUser();
    const slug = typeof body.workspaceSlug === "string" ? body.workspaceSlug.trim() : "";
    const ws = slug ? await getWorkspaceBySlug(slug) : null;
    if (!ws) return NextResponse.json({ ok: false, error: "workspace not found" }, { status: 404 });
    await requireStaff(user.id, ws.id);
    const { planId } = await ctx.params;

    const actionType = typeof body.actionType === "string" ? body.actionType : "manual_external_record";
    if (!(SUPPORTED_ACTION_TYPES as readonly string[]).includes(actionType)) {
      return NextResponse.json({ ok: false, error: "no_supported_executor" }, { status: 400 });
    }
    const steps = Array.isArray(body.steps) ? (body.steps as unknown[]).filter((n) => Number.isInteger(n)) as number[] : [];
    const params =
      body.params && typeof body.params === "object" && !Array.isArray(body.params)
        ? (body.params as Record<string, unknown>)
        : {};
    const result = await requestApproval(planId, ws.id, user.id, {
      actionType: actionType as "manual_external_record",
      steps,
      params,
      riskAck: body.riskAck === true,
      expiresInHours: typeof body.expiresInHours === "number" ? body.expiresInHours : 24,
      note: typeof body.note === "string" ? body.note : null,
    }, await realApprovalDeps());
    if (result.action === "requested" || result.action === "duplicate") {
      return NextResponse.json({
        ok: true,
        action: result.action,
        approval: { id: result.approval.id, status: result.approval.status, scopeHash: result.approval.scope_hash },
      });
    }
    return NextResponse.json({ ok: false, error: result.reason }, { status: 409 });
  } catch (e) {
    const status = statusOf(e, 503);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "request failed" },
      { status: status === 401 ? 401 : status },
    );
  }
}

/** List approvals for a plan (staff-only, workspace-scoped). */
export async function GET(req: Request, ctx: { params: Promise<{ id: string; planId: string }> }) {
  try {
    const user = await requireUser();
    const slug = new URL(req.url).searchParams.get("workspaceSlug") ?? "";
    const ws = slug ? await getWorkspaceBySlug(slug) : null;
    if (!ws) return NextResponse.json({ ok: false, error: "workspace not found" }, { status: 404 });
    await requireStaff(user.id, ws.id);
    const { planId } = await ctx.params;
    const deps = await realApprovalDeps();
    const [approvals, executions] = await Promise.all([
      deps.approvals.listForPlan(planId, ws.id).catch(() => []),
      deps.executions.listForPlan(planId, ws.id).catch(() => []),
    ]);
    return NextResponse.json({ ok: true, approvals, executions });
  } catch (e) {
    const status = statusOf(e, 503);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "request failed" },
      { status: status === 401 ? 401 : status },
    );
  }
}
