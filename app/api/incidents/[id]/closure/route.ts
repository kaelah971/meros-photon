import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getWorkspaceBySlug } from "@/lib/db";
import { checkEligibility, confirmClosure } from "@/lib/closure";
import { realClosureDeps } from "@/lib/closure-store";
import { requireStaff } from "@/lib/support-ops";

function statusOf(e: unknown, fallback: number): number {
  const s = (e as { status?: unknown })?.status;
  return typeof s === "number" ? s : fallback;
}

/**
 * S12 closure review: staff-only readiness report. Never closes anything;
 * every blocker is named explicitly. Silence and unverified work are
 * blockers, never proof.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const slug = new URL(req.url).searchParams.get("workspaceSlug") ?? "";
    const ws = slug ? await getWorkspaceBySlug(slug) : null;
    if (!ws) return NextResponse.json({ ok: false, error: "workspace not found" }, { status: 404 });
    await requireStaff(user.id, ws.id);
    const { id } = await ctx.params;
    const deps = await realClosureDeps({ judge: false });
    const eligibility = await checkEligibility(id, ws.id, deps);
    if (!eligibility.eligible) {
      return NextResponse.json({ ok: true, eligible: false, blockers: eligibility.blockers });
    }
    const draft = await deps.postmortems.loadById(eligibility.draftId, ws.id);
    return NextResponse.json({
      ok: true,
      eligible: true,
      watchId: eligibility.watchId,
      draft: draft
        ? { id: draft.id, fingerprint: draft.source_fingerprint, synthesis: draft.content.synthesisNote }
        : null,
    });
  } catch (e) {
    const status = statusOf(e, 503);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "request failed" },
      { status: status === 401 ? 401 : status },
    );
  }
}

/**
 * S12 closure confirmation: staff-only, explicit, two-path.
 * Verified: { postmortemId } — requires current eligibility + draft, then
 * finalizes and resolves atomically-or-recoverably (retries dedupe).
 * Administrative: { administrative: true, reason } — audited, never claims
 * verified recovery.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let body: { workspaceSlug?: unknown; postmortemId?: unknown; administrative?: unknown; reason?: unknown; note?: unknown };
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
    const deps = await realClosureDeps({ judge: false });
    const transitionToResolved = deps.bindTransition(id, ws.id, user.id);
    if (body.administrative === true) {
      const result = await confirmClosure(
        id,
        ws.id,
        user.id,
        { administrative: true as const, reason: typeof body.reason === "string" ? body.reason : "" },
        deps,
        transitionToResolved,
      );
      if (result.action === "closed" || result.action === "duplicate") {
        return NextResponse.json({ ok: true, action: result.action, status: result.incidentStatus, administrative: true });
      }
      return NextResponse.json({ ok: false, error: result.reason }, { status: 409 });
    }
    const postmortemId = typeof body.postmortemId === "string" ? body.postmortemId : "";
    if (!postmortemId) return NextResponse.json({ ok: false, error: "postmortemId is required" }, { status: 400 });
    const result = await confirmClosure(
      id,
      ws.id,
      user.id,
      { postmortemId, note: typeof body.note === "string" ? body.note : null },
      deps,
      transitionToResolved,
    );
    if (result.action === "closed" || result.action === "duplicate") {
      return NextResponse.json({ ok: true, action: result.action, status: result.incidentStatus, postmortemId: result.postmortemId });
    }
    const status = result.reason.includes("not found") ? 404 : 409;
    return NextResponse.json({ ok: false, error: result.reason }, { status });
  } catch (e) {
    const status = statusOf(e, 503);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "request failed" },
      { status: status === 401 ? 401 : status },
    );
  }
}
