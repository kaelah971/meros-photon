import "server-only";

import type { BriefFindings } from "./evidence-brief";
import type { NotifyResult } from "./photon/notify";

// S7 visual evidence snapshots: a read-only, deterministic rendering of an
// EXISTING persisted S6 evidence brief. Nothing here calls AI or regenerates
// findings — the brief is the single source of truth, referenced by its
// version + source fingerprint. The outbound iMessage body and the on-screen
// preview are the SAME text, so the operator always sees exactly what sends.
//
// Privacy: the text carries aggregate observations and counts only. No
// customer names/ids, no conversation/message ids or excerpts. Full source
// detail stays behind staff authorization via the incident link.

export type SnapshotIncident = {
  id: string;
  title: string;
  status: string;
  severity: string;
  customer_count: number;
  conversation_count: number;
};

export type SnapshotBrief = {
  status: string;
  version: number;
  fingerprint: string;
  findings: BriefFindings;
  source_count: number;
  generated_at: string | null;
};

export type SnapshotState = "ready" | "empty" | "pending" | "failed" | "stale";

export type BuiltSnapshot = {
  sendable: boolean;
  state: SnapshotState;
  /** Exact text shown in preview AND sent over iMessage when sendable. */
  text: string;
  fingerprint: string;
  briefVersion: number;
};

/** Well under the Photon 2000-char notify cap; snapshot stays glanceable. */
export const SNAPSHOT_MAX_CHARS = 1500;
const MAX_FACTS = 4;
const MAX_CORROBORATED = 2;
const MAX_CONTRADICTIONS = 2;
const MAX_UNKNOWNS = 3;
const MAX_HYPOTHESES = 2;
const MAX_LINE = 160;

function clean(s: string, max: number): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "unknown freshness";
  const d = new Date(iso);
  if (Number.isNaN(+d)) return "unknown freshness";
  return d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

function emptyFindings(): BriefFindings {
  return { facts: [], corroborated: [], contradictions: [], unknowns: [], hypotheses: [] };
}

/**
 * Deterministic snapshot from persisted incident + brief. Pure: same inputs
 * always yield the same text. Non-current briefs yield an explicit,
 * non-sendable state instead of misleading content.
 */
export function buildSnapshot(input: {
  incident: SnapshotIncident;
  brief: SnapshotBrief | null;
  incidentUrl: string;
}): BuiltSnapshot {
  const { incident, incidentUrl } = input;
  const brief = input.brief;
  if (!brief) {
    return {
      sendable: false,
      state: "empty",
      text:
        `Meros incident: ${clean(incident.title, 120)}\n` +
        `Status ${incident.status} · severity ${incident.severity}\n\n` +
        `No evidence brief yet — link a conversation with real customer reports and it assembles automatically. Nothing to send.`,
      fingerprint: "",
      briefVersion: 0,
    };
  }
  if (brief.status === "pending") {
    return {
      sendable: false,
      state: "pending",
      text:
        `Meros incident: ${clean(incident.title, 120)}\n` +
        `Status ${incident.status} · severity ${incident.severity}\n\n` +
        `Evidence brief v${brief.version} is still assembling from ${brief.source_count} linked report(s). Preview again when it is current — nothing to send yet.`,
      fingerprint: brief.fingerprint,
      briefVersion: brief.version,
    };
  }
  if (brief.status === "failed") {
    return {
      sendable: false,
      state: "failed",
      text:
        `Meros incident: ${clean(incident.title, 120)}\n` +
        `Status ${incident.status} · severity ${incident.severity}\n\n` +
        `Brief assembly failed and no usable brief exists yet. Original evidence is preserved; the next linked report retries. Nothing to send.`,
      fingerprint: brief.fingerprint,
      briefVersion: brief.version,
    };
  }
  if (brief.status === "stale") {
    return {
      sendable: false,
      state: "stale",
      text:
        `Meros incident: ${clean(incident.title, 120)}\n` +
        `Status ${incident.status} · severity ${incident.severity}\n\n` +
        `Newer reports arrived after brief v${brief.version} — it is refreshing. Preview the updated version before sending; this text is NOT current.`,
      fingerprint: brief.fingerprint,
      briefVersion: brief.version,
    };
  }

  const f = brief.findings ?? emptyFindings();
  const lines: string[] = [];
  lines.push(`Meros incident: ${clean(incident.title, 120)}`);
  lines.push(
    `Status ${incident.status} · severity ${incident.severity} · ` +
      `${brief.source_count} report(s) across ${incident.conversation_count} conversation(s) · ` +
      `${incident.customer_count} customer(s) affected`,
  );
  lines.push(`Brief v${brief.version} · refreshed ${fmtDate(brief.generated_at)}`);
  lines.push("");
  if (f.facts.length > 0) {
    lines.push(`WHAT WE KNOW (${f.facts.length}):`);
    for (const fact of f.facts.slice(0, MAX_FACTS)) {
      const tags =
        fact.identifiers.length > 0
          ? ` [${fact.identifiers.slice(0, 3).map((t) => clean(t, 24)).join(" · ")}]`
          : "";
      lines.push(
        `• ${clean(fact.observation, MAX_LINE)}${tags} (${fact.sources.length} report${fact.sources.length === 1 ? "" : "s"})`,
      );
    }
    lines.push("");
  } else {
    lines.push("WHAT WE KNOW: no supportable findings in the current evidence.");
    lines.push("");
  }
  if (f.corroborated.length > 0) {
    lines.push(`CORROBORATED (${f.corroborated.length}):`);
    for (const c of f.corroborated.slice(0, MAX_CORROBORATED)) {
      lines.push(`• ${clean(c.pattern, MAX_LINE)} (${c.sources.length} independent reports)`);
    }
    lines.push("");
  }
  if (f.contradictions.length > 0) {
    lines.push(`DIFFERS (${f.contradictions.length}):`);
    for (const c of f.contradictions.slice(0, MAX_CONTRADICTIONS)) {
      lines.push(`• ${clean(c.description, MAX_LINE)}`);
    }
    lines.push("");
  }
  if (f.unknowns.length > 0) {
    lines.push("STILL UNKNOWN:");
    for (const u of f.unknowns.slice(0, MAX_UNKNOWNS)) {
      lines.push(`• ${clean(u, MAX_LINE)}`);
    }
    lines.push("");
  }
  if (f.hypotheses.length > 0) {
    lines.push("POSSIBLE EXPLANATIONS — UNVERIFIED, NOT CONFIRMED:");
    for (const h of f.hypotheses.slice(0, MAX_HYPOTHESES)) {
      lines.push(`• [unverified hypothesis] ${clean(h.text, MAX_LINE)}`);
    }
    lines.push("");
  }
  lines.push("Full evidence (staff sign-in required):");
  lines.push(incidentUrl);

  let text = lines.join("\n");
  if (text.length > SNAPSHOT_MAX_CHARS) text = text.slice(0, SNAPSHOT_MAX_CHARS - 1) + "…";
  return { sendable: true, state: "ready", text, fingerprint: brief.fingerprint, briefVersion: brief.version };
}

// ---- Delivery record: durable send intent + idempotency guard ----

type Sql = <T = Record<string, unknown>[]>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<T>;

async function requireSql(): Promise<Sql> {
  const { dbAvailable } = await import("./db");
  if (!(await dbAvailable())) throw Object.assign(new Error("database unavailable"), { status: 503 });
  const { neon } = await import("@neondatabase/serverless");
  return neon(process.env.DATABASE_URL!.trim()) as unknown as Sql;
}

export type SnapshotDeliveryStatus = "sending" | "sent" | "failed";

export type SnapshotDeliveryRow = {
  id: string;
  incident_id: string;
  workspace_id: string;
  binding_id: string | null;
  brief_fingerprint: string;
  brief_version: number;
  idempotency_key: string;
  status: SnapshotDeliveryStatus;
  provider_message_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

export type SnapshotStore = {
  claimDelivery: (input: {
    incidentId: string;
    workspaceId: string;
    bindingId: string | null;
    briefFingerprint: string;
    briefVersion: number;
    idempotencyKey: string;
  }) => Promise<{ row: SnapshotDeliveryRow; deduped: boolean }>;
  markDeliverySent: (id: string, providerId: string | null) => Promise<void>;
  markDeliveryFailed: (id: string, error: string) => Promise<void>;
};

export async function realSnapshotStore(): Promise<SnapshotStore> {
  const sql = await requireSql();
  return {
    claimDelivery: async (input) => {
      const rows = (await sql`
        insert into incident_snapshot_deliveries
          (incident_id, workspace_id, binding_id, brief_fingerprint, brief_version, idempotency_key, status)
        values (${input.incidentId}, ${input.workspaceId}, ${input.bindingId},
                ${input.briefFingerprint}, ${input.briefVersion}, ${input.idempotencyKey}, 'sending')
        on conflict (idempotency_key) do nothing
        returning id, incident_id, workspace_id, binding_id, brief_fingerprint, brief_version,
                  idempotency_key, status, provider_message_id, error, created_at, updated_at
      `) as unknown as SnapshotDeliveryRow[];
      if (rows[0]) return { row: rows[0], deduped: false };
      const existing = (await sql`
        select id, incident_id, workspace_id, binding_id, brief_fingerprint, brief_version,
               idempotency_key, status, provider_message_id, error, created_at, updated_at
        from incident_snapshot_deliveries
        where idempotency_key = ${input.idempotencyKey}
        limit 1
      `) as unknown as SnapshotDeliveryRow[];
      if (!existing[0]) throw new Error("snapshot delivery persist failed");
      return { row: existing[0], deduped: true };
    },
    markDeliverySent: async (id, providerId) => {
      await sql`
        update incident_snapshot_deliveries
        set status = 'sent', provider_message_id = coalesce(${providerId ?? null}, provider_message_id),
            error = null, updated_at = now()
        where id = ${id}
      `;
    },
    markDeliveryFailed: async (id, error) => {
      await sql`
        update incident_snapshot_deliveries
        set status = 'failed', error = ${error.slice(0, 500)}, updated_at = now()
        where id = ${id}
      `;
    },
  };
}

// ---- Explicit-send orchestration (never automatic) ----

export type SnapshotSendResult =
  | { ok: true; deduped: boolean; providerId: string | null; deliveryId: string; snapshot: BuiltSnapshot }
  | {
      ok: false;
      code:
        | "bad_body"
        | "not_found"
        | "brief_not_ready"
        | "fingerprint_mismatch"
        | "no_binding"
        | "in_progress"
        | "already_attempted"
        | "provider_failed"
        | "degraded"
        | "suppressed_disabled"
        | "suppressed_quiet_hours"
        | "suppressed_prefs_invalid"
        | "no_conversation"
        | "not_staff"
        | "workspace_mismatch";
      recoverable: boolean;
      suppressed?: boolean;
      message: string;
      snapshot?: BuiltSnapshot;
    };

export type SnapshotSenderDeps = {
  loadIncident: (incidentId: string, workspaceId: string) => Promise<SnapshotIncident | null>;
  loadBrief: (incidentId: string, workspaceId: string) => Promise<SnapshotBrief | null>;
  resolveBindingId: (workspaceId: string, operatorUserId: string) => Promise<string | null>;
  store: SnapshotStore;
  /** Reusable S2/S3 send path (binding/staff/prefs/thread/idempotency gates). */
  notify: (body: string, idempotencyKey: string) => Promise<NotifyResult>;
};

/**
 * Explicit-send orchestration for one snapshot. Never automatic: the caller
 * route only invokes this from the operator's explicit POST. Eligibility
 * (current brief + fingerprint match) is checked BEFORE claiming any
 * idempotency slot, so stale previews never consume a key. Delegates the
 * actual iMessage send to the existing S2/S3 notifier (staff, binding,
 * preference, quiet-hours, thread, and provider gates all reused).
 */
export async function sendIncidentSnapshot(
  input: {
    incidentId: string;
    workspaceId: string;
    operatorUserId: string;
    idempotencyKey: string;
    expectedFingerprint: string;
    incidentUrl: string;
  },
  deps: SnapshotSenderDeps,
): Promise<SnapshotSendResult> {
  const fail = (
    code: Extract<SnapshotSendResult, { ok: false }>["code"],
    recoverable: boolean,
    message: string,
    extra?: { suppressed?: boolean; snapshot?: BuiltSnapshot },
  ): SnapshotSendResult =>
    extra?.suppressed
      ? { ok: false, code, recoverable, suppressed: true as const, message, snapshot: extra.snapshot }
      : { ok: false, code, recoverable, message, snapshot: extra?.snapshot };

  const key = input.idempotencyKey.trim();
  if (!key || key.length > 128) {
    return fail("bad_body", false, "idempotency key must be 1-128 characters");
  }
  if (!input.expectedFingerprint.trim()) {
    return fail("bad_body", false, "expectedFingerprint is required — preview the current version first");
  }

  let incident: SnapshotIncident | null;
  try {
    incident = await deps.loadIncident(input.incidentId, input.workspaceId);
  } catch {
    return fail("degraded", true, "workspace state unreachable — nothing was sent");
  }
  if (!incident) {
    return fail("not_found", false, "incident not found in this workspace");
  }

  let brief: SnapshotBrief | null;
  try {
    brief = await deps.loadBrief(input.incidentId, input.workspaceId);
  } catch {
    return fail("degraded", true, "workspace state unreachable — nothing was sent");
  }
  const snapshot = buildSnapshot({ incident, brief, incidentUrl: input.incidentUrl });
  if (!snapshot.sendable) {
    return fail("brief_not_ready", true, `brief is ${snapshot.state} — preview the current version before sending`, {
      snapshot,
    });
  }
  if (snapshot.fingerprint !== input.expectedFingerprint.trim()) {
    return fail(
      "fingerprint_mismatch",
      true,
      "evidence changed since that preview — review the fresh version below, then send again",
      { snapshot },
    );
  }

  let bindingId: string | null;
  try {
    bindingId = await deps.resolveBindingId(input.workspaceId, input.operatorUserId);
  } catch {
    return fail("degraded", true, "workspace state unreachable — nothing was sent");
  }
  if (!bindingId) {
    return fail(
      "no_binding",
      true,
      "this operator is not paired in that workspace — pair iMessage first, then retry",
    );
  }

  let claim: { row: SnapshotDeliveryRow; deduped: boolean };
  try {
    claim = await deps.store.claimDelivery({
      incidentId: input.incidentId,
      workspaceId: input.workspaceId,
      bindingId,
      briefFingerprint: snapshot.fingerprint,
      briefVersion: snapshot.briefVersion,
      idempotencyKey: key,
    });
  } catch {
    return fail("degraded", true, "workspace state unreachable — nothing was sent");
  }
  if (claim.deduped) {
    if (claim.row.status === "sent") {
      return { ok: true, deduped: true, providerId: claim.row.provider_message_id, deliveryId: claim.row.id, snapshot };
    }
    if (claim.row.status === "sending") {
      return fail("in_progress", true, "this send is already in flight — wait for it to finish");
    }
    return fail(
      "already_attempted",
      true,
      "this send was already attempted and did not deliver — start a fresh send action to retry",
    );
  }
  const deliveryId = claim.row.id;

  let result: NotifyResult;
  try {
    result = await deps.notify(snapshot.text, key);
  } catch {
    try {
      await deps.store.markDeliveryFailed(deliveryId, "snapshot send threw before provider");
    } catch {
      // Slot stays 'sending'; a same-key retry reports in_progress instead
      // of duplicating. Report honestly.
    }
    return fail("provider_failed", true, "Photon send failed — nothing confirmed delivered");
  }
  if (result.ok) {
    try {
      await deps.store.markDeliverySent(deliveryId, result.providerId);
    } catch {
      // Accepted by the provider (id captured); report acceptance honestly.
    }
    return { ok: true, deduped: result.deduped, providerId: result.providerId, deliveryId, snapshot };
  }
  try {
    await deps.store.markDeliveryFailed(deliveryId, result.message);
  } catch {
    // Status write failed too — still report the provider truth, never loss.
  }
  return fail(result.code, result.recoverable, result.message, {
    suppressed: result.suppressed === true,
    snapshot,
  });
}
