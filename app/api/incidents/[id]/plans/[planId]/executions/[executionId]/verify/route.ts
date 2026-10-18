import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getWorkspaceBySlug } from "@/lib/db";
import { realApprovalDeps, verifyManualExecution } from "@/lib/recovery-approvals";
import { requireStaff } from "@/lib/support-ops";

function statusOf(e: unknown, fallback: number): number {
  const s = (e as { status?: unknown })?.status;
  return typeof s === "number" ? s : fallback;
}

/**
 * S10 independent verification: staff-only, verifier must differ from the
 * recorder. Evidence required. Verified success means the reported work
 * checked out — not that customers recovered (S11 owns resolution).
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string; planId: string; executionId: string }> },
) {
  let body: { workspaceSlug?: unknown; outcome?: unknown; evidence?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  const outcome = typeof body.outcome === "string" ? body.outcome : "";
  if (outcome !== "verified_success" && outcome !== "verified_failure") {
    return NextResponse.json({ ok: false, error: "outcome must be verified_success or verified_failure" }, { status: 400 });
  }
  try {
    const user = await requireUser();
    const slug = typeof body.workspaceSlug === "string" ? body.workspaceSlug.trim() : "";
    const ws = slug ? await getWorkspaceBySlug(slug) : null;
    if (!ws) return NextResponse.json({ ok: false, error: "workspace not found" }, { status: 404 });
    await requireStaff(user.id, ws.id);
    const { executionId } = await ctx.params;
    const result = await verifyManualExecution(
      executionId,
      ws.id,
      user.id,
      outcome,
      typeof body.evidence === "string" ? body.evidence : "",
      await realApprovalDeps(),
    );
    if (result.action === "verified") {
      return NextResponse.json({
        ok: true,
        execution: { id: result.execution.id, status: result.execution.status },
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
