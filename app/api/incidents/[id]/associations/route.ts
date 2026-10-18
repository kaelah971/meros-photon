import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getWorkspaceBySlug } from "@/lib/db";
import {
  addIncidentConversation,
  addIncidentCustomer,
  addIncidentEvidence,
  type EvidenceInput,
} from "@/lib/incidents";
import { scheduleBriefRefresh } from "@/lib/evidence-brief";
import { scheduleMatchRefresh } from "@/lib/fix-matches";
import { requireStaff } from "@/lib/support-ops";

function statusOf(e: unknown, fallback: number): number {
  const s = (e as { status?: unknown })?.status;
  return typeof s === "number" ? s : fallback;
}

/**
 * Link ONE existing record per call: a workspace conversation (which also
 * links its customer), a workspace customer, or one evidence reference
 * (existing message/conversation/fix card/knowledge source, or a plain
 * operator note). Everything referenced must already exist here.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  let body: {
    workspaceSlug?: unknown;
    conversationId?: unknown;
    customerId?: unknown;
    evidence?: unknown;
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

    if (typeof body.conversationId === "string" && body.conversationId) {
      const linked = await addIncidentConversation({
        incidentId: id,
        workspaceId: ws.id,
        conversationId: body.conversationId,
        actorUserId: user.id,
      });
      scheduleBriefRefresh(id, ws.id);
      scheduleMatchRefresh(id, ws.id);
      return NextResponse.json({ ok: true, linked });
    }
    if (typeof body.customerId === "string" && body.customerId) {
      await addIncidentCustomer({
        incidentId: id,
        workspaceId: ws.id,
        customerId: body.customerId,
        actorUserId: user.id,
      });
      return NextResponse.json({ ok: true, linked: { customerLinked: true } });
    }
    if (body.evidence !== undefined && body.evidence !== null && typeof body.evidence === "object") {
      const e = body.evidence as Record<string, unknown>;
      const kind = typeof e.kind === "string" ? e.kind : "";
      const label = typeof e.label === "string" ? e.label : "";
      const note = typeof e.note === "string" ? e.note : "";
      let evidence: EvidenceInput;
      if (kind === "message" && typeof e.messageId === "string") {
        evidence = { kind: "message", messageId: e.messageId, label, note };
      } else if (kind === "conversation" && typeof e.conversationId === "string") {
        evidence = { kind: "conversation", conversationId: e.conversationId, label, note };
      } else if (kind === "fix_card" && typeof e.fixCardId === "string") {
        evidence = { kind: "fix_card", fixCardId: e.fixCardId, label, note };
      } else if (kind === "knowledge" && typeof e.knowledgeId === "string") {
        evidence = { kind: "knowledge", knowledgeId: e.knowledgeId, label, note };
      } else if (kind === "note") {
        evidence = { kind: "note", label, note };
      } else {
        return NextResponse.json({ ok: false, error: "unknown evidence reference" }, { status: 400 });
      }
      const row = await addIncidentEvidence({
        incidentId: id,
        workspaceId: ws.id,
        evidence,
        actorUserId: user.id,
      });
      return NextResponse.json({ ok: true, evidence: { id: row.id, kind: row.kind } }, { status: 201 });
    }
    return NextResponse.json(
      { ok: false, error: "provide conversationId, customerId, or evidence" },
      { status: 400 },
    );
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "request failed" },
      { status: statusOf(e, 500) },
    );
  }
}
