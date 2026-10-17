import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getWorkspaceBySlug } from "@/lib/db";
import {
  getCandidateForWorkspace,
  listCandidateMembers,
  markCandidateAccepted,
  markCandidateDismissed,
} from "@/lib/issue-candidates";
import { addIncidentConversation, createIncident, type IncidentSeverity } from "@/lib/incidents";
import { INCIDENT_SEVERITIES } from "@/lib/incidents";
import { requireStaff } from "@/lib/support-ops";

function statusOf(e: unknown, fallback: number): number {
  const s = (e as { status?: unknown })?.status;
  return typeof s === "number" ? s : fallback;
}

/**
 * Operator review of a detected pattern. ACCEPT wires the candidate's real
 * member conversations into the S4 domain (new or existing incident);
 * DISMISS records the decision so unchanged evidence never re-surfaces.
 * Nothing here transitions incidents toward recovery — confirmation only.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  let body: {
    workspaceSlug?: unknown;
    action?: unknown;
    title?: unknown;
    severity?: unknown;
    incidentId?: unknown;
    note?: unknown;
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
    const candidate = await getCandidateForWorkspace(ws.id, id);
    if (!candidate) return NextResponse.json({ ok: false, error: "candidate not found" }, { status: 404 });
    if (candidate.status !== "pending") {
      return NextResponse.json({ ok: false, error: `candidate is already ${candidate.status}` }, { status: 409 });
    }

    const action = typeof body.action === "string" ? body.action : "";
    if (action === "dismiss") {
      await markCandidateDismissed({
        candidateId: id,
        workspaceId: ws.id,
        actorUserId: user.id,
        note: typeof body.note === "string" ? body.note : null,
      });
      return NextResponse.json({ ok: true, status: "dismissed" });
    }

    const members = await listCandidateMembers(id, ws.id);
    if (members.length === 0) {
      return NextResponse.json({ ok: false, error: "candidate has no linked conversations" }, { status: 409 });
    }

    if (action === "accept_new") {
      const title = (typeof body.title === "string" && body.title.trim()) || candidate.title;
      const severity =
        typeof body.severity === "string" && (INCIDENT_SEVERITIES as readonly string[]).includes(body.severity)
          ? (body.severity as IncidentSeverity)
          : "medium";
      const incident = await createIncident({
        workspaceId: ws.id,
        title,
        description: candidate.summary,
        severity,
        createdByUserId: user.id,
      });
      for (const m of members) {
        await addIncidentConversation({
          incidentId: incident.id,
          workspaceId: ws.id,
          conversationId: m.conversation_id,
          actorUserId: user.id,
        });
      }
      await markCandidateAccepted({ candidateId: id, workspaceId: ws.id, incidentId: incident.id, actorUserId: user.id });
      return NextResponse.json({ ok: true, incident: { id: incident.id, title: incident.title } }, { status: 201 });
    }

    if (action === "accept_existing") {
      if (typeof body.incidentId !== "string" || !body.incidentId) {
        return NextResponse.json({ ok: false, error: "incidentId is required" }, { status: 400 });
      }
      for (const m of members) {
        await addIncidentConversation({
          incidentId: body.incidentId,
          workspaceId: ws.id,
          conversationId: m.conversation_id,
          actorUserId: user.id,
        });
      }
      await markCandidateAccepted({ candidateId: id, workspaceId: ws.id, incidentId: body.incidentId, actorUserId: user.id });
      return NextResponse.json({ ok: true, incident: { id: body.incidentId } });
    }

    return NextResponse.json(
      { ok: false, error: "action must be accept_new, accept_existing, or dismiss" },
      { status: 400 },
    );
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "request failed" },
      { status: statusOf(e, 500) },
    );
  }
}
