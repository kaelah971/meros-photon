import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getWorkspaceBySlug } from "@/lib/db";
import { realPlanStore, reviewPlan, type ReviewAction } from "@/lib/recovery-plans";
import { requireStaff } from "@/lib/support-ops";

function statusOf(e: unknown, fallback: number): number {
  const s = (e as { status?: unknown })?.status;
  return typeof s === "number" ? s : fallback;
}

const ACTIONS: readonly ReviewAction[] = ["submit_for_review", "stage", "reject"];

/**
 * S9 operator review: staff-only transitions draft → under_review → staged
 * or → rejected, with actor attribution + timeline audit. Staged means
 * documented for later approval consideration — never approval, and there
 * is no execute path anywhere in S9.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string; planId: string }> }) {
  let body: { workspaceSlug?: unknown; action?: unknown; note?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  const action = typeof body.action === "string" ? body.action : "";
  if (!(ACTIONS as readonly string[]).includes(action)) {
    return NextResponse.json(
      { ok: false, error: "action must be submit_for_review, stage, or reject" },
      { status: 400 },
    );
  }
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : null;

  try {
    const user = await requireUser();
    const slug = typeof body.workspaceSlug === "string" ? body.workspaceSlug.trim() : "";
    const ws = slug ? await getWorkspaceBySlug(slug) : null;
    if (!ws) return NextResponse.json({ ok: false, error: "workspace not found" }, { status: 404 });
    await requireStaff(user.id, ws.id);
    const { planId } = await ctx.params;

    const store = await realPlanStore();
    const result = await reviewPlan(planId, ws.id, user.id, action as ReviewAction, note || null, {
      store,
    });
    if (result.action === "reviewed") {
      return NextResponse.json({
        ok: true,
        plan: { id: result.plan.id, version: result.plan.plan_version, status: result.plan.status },
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
