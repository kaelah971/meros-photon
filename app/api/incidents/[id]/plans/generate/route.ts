import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getWorkspaceBySlug } from "@/lib/db";
import { generatePlanIfNeeded, realPlanDeps, realPlanStore } from "@/lib/recovery-plans";
import { requireStaff } from "@/lib/support-ops";

function statusOf(e: unknown, fallback: number): number {
  const s = (e as { status?: unknown })?.status;
  return typeof s === "number" ? s : fallback;
}

/**
 * S9 explicit plan generation: staff-only, idempotent, read-only in effect.
 * Returns the existing proposal when the evidence fingerprint is unchanged
 * (zero model calls); otherwise drafts a new grounded proposal and
 * supersedes older-fingerprint proposals. Never executes anything.
 */
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

    const result = await generatePlanIfNeeded(id, ws.id, user.id, await realPlanDeps());

    if (result.action === "built" || result.action === "unchanged") {
      return NextResponse.json({
        ok: true,
        action: result.action,
        plan: serializePlan(result.plan),
        note:
          result.action === "unchanged"
            ? "Evidence unchanged — returned the current proposal with no recompute."
            : "Draft proposal created for review. Nothing was executed.",
      });
    }
    if (result.action === "insufficient") {
      return NextResponse.json(
        { ok: true, action: "insufficient", reason: result.reason, plan: null },
      );
    }
    if (result.action === "in_progress") {
      return NextResponse.json({ ok: true, action: "in_progress", plan: null }, { status: 202 });
    }
    if (result.action === "failed") {
      const store = await realPlanStore();
      const active = await store.loadActive(id, ws.id).catch(() => []);
      return NextResponse.json(
        {
          ok: false,
          action: "failed",
          error: result.error,
          recoverable: true,
          plan: active[0] ? serializePlan(active[0]) : null,
        },
        { status: 502 },
      );
    }
    return NextResponse.json({ ok: true, action: result.action, plan: null });
  } catch (e) {
    const status = statusOf(e, 503);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "request failed" },
      { status: status === 401 ? 401 : status },
    );
  }
}

function serializePlan(plan: {
  id: string;
  plan_version: number;
  status: string;
  brief_fingerprint: string;
  brief_version: number;
  payload: unknown;
  review_note: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}) {
  return {
    id: plan.id,
    version: plan.plan_version,
    status: plan.status,
    briefFingerprint: plan.brief_fingerprint,
    briefVersion: plan.brief_version,
    payload: plan.payload,
    reviewNote: plan.review_note,
    reviewedAt: plan.reviewed_at,
    createdAt: plan.created_at,
    updatedAt: plan.updated_at,
  };
}
