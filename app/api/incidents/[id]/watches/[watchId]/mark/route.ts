import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getWorkspaceBySlug } from "@/lib/db";
import { markWatch } from "@/lib/resolution-watch";
import { realWatchDeps } from "@/lib/resolution-watch-store";
import { requireStaff } from "@/lib/support-ops";

function statusOf(e: unknown, fallback: number): number {
  const s = (e as { status?: unknown })?.status;
  return typeof s === "number" ? s : fallback;
}

const MARKS = ["still_affected", "insufficient_evidence", "watching"] as const;

/**
 * S11 operator honesty states: staff-only transitions to still_affected /
 * insufficient_evidence / watching. Confirmed watches stay as history.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string; watchId: string }> }) {
  let body: { workspaceSlug?: unknown; to?: unknown; note?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  const to = typeof body.to === "string" ? body.to : "";
  if (!(MARKS as readonly string[]).includes(to)) {
    return NextResponse.json({ ok: false, error: "to must be still_affected, insufficient_evidence, or watching" }, { status: 400 });
  }
  try {
    const user = await requireUser();
    const slug = typeof body.workspaceSlug === "string" ? body.workspaceSlug.trim() : "";
    const ws = slug ? await getWorkspaceBySlug(slug) : null;
    if (!ws) return NextResponse.json({ ok: false, error: "workspace not found" }, { status: 404 });
    await requireStaff(user.id, ws.id);
    const { watchId } = await ctx.params;
    const result = await markWatch(
      watchId,
      ws.id,
      user.id,
      to as (typeof MARKS)[number],
      typeof body.note === "string" ? body.note : null,
      await realWatchDeps({ judge: false }),
    );
    if (result.action === "marked") {
      return NextResponse.json({ ok: true, watch: { id: result.watch.id, status: result.watch.status } });
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
