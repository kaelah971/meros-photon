import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getWorkspaceBySlug } from "@/lib/db";
import { repairProvenanceLink } from "@/lib/knowledge-health-store";
import { requireStaff } from "@/lib/support-ops";

function statusOf(e: unknown, fallback: number): number {
  const s = (e as { status?: unknown })?.status;
  return typeof s === "number" ? s : fallback;
}

/**
 * S14 explicit provenance repair: staff-only, audited, never silent.
 * The stale link is derived server-side from the finding's references;
 * the operator has reviewed the finding. Does not modify card content.
 */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string; findingId: string }> }) {
  try {
    await req.json().catch(() => ({}));
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  try {
    const user = await requireUser();
    const { slug, findingId } = await ctx.params;
    const ws = slug ? await getWorkspaceBySlug(slug) : null;
    if (!ws) return NextResponse.json({ ok: false, error: "workspace not found" }, { status: 404 });
    await requireStaff(user.id, ws.id);
    const { realFindingStore } = await import("@/lib/knowledge-health-store");
    const { realMemoryStore } = await import("@/lib/operator-memory");
    const store = await realFindingStore();
    const finding = await store.loadById(findingId, ws.id);
    if (!finding) return NextResponse.json({ ok: false, error: "finding not found" }, { status: 404 });
    if (finding.type !== "stale" || finding.detail.reason !== "stale_provenance") {
      return NextResponse.json({ ok: false, error: "finding is not a stale-provenance repair" }, { status: 409 });
    }
    const mstore = await realMemoryStore();
    const pmId = finding.detail.refs.postmortemIds[0];
    if (!pmId) return NextResponse.json({ ok: false, error: "finding has no postmortem reference" }, { status: 409 });
    const link = await mstore.findByPostmortem(pmId, ws.id);
    if (!link) return NextResponse.json({ ok: false, error: "memory link not found" }, { status: 404 });
    const result = await repairProvenanceLink(link.id, ws.id, user.id);
    if (result.action === "repaired") {
      await store.review({ findingId, workspaceId: ws.id, to: "addressed", actorUserId: user.id, note: `provenance repointed to fix ${result.cardId.slice(0, 8)}` }).catch(() => null);
      return NextResponse.json({ ok: true, cardId: result.cardId });
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
