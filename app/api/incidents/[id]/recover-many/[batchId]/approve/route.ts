import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getWorkspaceBySlug } from "@/lib/db";
import { approveBatch, realRecoverManyDeps } from "@/lib/recover-many";
import { requireStaff } from "@/lib/support-ops";

function statusOf(e: unknown, fallback: number): number {
  const s = (e as { status?: unknown })?.status;
  return typeof s === "number" ? s : fallback;
}

/**
 * S15E batch approval: staff-only, exact-payload, fingerprint-gated.
 * Approving never sends anything; it only authorizes later per-recipient
 * publishes of the exact approved drafts.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string; batchId: string }> }) {
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
    const { id, batchId } = await ctx.params;
    const deps = await realRecoverManyDeps();
    const batch = await deps.batches.loadById(batchId, ws.id);
    if (!batch || batch.incident_id !== id) {
      return NextResponse.json({ ok: false, error: "batch not found for this incident" }, { status: 404 });
    }
    const result = await approveBatch(batchId, ws.id, user.id, deps);
    if (result.action === "decided") {
      return NextResponse.json({ ok: true, batch: { id: result.batch.id, status: result.batch.status } });
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
