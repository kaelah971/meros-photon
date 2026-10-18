import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getWorkspaceBySlug } from "@/lib/db";
import { recordObservation } from "@/lib/resolution-watch";
import { realWatchDeps } from "@/lib/resolution-watch-store";
import { requireStaff } from "@/lib/support-ops";

function statusOf(e: unknown, fallback: number): number {
  const s = (e as { status?: unknown })?.status;
  return typeof s === "number" ? s : fallback;
}

/**
 * S11 documented operator observation: staff-only, text required,
 * message-anchored notes deduped per watch. No auto-effects.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string; watchId: string }> }) {
  let body: { workspaceSlug?: unknown; kind?: unknown; messageId?: unknown; text?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  const kind = typeof body.kind === "string" ? body.kind : "";
  if (kind !== "operator_note" && kind !== "verification") {
    return NextResponse.json({ ok: false, error: "kind must be operator_note or verification" }, { status: 400 });
  }
  try {
    const user = await requireUser();
    const slug = typeof body.workspaceSlug === "string" ? body.workspaceSlug.trim() : "";
    const ws = slug ? await getWorkspaceBySlug(slug) : null;
    if (!ws) return NextResponse.json({ ok: false, error: "workspace not found" }, { status: 404 });
    await requireStaff(user.id, ws.id);
    const { watchId } = await ctx.params;
    const result = await recordObservation(
      watchId,
      ws.id,
      user.id,
      {
        kind,
        messageId: typeof body.messageId === "string" ? body.messageId : null,
        text: typeof body.text === "string" ? body.text : "",
      },
      await realWatchDeps({ judge: false }),
    );
    if (result.action === "recorded") {
      return NextResponse.json({ ok: true, observation: { id: result.observation.id, kind: result.observation.kind } });
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
