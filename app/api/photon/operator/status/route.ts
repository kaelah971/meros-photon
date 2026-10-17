import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getWorkspaceBySlug } from "@/lib/db";
import { resolveActiveBindingForOperator } from "@/lib/photon/bindings";
import { DEFAULT_PREFERENCES, getPreferences } from "@/lib/photon/preferences";
import { requireStaff } from "@/lib/support-ops";

/**
 * S3 operator iMessage status: connection, readiness, and preferences for
 * the CALLING staff operator in one workspace. Safe fields only — never raw
 * senders, hashes, codes, or other workspaces' bindings.
 */
export async function GET(req: Request) {
  try {
    const user = await requireUser();
    const slug = new URL(req.url).searchParams.get("workspaceSlug")?.trim() ?? "";
    const ws = slug ? await getWorkspaceBySlug(slug) : null;
    if (!ws) return NextResponse.json({ ok: false, error: "workspace not found" }, { status: 404 });
    await requireStaff(user.id, ws.id);

    const binding = await resolveActiveBindingForOperator(ws.id, user.id);
    const prefs = await getPreferences(ws.id, user.id).catch(() => ({
      workspaceId: ws.id,
      operatorUserId: user.id,
      ...DEFAULT_PREFERENCES,
    }));
    return NextResponse.json({
      ok: true,
      workspace: { slug: ws.slug, name: ws.name },
      paired: binding !== null,
      lastSeenAt: binding?.last_seen_at ?? null,
      threadReady: Boolean(binding?.thread_id),
      proactiveReady: binding !== null && prefs.proactiveEnabled,
      preferences: {
        proactiveEnabled: prefs.proactiveEnabled,
        quietHoursEnabled: prefs.quietHoursEnabled,
        quietStart: prefs.quietStart,
        quietEnd: prefs.quietEnd,
        timezone: prefs.timezone,
      },
    });
  } catch (e) {
    const status =
      typeof (e as { status?: unknown })?.status === "number"
        ? (e as { status: number }).status
        : 500;
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "request failed" },
      { status: status === 401 ? 401 : status },
    );
  }
}
