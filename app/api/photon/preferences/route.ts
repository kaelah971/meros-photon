import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getWorkspaceBySlug } from "@/lib/db";
import {
  getPreferences,
  upsertPreferences,
  validatePreferences,
} from "@/lib/photon/preferences";
import { requireStaff } from "@/lib/support-ops";

/**
 * S3 operator notification preferences (own settings only).
 * GET returns the caller's prefs (defaults when never saved).
 * PUT validates strictly (timezone/times/ranges) then upserts atomically.
 * Staff membership + self-ownership enforced; nobody edits another operator.
 */
export async function GET(req: Request) {
  try {
    const user = await requireUser();
    const slug = new URL(req.url).searchParams.get("workspaceSlug")?.trim() ?? "";
    const ws = slug ? await getWorkspaceBySlug(slug) : null;
    if (!ws) return NextResponse.json({ ok: false, error: "workspace not found" }, { status: 404 });
    await requireStaff(user.id, ws.id);
    const prefs = await getPreferences(ws.id, user.id);
    return NextResponse.json({
      ok: true,
      preferences: {
        proactiveEnabled: prefs.proactiveEnabled,
        quietHoursEnabled: prefs.quietHoursEnabled,
        quietStart: prefs.quietStart,
        quietEnd: prefs.quietEnd,
        timezone: prefs.timezone,
        radarEnabled: prefs.radarEnabled,
      },
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "request failed" },
      { status: httpStatus(e) },
    );
  }
}

export async function PUT(req: Request) {
  let body: {
    workspaceSlug?: unknown;
    proactiveEnabled?: unknown;
    quietHoursEnabled?: unknown;
    quietStart?: unknown;
    quietEnd?: unknown;
    timezone?: unknown;
    radarEnabled?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  let user: Awaited<ReturnType<typeof requireUser>>;
  try {
    user = await requireUser();
  } catch (e) {
    const status =
      typeof (e as { status?: unknown })?.status === "number"
        ? (e as { status: number }).status
        : 401;
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "not signed in" },
      { status },
    );
  }
  const checked = validatePreferences({
    proactiveEnabled: body.proactiveEnabled,
    quietHoursEnabled: body.quietHoursEnabled,
    quietStart: body.quietStart,
    quietEnd: body.quietEnd,
    timezone: body.timezone,
    radarEnabled: body.radarEnabled,
  });
  if (!checked.ok) {
    return NextResponse.json({ ok: false, error: checked.error }, { status: 400 });
  }
  try {
    const slug = typeof body.workspaceSlug === "string" ? body.workspaceSlug.trim() : "";
    const ws = slug ? await getWorkspaceBySlug(slug) : null;
    if (!ws) return NextResponse.json({ ok: false, error: "workspace not found" }, { status: 404 });
    await requireStaff(user.id, ws.id);
    // Merge: an absent radarEnabled leaves the stored opt-in untouched so
    // unrelated preference saves never reset Radar.
    const current = await getPreferences(ws.id, user.id);
    const saved = await upsertPreferences({
      workspaceId: ws.id,
      operatorUserId: user.id,
      ...checked.value,
      radarEnabled: checked.value.radarEnabled ?? current.radarEnabled,
    });
    return NextResponse.json({
      ok: true,
      preferences: {
        proactiveEnabled: saved.proactiveEnabled,
        quietHoursEnabled: saved.quietHoursEnabled,
        quietStart: saved.quietStart,
        quietEnd: saved.quietEnd,
        timezone: saved.timezone,
        radarEnabled: saved.radarEnabled,
      },
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "request failed" },
      { status: httpStatus(e) },
    );
  }
}

function httpStatus(e: unknown): number {
  const s = (e as { status?: unknown })?.status;
  if (typeof s === "number") return s;
  return e instanceof Error && e.message === "not signed in" ? 401 : 500;
}
