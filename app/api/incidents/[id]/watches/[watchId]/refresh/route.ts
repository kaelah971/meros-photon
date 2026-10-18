import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getWorkspaceBySlug } from "@/lib/db";
import { evaluateWatch } from "@/lib/resolution-watch";
import { realWatchDeps } from "@/lib/resolution-watch-store";
import { requireStaff } from "@/lib/support-ops";

function statusOf(e: unknown, fallback: number): number {
  const s = (e as { status?: unknown })?.status;
  return typeof s === "number" ? s : fallback;
}

/**
 * S11 staff-triggered reconciliation: bounded message pull, deterministic
 * classification, judge only for inconclusive items. Judge failures keep
 * prior records (retryable). Never executes or closes anything.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string; watchId: string }> }) {
  let body: { workspaceSlug?: unknown };
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
    const { watchId } = await ctx.params;
    const result = await evaluateWatch(watchId, ws.id, user.id, await realWatchDeps());
    if (result.action === "evaluated") {
      return NextResponse.json({
        ok: true,
        watch: { id: result.watch.id, status: result.state },
        added: result.added,
      });
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
