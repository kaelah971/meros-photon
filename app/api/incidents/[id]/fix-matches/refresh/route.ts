import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getWorkspaceBySlug } from "@/lib/db";
import { getIncidentBrief } from "@/lib/evidence-brief";
import {
  realMatchDeps,
  realMatchStore,
  refreshMatchesIfNeeded,
} from "@/lib/fix-matches";
import { requireStaff } from "@/lib/support-ops";

function statusOf(e: unknown, fallback: number): number {
  const s = (e as { status?: unknown })?.status;
  return typeof s === "number" ? s : fallback;
}

/**
 * S8 explicit match refresh: staff-only, idempotent, read-only. Recomputes
 * fix-card recommendations for the incident's CURRENT brief fingerprint (or
 * returns stored rows when unchanged). Never executes fixes, changes
 * lifecycle, or sends messages. Safe to retry: fingerprint-gated and
 * single-flight per evidence version.
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

    const store = await realMatchStore();

    const result = await refreshMatchesIfNeeded(id, ws.id, await realMatchDeps());

    const briefRow = await getIncidentBrief(id, ws.id).catch(() => null);
    const brief = briefRow
      ? {
          status: briefRow.status,
          version: briefRow.version,
          fingerprint: briefRow.fingerprint,
        }
      : null;
    const rows = brief ? await store.loadForBrief(id, ws.id, brief.fingerprint).catch(() => []) : [];
    const latest = await store.loadLatest(id, ws.id).catch(() => null);
    const stale =
      !brief || brief.status !== "current"
        ? true
        : latest
          ? latest.fingerprint !== brief.fingerprint
          : rows.length === 0 && (result.action === "failed" || result.action === "deferred");

    const payload = {
      ok: true,
      action: result.action,
      brief: brief
        ? { status: brief.status, version: brief.version, fingerprint: brief.fingerprint }
        : null,
      stale,
      matches: rows.map((r) => ({
        refId: r.ref_id,
        tier: r.tier,
        generatedAt: r.generated_at,
        ...r.payload,
      })),
      latestFingerprint: latest?.fingerprint ?? null,
    };
    if (result.action === "in_progress") {
      return NextResponse.json(payload, { status: 202 });
    }
    if (result.action === "failed") {
      return NextResponse.json(
        { ...payload, ok: false, error: result.error, recoverable: true },
        { status: 502 },
      );
    }
    return NextResponse.json(payload);
  } catch (e) {
    const status = statusOf(e, 503);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "request failed" },
      { status: status === 401 ? 401 : status },
    );
  }
}
