import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getWorkspaceBySlug } from "@/lib/db";
import { startWatch } from "@/lib/resolution-watch";
import { realWatchDeps } from "@/lib/resolution-watch-store";
import { requireStaff } from "@/lib/support-ops";

function statusOf(e: unknown, fallback: number): number {
  const s = (e as { status?: unknown })?.status;
  return typeof s === "number" ? s : fallback;
}

/**
 * S11 watch activation: staff-only. Requires a staged plan with an
 * approved S10 approval and at least one documented execution.
 * Incidents with no intervention are refused. Nothing executes here.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let body: { workspaceSlug?: unknown; planId?: unknown; executionId?: unknown; note?: unknown };
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
    const planId = typeof body.planId === "string" ? body.planId : "";
    if (!planId) return NextResponse.json({ ok: false, error: "planId is required" }, { status: 400 });
    const result = await startWatch(
      id,
      ws.id,
      user.id,
      {
        planId,
        executionId: typeof body.executionId === "string" ? body.executionId : null,
        note: typeof body.note === "string" ? body.note : null,
      },
      await realWatchDeps(),
    );
    if (result.action === "started" || result.action === "duplicate") {
      return NextResponse.json({
        ok: true,
        action: result.action,
        watch: { id: result.watch.id, status: result.watch.status },
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

/** List watches + observations for an incident (staff-only, scoped). */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const slug = new URL(req.url).searchParams.get("workspaceSlug") ?? "";
    const ws = slug ? await getWorkspaceBySlug(slug) : null;
    if (!ws) return NextResponse.json({ ok: false, error: "workspace not found" }, { status: 404 });
    await requireStaff(user.id, ws.id);
    const { id } = await ctx.params;
    const deps = await realWatchDeps({ judge: false });
    const watches = await deps.watches.listForIncident(id, ws.id).catch(() => []);
    const withObs = await Promise.all(
      watches.slice(0, 5).map(async (w) => ({
        watch: w,
        observations: await deps.observations.listForWatch(w.id, ws.id).catch(() => []),
      })),
    );
    return NextResponse.json({ ok: true, watches: withObs });
  } catch (e) {
    const status = statusOf(e, 503);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "request failed" },
      { status: status === 401 ? 401 : status },
    );
  }
}
