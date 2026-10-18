import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getWorkspaceBySlug } from "@/lib/db";
import { realBatchStore } from "@/lib/recover-many";
import { requireStaff } from "@/lib/support-ops";

function statusOf(e: unknown, fallback: number): number {
  const s = (e as { status?: unknown })?.status;
  return typeof s === "number" ? s : fallback;
}

/**
 * S15E batch revocation: staff-only. A revoked approval can never be used;
 * publish paths re-check batch status, and revoked stays terminal.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string; batchId: string }> }) {
  let body: { workspaceSlug?: unknown; note?: unknown };
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
    const store = await realBatchStore();
    const current = await store.loadById(batchId, ws.id);
    if (!current || current.incident_id !== id) {
      return NextResponse.json({ ok: false, error: "batch not found for this incident" }, { status: 404 });
    }
    try {
      const batch = await store.finalizeDecision({
        batchId,
        workspaceId: ws.id,
        to: "revoked",
        actorUserId: user.id,
        note: typeof body.note === "string" ? body.note : null,
      });
      return NextResponse.json({ ok: true, batch: { id: batch.id, status: batch.status } });
    } catch (e) {
      const status = (e as { status?: unknown })?.status === 404 ? 404 : 409;
      return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "revoke failed" }, { status });
    }
  } catch (e) {
    const status = statusOf(e, 503);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "request failed" },
      { status: status === 401 ? 401 : status },
    );
  }
}
