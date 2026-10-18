import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getWorkspaceBySlug } from "@/lib/db";
import { realHealthDeps } from "@/lib/knowledge-health-store";
import { requireStaff } from "@/lib/support-ops";

function statusOf(e: unknown, fallback: number): number {
  const s = (e as { status?: unknown })?.status;
  return typeof s === "number" ? s : fallback;
}

const DECISIONS = ["acknowledged", "dismissed", "addressed"] as const;

/**
 * S14 finding review: staff-only operator decisions. Dismissal requires a
 * reason. Advisory only — decisions change finding state, never cards,
 * memory, incidents, or anything else.
 */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string; findingId: string }> }) {
  let body: { decision?: unknown; note?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  const decision = typeof body.decision === "string" ? body.decision : "";
  if (!(DECISIONS as readonly string[]).includes(decision)) {
    return NextResponse.json({ ok: false, error: "decision must be acknowledged, dismissed, or addressed" }, { status: 400 });
  }
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : "";
  if (decision === "dismissed" && !note) {
    return NextResponse.json({ ok: false, error: "dismissal needs a reason" }, { status: 400 });
  }
  try {
    const user = await requireUser();
    const { slug, findingId } = await ctx.params;
    const ws = slug ? await getWorkspaceBySlug(slug) : null;
    if (!ws) return NextResponse.json({ ok: false, error: "workspace not found" }, { status: 404 });
    await requireStaff(user.id, ws.id);
    const deps = await realHealthDeps({ judge: false });
    try {
      const row = await deps.findings.review({
        findingId,
        workspaceId: ws.id,
        to: decision as (typeof DECISIONS)[number],
        actorUserId: user.id,
        note: note || null,
      });
      return NextResponse.json({ ok: true, finding: { id: row.id, status: row.status } });
    } catch (e) {
      const status = (e as { status?: unknown })?.status === 404 ? 404 : 409;
      return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "review failed" }, { status });
    }
  } catch (e) {
    const status = statusOf(e, 503);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "request failed" },
      { status: status === 401 ? 401 : status },
    );
  }
}
