import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getWorkspaceBySlug } from "@/lib/db";
import { issuePairingCode, listBindings, revokeBinding } from "@/lib/photon/bindings";
import { requireStaff } from "@/lib/support-ops";

// S1 developer pairing helpers (server-only, staff-session gated).
// Issues the one-time `pair XXXX-XXXX-XXXX` code an operator types in
// iMessage to bind their sender to this staff user + workspace.
// S3 builds the polished pairing UX; this is the minimum safe domain.

function statusOf(e: unknown, fallback = 500): number {
  return typeof (e as { status?: unknown })?.status === "number"
    ? (e as { status: number }).status
    : fallback;
}

/** Staff-visible binding roster for one workspace (hashes only). */
export async function GET(req: Request) {
  try {
    const user = await requireUser();
    const slug = new URL(req.url).searchParams.get("workspaceSlug")?.trim() ?? "";
    const ws = slug ? await getWorkspaceBySlug(slug) : null;
    if (!ws) return NextResponse.json({ ok: false, error: "workspace not found" }, { status: 404 });
    await requireStaff(user.id, ws.id);
    return NextResponse.json({ ok: true, bindings: await listBindings(ws.id) });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "request failed" },
      { status: statusOf(e, e instanceof Error && e.message === "not signed in" ? 401 : 500) },
    );
  }
}

/** Mint a one-time pairing code for the CALLING staff user + workspace. */
export async function POST(req: Request) {
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
    const issued = await issuePairingCode({ workspaceId: ws.id, operatorUserId: user.id });
    return NextResponse.json(
      {
        ok: true,
        bindingId: issued.bindingId,
        // Shown ONCE: only the hash is persisted; this plaintext is never stored.
        code: issued.code,
        expiresAt: issued.expiresAt,
        hint: "The operator replies `pair <code>` from iMessage within 15 minutes.",
      },
      { status: 201 },
    );
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "request failed" },
      { status: statusOf(e, e instanceof Error && e.message === "not signed in" ? 401 : 500) },
    );
  }
}

/** Revoke a binding (lost device, role change). Staff only. */
export async function DELETE(req: Request) {
  let body: { workspaceSlug?: unknown; bindingId?: unknown };
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
    if (typeof body.bindingId !== "string" || !body.bindingId) {
      return NextResponse.json({ ok: false, error: "bindingId is required" }, { status: 400 });
    }
    const revoked = await revokeBinding(body.bindingId, ws.id);
    if (!revoked) return NextResponse.json({ ok: false, error: "binding not found" }, { status: 404 });
    return NextResponse.json({ ok: true, revoked: body.bindingId });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "request failed" },
      { status: statusOf(e, e instanceof Error && e.message === "not signed in" ? 401 : 500) },
    );
  }
}
