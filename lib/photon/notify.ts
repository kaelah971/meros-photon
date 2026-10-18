// Photon S2 server-initiated operator notifications.
// Pure orchestration with injected dependencies (same pattern as operator.ts):
// unit-testable without Neon or Photon; production wiring lives in the
// notify route + lib/photon/bot.ts (postToThread). Only ever sends to the
// ACTIVE binding's recorded conversation address — never a raw recipient.

export type OperatorNotificationType =
  | "connectivity_test"
  | "incident_detected"
  | "evidence_ready"
  | "evidence_snapshot"
  | "recovery_approval_required"
  | "recovery_progress"
  | "incident_resolved";

export type NotifyBinding = {
  id: string;
  workspaceId: string;
  operatorUserId: string;
  threadId: string | null;
};

export type NotifyInput = {
  workspaceId: string;
  operatorUserId: string;
  type: OperatorNotificationType;
  body: string;
  idempotencyKey: string;
  /**
   * Explicit staff-clicked connectivity tests bypass preference suppression
   * (quiet hours + disabled toggle): the operator deliberately asked for
   * this one message. All other types enforce preferences. Auth, binding,
   * and conversation-address gates still apply to tests.
   */
  isTest: boolean;
};

export type NotifyDeps = {
  findBindingForOperator: (
    workspaceId: string,
    operatorUserId: string,
  ) => Promise<NotifyBinding | null>;
  checkStaff: (userId: string, workspaceId: string) => Promise<void>;
  getPreferences: (
    workspaceId: string,
    operatorUserId: string,
  ) => Promise<{
    proactiveEnabled: boolean;
    quietHoursEnabled: boolean;
    quietStart: string;
    quietEnd: string;
    timezone: string;
    /** True only when a row exists but fails validation. Missing row
     * is NOT malformed (documented defaults apply). Tests bypass even
     * malformed rows; non-test sends are suppressed, never guessed. */
    malformed: boolean;
  }>;
  claimProactive: (input: {
    workspaceId: string;
    bindingId: string;
    threadId: string;
    bodyText: string;
    idempotencyKey: string;
  }) => Promise<{ id: string; status: string; providerMessageId: string | null; deduped: boolean }>;
  markSent: (outboundId: string, providerId?: string | null) => Promise<void>;
  markFailed: (outboundId: string) => Promise<void>;
  postToThread: (threadId: string, text: string) => Promise<{ providerId: string | null }>;
};

export type NotifyResult =
  | { ok: true; deduped: boolean; providerId: string | null; messageId: string }
  | {
      ok: false;
      code:
        | "bad_body"
        | "no_binding"
        | "workspace_mismatch"
        | "not_staff"
        | "suppressed_prefs_invalid"
        | "suppressed_disabled"
        | "suppressed_quiet_hours"
        | "no_conversation"
        | "already_attempted"
        | "provider_failed"
        | "degraded";
      recoverable: boolean;
      /** True when the send was deliberately skipped by operator preferences. */
      suppressed?: boolean;
      message: string;
    };

export const MAX_NOTIFY_CHARS = 2000;

/** Fixed S2 connectivity-test body (not fabricated incident content). */
export const CONNECTIVITY_TEST_BODY =
  `Meros is connected to Northstar Support.\n\n` +
  `Proactive notifications are ready.\n\n` +
  `I'll let you know when something needs your attention.`;

function fail(
  code: Extract<NotifyResult, { ok: false }>["code"],
  recoverable: boolean,
  message: string,
  suppressed = false,
): NotifyResult {
  return suppressed
    ? { ok: false, code, recoverable, suppressed: true as const, message }
    : { ok: false, code, recoverable, message };
}

export async function sendOperatorNotification(
  input: NotifyInput,
  deps: NotifyDeps,
): Promise<NotifyResult> {
  const body = input.body.trim();
  if (!body || body.length > MAX_NOTIFY_CHARS) {
    return fail("bad_body", false, "notification body must be 1-2000 characters");
  }
  const key = input.idempotencyKey.trim();
  if (!key || key.length > 128) {
    return fail("bad_body", false, "idempotency key must be 1-128 characters");
  }

  // 1. ACTIVE binding only. Revoked/pending/unknown senders never resolve
  // here, so revocation immediately stops proactive outbound.
  let binding: NotifyBinding | null;
  try {
    binding = await deps.findBindingForOperator(input.workspaceId, input.operatorUserId);
  } catch {
    return fail("degraded", true, "workspace state unreachable — nothing was sent");
  }
  if (!binding) {
    return fail(
      "no_binding",
      true,
      "this operator is not paired in that workspace — pair iMessage first, then retry",
    );
  }
  if (binding.workspaceId !== input.workspaceId) {
    return fail("workspace_mismatch", false, "binding does not belong to that workspace");
  }

  // 2. Staff gate on the resolved workspace (defense in depth: the caller
  // route already enforces requireStaff for the session user).
  try {
    await deps.checkStaff(binding.operatorUserId, binding.workspaceId);
  } catch {
    return fail(
      "not_staff",
      false,
      "the linked operator no longer has staff access to that workspace",
    );
  }

  // 3. Preference gates for NON-test notifications. Explicit staff-clicked
  // tests bypass suppression (the operator deliberately asked for this one
  // message); everything else honors the operator's own settings. Checked
  // BEFORE claiming any idempotency slot: suppressed events never consume
  // a key, so a later send is not mistaken for a duplicate.
  if (!input.isTest) {
    let prefs: {
      proactiveEnabled: boolean;
      quietHoursEnabled: boolean;
      quietStart: string;
      quietEnd: string;
      timezone: string;
      malformed: boolean;
    };
    try {
      prefs = await deps.getPreferences(binding.workspaceId, binding.operatorUserId);
    } catch {
      return fail("degraded", true, "workspace state unreachable — nothing was sent");
    }
    if (prefs.malformed) {
      return fail(
        "suppressed_prefs_invalid",
        true,
        "operator preferences are unreadable — refusing to send; re-save preferences to repair",
        true,
      );
    }
    if (!prefs.proactiveEnabled) {
      return fail(
        "suppressed_disabled",
        true,
        "proactive notifications are disabled for this operator — enable them to receive this",
        true,
      );
    }
    const { isQuietNow } = await import("./preferences");
    if (isQuietNow(prefs)) {
      return fail(
        "suppressed_quiet_hours",
        true,
        "inside quiet hours — held, not sent",
        true,
      );
    }
  }

  // 4. A recorded conversation address is required. Server-initiated sends
  // need a thread the operator actually opened (recorded from inbound);
  // the adapter rebuilds it after cold starts, but it cannot be invented.
  const threadId = binding.threadId?.trim() || null;
  if (!threadId) {
    return fail(
      "no_conversation",
      true,
      "no iMessage conversation recorded for this operator yet — ask them to send any message first, then retry",
    );
  }

  // 5. Idempotent claim BEFORE sending: same key returns the prior attempt
  // and never resends. A prior FAILED attempt is reported (not retried or
  // hidden) so the caller can mint a fresh explicit key to retry.
  let slot: { id: string; status: string; providerMessageId: string | null; deduped: boolean };
  try {
    slot = await deps.claimProactive({
      workspaceId: binding.workspaceId,
      bindingId: binding.id,
      threadId,
      bodyText: body,
      idempotencyKey: key,
    });
  } catch {
    return fail("degraded", true, "workspace state unreachable — nothing was sent");
  }
  if (slot.deduped) {
    if (slot.status === "sent") {
      return { ok: true, deduped: true, providerId: slot.providerMessageId, messageId: slot.id };
    }
    return fail(
      "already_attempted",
      true,
      "this notification was already attempted and did not send — use a fresh send action to retry",
    );
  }

  // 6. Send through the adapter. A resolved post = accepted by Spectrum
  // (provider id recorded). Handset delivery is NOT confirmed by this —
  // callers must report acceptance, never claimed delivery.
  let providerId: string | null = null;
  try {
    const sent = await deps.postToThread(threadId, body);
    providerId = sent.providerId ?? null;
  } catch {
    try {
      await deps.markFailed(slot.id);
    } catch {
      // History write failed too — the slot stays 'received'; a retry with
      // the same key reclaims it instead of duplicating. Report honestly.
    }
    return fail("provider_failed", true, "Photon send failed — nothing confirmed delivered");
  }
  try {
    await deps.markSent(slot.id, providerId);
  } catch {
    // Accepted by the provider (id captured above) but the status write
    // failed: still report acceptance with the provider id, never loss.
    return { ok: true, deduped: false, providerId, messageId: slot.id };
  }
  return { ok: true, deduped: false, providerId, messageId: slot.id };
}
