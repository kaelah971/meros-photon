import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getWorkspaceBySlug } from "@/lib/db";
import { decideApproval, realApprovalDeps } from "@/lib/recovery-approvals";
import { requireStaff } from "@/lib/support-ops";

function statusOf(e: unknown, fallback: number): number {
  const s = (e as { status?: unknown })?.status;
  return typeof s === "number" ? s : fallback;
}

const DECISIONS = ["approve", "reject", "revoke"] as const;

/**
 * S10 approval decision: staff-only. High-impact approve requires an
 * independent reviewer (no self-approval) plus recorded risk_ack.
 * Revoke ends an approved scope; staged never implies approved.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string; planId: string; approvalId: string }> }) {
  let body: { workspaceSlug?: unknown; decision?: unknown; note?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  const decision = typeof body.decision === "string" ? body.decision : "";
  if (!(DECISIONS as readonly string[]).includes(decision)) {
    return NextResponse.json({ ok: false, error: "decision must be approve, reject, or revoke" }, { status: 400 });
  }
  try {
    const user = await requireUser();
    const slug = typeof body.workspaceSlug === "string" ? body.workspaceSlug.trim() : "";
    const ws = slug ? await getWorkspaceBySlug(slug) : null;
    if (!ws) return NextResponse.json({ ok: false, error: "workspace not found" }, { status: 404 });
    await requireStaff(user.id, ws.id);
    const { approvalId } = await ctx.params;
    const result = await decideApproval(
      approvalId,
      ws.id,
      user.id,
      decision as "approve" | "reject" | "revoke",
      typeof body.note === "string" ? body.note : null,
      await realApprovalDeps(),
    );
    if (result.action === "decided") {
      return NextResponse.json({
        ok: true,
        approval: { id: result.approval.id, status: result.approval.status },
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
