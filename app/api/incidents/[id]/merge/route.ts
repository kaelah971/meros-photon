import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getWorkspaceBySlug } from "@/lib/db";
import { mergeIncident } from "@/lib/incidents";
import { requireStaff } from "@/lib/support-ops";

function statusOf(e: unknown, fallback: number): number {
  const s = (e as { status?: unknown })?.status;
  return typeof s === "number" ? s : fallback;
}

/** Explicit merge into an existing same-workspace incident. */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  let body: { workspaceSlug?: unknown; targetIncidentId?: unknown };
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
    if (typeof body.targetIncidentId !== "string" || !body.targetIncidentId) {
      return NextResponse.json({ ok: false, error: "targetIncidentId is required" }, { status: 400 });
    }
    const { source, target } = await mergeIncident({
      incidentId: id,
      workspaceId: ws.id,
      targetIncidentId: body.targetIncidentId,
      actorUserId: user.id,
    });
    return NextResponse.json({
      ok: true,
      source: { id: source.id, status: source.status },
      target: { id: target.id, status: target.status },
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "request failed" },
      { status: statusOf(e, 500) },
    );
  }
}
