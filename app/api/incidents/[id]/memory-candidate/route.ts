import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getWorkspaceBySlug } from "@/lib/db";
import { proposeMemoryCandidate, realMemoryDeps } from "@/lib/operator-memory";
import { requireStaff } from "@/lib/support-ops";

function statusOf(e: unknown, fallback: number): number {
  const s = (e as { status?: unknown })?.status;
  return typeof s === "number" ? s : fallback;
}

/**
 * S13 memory candidate proposal: staff-only, idempotent per postmortem.
 * Builds a grounded candidate from a FINALIZED postmortem of a verified
 * closure and stages it as a pending Fix Card. Sharing stays an explicit
 * decision in Fix Card review. Administrative closures are refused.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let body: { workspaceSlug?: unknown; postmortemId?: unknown };
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
    const postmortemId = typeof body.postmortemId === "string" ? body.postmortemId : "";
    if (!postmortemId) return NextResponse.json({ ok: false, error: "postmortemId is required" }, { status: 400 });
    const result = await proposeMemoryCandidate(id, ws.id, user.id, { postmortemId }, await realMemoryDeps());
    if (result.action === "proposed" || result.action === "duplicate") {
      return NextResponse.json({ ok: true, action: result.action, fixCardId: result.cardId });
    }
    return NextResponse.json({ ok: false, error: result.reason }, { status: 409 });
  } catch (e) {
    const status = statusOf(e, 503);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "request failed" },
      { status: status === 401 ? 401 : status },
    );
  }
}

/** Candidate/link status for an incident (staff-only, scoped). */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const slug = new URL(req.url).searchParams.get("workspaceSlug") ?? "";
    const ws = slug ? await getWorkspaceBySlug(slug) : null;
    if (!ws) return NextResponse.json({ ok: false, error: "workspace not found" }, { status: 404 });
    await requireStaff(user.id, ws.id);
    const { id } = await ctx.params;
    const { realMemoryStore } = await import("@/lib/operator-memory");
    const store = await realMemoryStore();
    const links = await store.listApprovedForIncident(id, ws.id).catch(() => []);
    return NextResponse.json({ ok: true, links });
  } catch (e) {
    const status = statusOf(e, 503);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "request failed" },
      { status: status === 401 ? 401 : status },
    );
  }
}
