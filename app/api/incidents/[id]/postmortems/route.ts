import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getWorkspaceBySlug } from "@/lib/db";
import { generateDraft } from "@/lib/closure";
import { realClosureDeps } from "@/lib/closure-store";
import { requireStaff } from "@/lib/support-ops";

function statusOf(e: unknown, fallback: number): number {
  const s = (e as { status?: unknown })?.status;
  return typeof s === "number" ? s : fallback;
}

/**
 * S12 postmortem drafting: staff-only, fingerprint-gated, idempotent.
 * Assembles the factual S4–S11 record deterministically; model synthesis
 * is attached only when valid, and its absence never blocks closure.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
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
    const { id } = await ctx.params;
    // Staff explicitly asked for a refresh: allow synthesis when configured.
    const result = await generateDraft(id, ws.id, user.id, await realClosureDeps());
    if (result.action === "drafted") {
      return NextResponse.json({
        ok: true,
        postmortem: { id: result.postmortem.id, fingerprint: result.postmortem.source_fingerprint },
        synthesis: result.synthesis,
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

/** List draft + finalized postmortems (staff-only, scoped). */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const slug = new URL(req.url).searchParams.get("workspaceSlug") ?? "";
    const ws = slug ? await getWorkspaceBySlug(slug) : null;
    if (!ws) return NextResponse.json({ ok: false, error: "workspace not found" }, { status: 404 });
    await requireStaff(user.id, ws.id);
    const { id } = await ctx.params;
    const deps = await realClosureDeps({ judge: false });
    const [draft, finalized] = await Promise.all([
      deps.postmortems.loadDraft(id, ws.id).catch(() => null),
      deps.postmortems.listFinalized(id, ws.id).catch(() => []),
    ]);
    return NextResponse.json({ ok: true, draft, finalized });
  } catch (e) {
    const status = statusOf(e, 503);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "request failed" },
      { status: status === 401 ? 401 : status },
    );
  }
}
