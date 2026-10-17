import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getWorkspaceBySlug } from "@/lib/db";
import { INCIDENT_SEVERITIES, splitIncident, type IncidentSeverity } from "@/lib/incidents";
import { requireStaff } from "@/lib/support-ops";

function statusOf(e: unknown, fallback: number): number {
  const s = (e as { status?: unknown })?.status;
  return typeof s === "number" ? s : fallback;
}

/**
 * Explicit split: creates a child incident and moves ONLY the selected
 * associations. Nothing is inferred — unmoved records stay with the source.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  let body: {
    workspaceSlug?: unknown;
    childTitle?: unknown;
    childDescription?: unknown;
    severity?: unknown;
    moveConversationIds?: unknown;
    moveCustomerIds?: unknown;
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
    if (typeof body.childTitle !== "string" || !body.childTitle.trim()) {
      return NextResponse.json({ ok: false, error: "childTitle is required" }, { status: 400 });
    }
    const severity =
      typeof body.severity === "string" && (INCIDENT_SEVERITIES as readonly string[]).includes(body.severity)
        ? (body.severity as IncidentSeverity)
        : undefined;
    const { source, child } = await splitIncident({
      incidentId: id,
      workspaceId: ws.id,
      childTitle: body.childTitle,
      childDescription: typeof body.childDescription === "string" ? body.childDescription : "",
      severity,
      moveConversationIds: Array.isArray(body.moveConversationIds)
        ? body.moveConversationIds.filter((c): c is string => typeof c === "string")
        : [],
      moveCustomerIds: Array.isArray(body.moveCustomerIds)
        ? body.moveCustomerIds.filter((c): c is string => typeof c === "string")
        : [],
      actorUserId: user.id,
    });
    return NextResponse.json(
      {
        ok: true,
        source: { id: source.id, status: source.status },
        child: { id: child.id, status: child.status },
      },
      { status: 201 },
    );
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "request failed" },
      { status: statusOf(e, 500) },
    );
  }
}
