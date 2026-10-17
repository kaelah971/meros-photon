import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getWorkspaceBySlug } from "@/lib/db";
import { CONNECTIVITY_TEST_BODY, sendOperatorNotification } from "@/lib/photon/notify";
import { requireStaff } from "@/lib/support-ops";

/**
 * S2 operator connectivity test: staff-only, explicit click only. Sends ONE
 * real iMessage to the CALLING staff operator's own ACTIVE binding via the
 * reusable server-initiated notification path. The client mints a fresh
 * idempotency key per explicit click (crypto.randomUUID); repeat clicks are
 * separate explicit sends, while transport retries with the same key dedupe.
 * Never sends to unpaired senders, never to other operators, never customer data.
 */
export async function POST(req: Request) {
  let body: { workspaceSlug?: unknown; clientNotificationId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  const key = typeof body.clientNotificationId === "string" ? body.clientNotificationId.trim() : "";
  if (!key || key.length > 128) {
    return NextResponse.json(
      { ok: false, error: "clientNotificationId is required (client-minted per click)" },
      { status: 400 },
    );
  }

  try {
    const user = await requireUser();
    const slug = typeof body.workspaceSlug === "string" ? body.workspaceSlug.trim() : "";
    const ws = slug ? await getWorkspaceBySlug(slug) : null;
    if (!ws) return NextResponse.json({ ok: false, error: "workspace not found" }, { status: 404 });
    await requireStaff(user.id, ws.id);

    const { resolveActiveBindingForOperator } = await import("@/lib/photon/bindings");
    const { claimProactiveSlot, markOutboundSent, markOutboundFailed } = await import(
      "@/lib/photon/history"
    );
    const { getPreferences, isStoredPreferencesMalformed } = await import("@/lib/photon/preferences");
    const { postToThread } = await import("@/lib/photon/bot");
    const { requireStaff: checkStaff } = await import("@/lib/support-ops");

    const result = await sendOperatorNotification(
      {
        workspaceId: ws.id,
        operatorUserId: user.id,
        type: "connectivity_test",
        body: CONNECTIVITY_TEST_BODY,
        idempotencyKey: key,
        // Explicit staff click: bypasses preference suppression (quiet
        // hours + disabled toggle). Binding, staff, and thread gates stay.
        isTest: true,
      },
      {
        findBindingForOperator: async (workspaceId, operatorUserId) => {
          const b = await resolveActiveBindingForOperator(workspaceId, operatorUserId);
          return b
            ? {
                id: b.id,
                workspaceId: b.workspace_id,
                operatorUserId: b.operator_user_id,
                threadId: b.thread_id,
              }
            : null;
        },
        checkStaff: async (userId, workspaceId) => {
          await checkStaff(userId, workspaceId);
        },
        getPreferences: async (workspaceId, operatorUserId) => {
          const p = await getPreferences(workspaceId, operatorUserId);
          return {
            proactiveEnabled: p.proactiveEnabled,
            quietHoursEnabled: p.quietHoursEnabled,
            quietStart: p.quietStart,
            quietEnd: p.quietEnd,
            timezone: p.timezone,
            // getPreferences coerces for display; the send path needs the
            // raw verdict, so re-check stored state explicitly here.
            malformed: await isStoredPreferencesMalformed(workspaceId, operatorUserId),
          };
        },
        claimProactive: async (input) => {
          const { row, deduped } = await claimProactiveSlot(input);
          return {
            id: row.id,
            status: row.status,
            providerMessageId: row.provider_message_id,
            deduped,
          };
        },
        markSent: async (outboundId, providerId) => {
          await markOutboundSent(outboundId, providerId);
        },
        markFailed: async (outboundId) => {
          await markOutboundFailed(outboundId);
        },
        postToThread: async (threadId, text) => postToThread(threadId, text),
      },
    );

    if (result.ok) {
      return NextResponse.json({
        ok: true,
        deduped: result.deduped,
        providerMessageId: result.providerId,
        note: result.deduped
          ? "already sent for this action — no duplicate delivered"
          : "accepted by Photon — handset delivery is not confirmed by this receipt",
      });
    }
    const status =
      result.code === "no_binding"
        ? 404
        : result.code === "no_conversation"
          ? 409
          : result.code === "provider_failed"
            ? 502
            : result.code === "degraded"
              ? 503
              : 400;
    return NextResponse.json(
      { ok: false, code: result.code, error: result.message, recoverable: result.recoverable },
      { status },
    );
  } catch (e) {
    const status =
      typeof (e as { status?: unknown })?.status === "number"
        ? (e as { status: number }).status
        : 503;
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "request failed" },
      { status: status === 401 ? 401 : status },
    );
  }
}
