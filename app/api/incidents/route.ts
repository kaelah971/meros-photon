import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getWorkspaceBySlug } from "@/lib/db";
import {
  INCIDENT_SEVERITIES,
  createIncident,
  listIncidents,
  type IncidentSeverity,
  type IncidentStatus,
} from "@/lib/incidents";
import { requireStaff } from "@/lib/support-ops";

function statusOf(e: unknown, fallback: number): number {
  const s = (e as { status?: unknown })?.status;
  return typeof s === "number" ? s : fallback;
}

/** Staff incident list for one workspace, optional ?status= filter. */
export async function GET(req: Request) {
  try {
    const user = await requireUser();
    const url = new URL(req.url);
    const slug = (url.searchParams.get("workspaceSlug") ?? "").trim();
    const status = (url.searchParams.get("status") ?? "").trim() || null;
    const ws = slug ? await getWorkspaceBySlug(slug) : null;
    if (!ws) return NextResponse.json({ ok: false, error: "workspace not found" }, { status: 404 });
    await requireStaff(user.id, ws.id);
    const rows = await listIncidents(ws.id, status as IncidentStatus | null);
    return NextResponse.json({
      ok: true,
      incidents: rows.map((r) => ({
        id: r.id,
        title: r.title,
        severity: r.severity,
        status: r.status,
        customerCount: r.customer_count,
        conversationCount: r.conversation_count,
        evidenceCount: r.evidence_count,
        updatedAt: r.updated_at,
        createdAt: r.created_at,
        resolvedAt: r.resolved_at,
      })),
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "request failed" },
      { status: statusOf(e, 500) },
    );
  }
}

/** Operator-created incident. Links only existing workspace conversations. */
export async function POST(req: Request) {
  let body: {
    workspaceSlug?: unknown;
    title?: unknown;
    description?: unknown;
    severity?: unknown;
    conversationIds?: unknown;
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

    const title = typeof body.title === "string" ? body.title : "";
    const severity =
      typeof body.severity === "string" && (INCIDENT_SEVERITIES as readonly string[]).includes(body.severity)
        ? (body.severity as IncidentSeverity)
        : "medium";
    const conversationIds = Array.isArray(body.conversationIds)
      ? body.conversationIds.filter((c): c is string => typeof c === "string" && c.length > 0).slice(0, 20)
      : [];
    const incident = await createIncident({
      workspaceId: ws.id,
      title,
      description: typeof body.description === "string" ? body.description : "",
      severity,
      createdByUserId: user.id,
      initialConversationIds: conversationIds,
    });
    return NextResponse.json(
      { ok: true, incident: { id: incident.id, title: incident.title, status: incident.status } },
      { status: 201 },
    );
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "request failed" },
      { status: statusOf(e, 500) },
    );
  }
}
