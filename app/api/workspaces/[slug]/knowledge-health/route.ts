import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getWorkspaceBySlug } from "@/lib/db";
import { refreshKnowledgeHealth } from "@/lib/knowledge-health";
import { realHealthDeps } from "@/lib/knowledge-health-store";
import { requireStaff } from "@/lib/support-ops";

function statusOf(e: unknown, fallback: number): number {
  const s = (e as { status?: unknown })?.status;
  return typeof s === "number" ? s : fallback;
}

/**
 * S14 Knowledge Health: staff-only, workspace-scoped advisory findings.
 * GET lists open + recent history; POST runs a bounded staff-triggered
 * refresh. Nothing here writes memory, executes, or closes anything.
 */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const user = await requireUser();
    const { slug } = await ctx.params;
    const ws = slug ? await getWorkspaceBySlug(slug) : null;
    if (!ws) return NextResponse.json({ ok: false, error: "workspace not found" }, { status: 404 });
    await requireStaff(user.id, ws.id);
    const deps = await realHealthDeps({ judge: false });
    const [open, history] = await Promise.all([
      deps.findings.listOpen(ws.id).catch(() => []),
      deps.findings.listForWorkspace(ws.id, 20).catch(() => []),
    ]);
    return NextResponse.json({ ok: true, open, history: history.filter((h) => !open.some((o) => o.id === h.id)).slice(0, 10) });
  } catch (e) {
    const status = statusOf(e, 503);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "request failed" },
      { status: status === 401 ? 401 : status },
    );
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  let body: { limit?: unknown };
  try {
    body = await req.json().catch(() => ({}));
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  void body;
  try {
    const user = await requireUser();
    const { slug } = await ctx.params;
    const ws = slug ? await getWorkspaceBySlug(slug) : null;
    if (!ws) return NextResponse.json({ ok: false, error: "workspace not found" }, { status: 404 });
    await requireStaff(user.id, ws.id);
    const deps = await realHealthDeps();
    const result = await refreshKnowledgeHealth(ws.id, user.id, deps, { incidentLimit: 10 });
    if (result.action === "refreshed") {
      return NextResponse.json({ ok: true, ...result });
    }
    return NextResponse.json({ ok: false, error: result.reason }, { status: 503 });
  } catch (e) {
    const status = statusOf(e, 503);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "request failed" },
      { status: status === 401 ? 401 : status },
    );
  }
}
