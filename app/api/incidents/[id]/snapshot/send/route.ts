import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getWorkspaceBySlug } from "@/lib/db";
import { getIncidentBrief } from "@/lib/evidence-brief";
import { getIncidentForWorkspace } from "@/lib/incidents";
import {
  realSnapshotStore,
  sendIncidentSnapshot,
  type SnapshotBrief,
  type SnapshotIncident,
} from "@/lib/incident-snapshot";
import { requireStaff } from "@/lib/support-ops";

function statusOf(e: unknown, fallback: number): number {
  const s = (e as { status?: unknown })?.status;
  return typeof s === "number" ? s : fallback;
}

function publicOrigin(req: Request): string {
  const env = process.env.MEROS_PUBLIC_URL?.trim();
  if (env) return env.replace(/\/$/, "");
  try {
    return new URL(req.url).origin;
  } catch {
    return "https://meros-photon.vercel.app";
  }
}

/**
 * S7 explicit snapshot send: staff-only, explicit click only. Sends ONE
 * plain-text evidence snapshot to the CALLING staff operator's own ACTIVE
 * binding via the reusable S2/S3 notification path (preference + quiet-hours
 * gates enforced — this is an explicit send, not a connectivity test, so
 * isTest is false). The body is derived deterministically from the persisted
 * brief version + fingerprint; a fingerprint mismatch against the previewed
 * version rejects with the fresh snapshot instead of sending stale text.
 * Never sends to unpaired operators, other operators, or customers.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let body: { workspaceSlug?: unknown; clientSnapshotId?: unknown; expectedFingerprint?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  const key = typeof body.clientSnapshotId === "string" ? body.clientSnapshotId.trim() : "";
  if (!key || key.length > 128) {
    return NextResponse.json(
      { ok: false, error: "clientSnapshotId is required (client-minted per click)" },
      { status: 400 },
    );
  }
  const expectedFingerprint =
    typeof body.expectedFingerprint === "string" ? body.expectedFingerprint.trim() : "";
  if (!expectedFingerprint) {
    return NextResponse.json(
      { ok: false, error: "expectedFingerprint is required — preview the current version first" },
      { status: 400 },
    );
  }

  try {
    const user = await requireUser();
    const slug = typeof body.workspaceSlug === "string" ? body.workspaceSlug.trim() : "";
    const ws = slug ? await getWorkspaceBySlug(slug) : null;
    if (!ws) return NextResponse.json({ ok: false, error: "workspace not found" }, { status: 404 });
    await requireStaff(user.id, ws.id);
    const { id } = await ctx.params;

    const incidentUrl = `${publicOrigin(req)}/app/workspaces/${slug}/incidents/${id}`;
    const store = await realSnapshotStore();

    const { resolveActiveBindingForOperator } = await import("@/lib/photon/bindings");
    const { claimProactiveSlot, markOutboundSent, markOutboundFailed } = await import(
      "@/lib/photon/history"
    );
    const { getPreferences, isStoredPreferencesMalformed } = await import("@/lib/photon/preferences");
    const { postToThread } = await import("@/lib/photon/bot");
    const { requireStaff: checkStaff } = await import("@/lib/support-ops");
    const { sendOperatorNotification } = await import("@/lib/photon/notify");

    const toSnapshotIncident = (incident: {
      id: string;
      title: string;
      status: string;
      severity: string;
      customer_count: number;
      conversation_count: number;
    }): SnapshotIncident => ({
      id: incident.id,
      title: incident.title,
      status: incident.status,
      severity: incident.severity,
      customer_count: incident.customer_count,
      conversation_count: incident.conversation_count,
    });

    const result = await sendIncidentSnapshot(
      {
        incidentId: id,
        workspaceId: ws.id,
        operatorUserId: user.id,
        idempotencyKey: key,
        expectedFingerprint,
        incidentUrl,
      },
      {
        loadIncident: async (incidentId, workspaceId) => {
          const row = await getIncidentForWorkspace(workspaceId, incidentId);
          return row ? toSnapshotIncident(row) : null;
        },
        loadBrief: async (incidentId, workspaceId) => {
          const row = await getIncidentBrief(incidentId, workspaceId);
          if (!row) return null;
          const brief: SnapshotBrief = {
            status: row.status,
            version: row.version,
            fingerprint: row.fingerprint,
            findings: row.findings,
            source_count: row.source_count,
            generated_at: row.generated_at,
          };
          return brief;
        },
        resolveBindingId: async (workspaceId, operatorUserId) => {
          const b = await resolveActiveBindingForOperator(workspaceId, operatorUserId);
          return b ? b.id : null;
        },
        store,
        notify: async (text, idempotencyKey) =>
          sendOperatorNotification(
            {
              workspaceId: ws.id,
              operatorUserId: user.id,
              type: "evidence_snapshot",
              body: text,
              idempotencyKey,
              // Explicit operator send: existing preference + quiet-hours
              // gates apply (NOT a connectivity test).
              isTest: false,
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
          ),
      },
    );

    if (result.ok) {
      return NextResponse.json({
        ok: true,
        deduped: result.deduped,
        providerMessageId: result.providerId,
        deliveryId: result.deliveryId,
        snapshot: {
          state: result.snapshot.state,
          fingerprint: result.snapshot.fingerprint,
          briefVersion: result.snapshot.briefVersion,
          text: result.snapshot.text,
        },
        note: result.deduped
          ? "already sent for this action — no duplicate delivered"
          : "accepted by Photon — handset delivery is not confirmed by this receipt",
      });
    }
    const status =
      result.code === "not_found"
        ? 404
        : result.code === "no_binding"
          ? 404
          : result.code === "no_conversation"
            ? 409
            : result.code === "fingerprint_mismatch" || result.code === "brief_not_ready"
              ? 409
              : result.code === "in_progress" || result.code === "already_attempted"
                ? 409
                : result.code === "provider_failed"
                  ? 502
                  : result.code === "degraded"
                    ? 503
                    : 400;
    return NextResponse.json(
      {
        ok: false,
        code: result.code,
        error: result.message,
        recoverable: result.recoverable,
        suppressed: result.suppressed === true,
        snapshot: result.snapshot
          ? {
              state: result.snapshot.state,
              fingerprint: result.snapshot.fingerprint,
              briefVersion: result.snapshot.briefVersion,
              text: result.snapshot.text,
            }
          : undefined,
      },
      { status },
    );
  } catch (e) {
    const status = statusOf(e, 503);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "request failed" },
      { status: status === 401 ? 401 : status },
    );
  }
}
