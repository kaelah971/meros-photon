import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getWorkspaceBySlug } from "@/lib/db";
import { transitionIncident, type IncidentStatus } from "@/lib/incidents";
import { requireStaff } from "@/lib/support-ops";

function statusOf(e: unknown, fallback: number): number {
  const s = (e as { status?: unknown })?.status;
  return typeof s === "number" ? s : fallback;
}

/** Explicit lifecycle transition with validation + timeline entry. */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  let body: {
    workspaceSlug?: unknown;
    to?: unknown;
    resolutionSummary?: unknown;
    reason?: unknown;
    mergedIntoIncidentId?: unknown;
    closureMode?: unknown;
    closureReason?: unknown;
    postmortemId?: unknown;
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
    const { id } = await ctx.params;
    const closureMode = typeof body.closureMode === "string" ? body.closureMode : null;
    const updated = await transitionIncident({
      incidentId: id,
      workspaceId: ws.id,
      to: (typeof body.to === "string" ? body.to : "") as IncidentStatus,
      actorUserId: user.id,
      resolutionSummary: typeof body.resolutionSummary === "string" ? body.resolutionSummary : null,
      reason: typeof body.reason === "string" ? body.reason : null,
      mergedIntoIncidentId:
        typeof body.mergedIntoIncidentId === "string" ? body.mergedIntoIncidentId : null,
      // S12: the generic status route cannot bypass closure review.
      // Verified closures go through /closure; this only carries an
      // explicit audited administrative reason when supplied.
      ...(closureMode === "verified" && typeof body.postmortemId === "string"
        ? { closure: { mode: "verified" as const, postmortemId: body.postmortemId } }
        : closureMode === "administrative" && typeof body.closureReason === "string"
          ? { closure: { mode: "administrative" as const, reason: body.closureReason } }
          : {}),
    });
    return NextResponse.json({
      ok: true,
      incident: { id: updated.id, status: updated.status, resolvedAt: updated.resolved_at },
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "request failed" },
      { status: statusOf(e, 500) },
    );
  }
}
