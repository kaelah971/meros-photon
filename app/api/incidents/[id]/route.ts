import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getWorkspaceBySlug } from "@/lib/db";
import {
  getIncidentForWorkspace,
  listIncidentConversations,
  listIncidentCustomers,
  listIncidentEvents,
  listIncidentEvidence,
  updateIncidentFields,
  type IncidentSeverity,
} from "@/lib/incidents";
import { requireStaff } from "@/lib/support-ops";

function statusOf(e: unknown, fallback: number): number {
  const s = (e as { status?: unknown })?.status;
  return typeof s === "number" ? s : fallback;
}

async function scopedWorkspace(slug: string, userId: string) {
  const ws = slug ? await getWorkspaceBySlug(slug) : null;
  if (!ws) throw Object.assign(new Error("workspace not found"), { status: 404 });
  await requireStaff(userId, ws.id);
  return ws;
}

/** Full incident detail: summary + members + evidence + timeline. */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const slug = new URL(req.url).searchParams.get("workspaceSlug")?.trim() ?? "";
    const ws = await scopedWorkspace(slug, user.id);
    const { id } = await ctx.params;
    const incident = await getIncidentForWorkspace(ws.id, id);
    if (!incident) return NextResponse.json({ ok: false, error: "incident not found" }, { status: 404 });
    const [customers, conversations, evidence, events] = await Promise.all([
      listIncidentCustomers(id, ws.id),
      listIncidentConversations(id, ws.id),
      listIncidentEvidence(id, ws.id),
      listIncidentEvents(id, ws.id),
    ]);
    return NextResponse.json({
      ok: true,
      incident: {
        id: incident.id,
        title: incident.title,
        description: incident.description,
        severity: incident.severity,
        status: incident.status,
        resolutionSummary: incident.resolution_summary,
        resolvedAt: incident.resolved_at,
        mergedIntoIncidentId: incident.merged_into_incident_id,
        splitFromIncidentId: incident.split_from_incident_id,
        createdAt: incident.created_at,
        updatedAt: incident.updated_at,
      },
      customers,
      conversations,
      evidence,
      events,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "request failed" },
      { status: statusOf(e, 500) },
    );
  }
}

/** Edit title/description/severity on non-terminal incidents. */
export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  let body: { workspaceSlug?: unknown; title?: unknown; description?: unknown; severity?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  try {
    const user = await requireUser();
    const slug = typeof body.workspaceSlug === "string" ? body.workspaceSlug.trim() : "";
    const ws = await scopedWorkspace(slug, user.id);
    const { id } = await ctx.params;
    const updated = await updateIncidentFields({
      incidentId: id,
      workspaceId: ws.id,
      title: typeof body.title === "string" ? body.title : undefined,
      description: typeof body.description === "string" ? body.description : undefined,
      severity:
        typeof body.severity === "string" ? (body.severity as IncidentSeverity) : undefined,
      actorUserId: user.id,
    });
    return NextResponse.json({
      ok: true,
      incident: { id: updated.id, title: updated.title, severity: updated.severity, status: updated.status },
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "request failed" },
      { status: statusOf(e, 500) },
    );
  }
}
