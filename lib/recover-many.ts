import "server-only";

import { createHash } from "node:crypto";

import { checkRedaction } from "./support-memory";

// S15E Recover Many: safe, customer-specific recovery staging for an
// incident. One review workflow may cover several individually eligible
// customers. Operators review exact per-recipient drafts and authorize an
// exact payload; only eligible recipients can be published, and publishing
// means "visible in the customer's own conversation" — never pushed to a device,
// read, or recovered.
//
// Safety posture: eligibility is computed from persisted, workspace-scoped
// evidence (never invented customers or outcomes). Drafts are built only
// from the recipient's own documented symptom plus an applicable,
// non-superseded shared fix, with explicit uncertainty and no promises.
// Editing a draft invalidates prior approval. S10's manual_external_record
// is NEVER reused as authorization for customer messaging.

export type RecipientEligibility = "eligible" | "needs_review" | "excluded";

export type RecipientStatus = "draft" | "approved" | "published_to_conversation" | "failed" | "unknown";

export type BatchStatus = "draft" | "approved" | "revoked" | "superseded";

export type EligibilityEval = {
  eligibility: RecipientEligibility;
  reasonCode: string;
  evidenceRefs: string[];
};

export type RecipientRow = {
  id: string;
  batch_id: string;
  incident_id: string;
  workspace_id: string;
  conversation_id: string;
  customer_id: string;
  eligibility: RecipientEligibility;
  reason_code: string;
  evidence_refs: string[];
  draft_text: string;
  payload_hash: string;
  status: RecipientStatus;
  idempotency_key: string;
  provider_message_id: string | null;
  decided_by_user_id: string | null;
  decided_at: string | null;
  error_note: string | null;
  created_at: string;
  updated_at: string;
};

export type BatchRow = {
  id: string;
  incident_id: string;
  workspace_id: string;
  plan_id: string | null;
  plan_version: number;
  brief_fingerprint: string;
  scope_hash: string;
  fingerprint: string;
  status: BatchStatus;
  high_impact: boolean;
  created_by_user_id: string | null;
  approved_by_user_id: string | null;
  approved_at: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
};

export type RecipientInput = {
  conversationId: string;
  customerId: string;
  /** User-authored message ids from THIS conversation, newest first. */
  userMessageIds: string[];
  /** Brief observation text grounded in this conversation's messages. */
  observations: { text: string; messageIds: string[] }[];
  /** Whether this conversation is already resolved. */
  conversationResolved: boolean;
  /** Current brief fingerprints covering this conversation's reports. */
  coveredByBrief: boolean;
};

export type SharedFixInput = {
  refId: string;
  tier: string;
  status: string;
  excerpt: string;
  reasons: string[];
} | null;

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(",")}}`;
}

export function hashPayload(parts: Record<string, unknown>): string {
  return createHash("sha256").update(stableStringify(parts)).digest("hex").slice(0, 32);
}

/**
 * Deterministic per-recipient eligibility. Fails closed: anything missing
 * or contradictory is needs_review/excluded, never eligible-by-default.
 */
export function evaluateRecipient(input: {
  recipient: RecipientInput;
  briefFingerprint: string | null;
  briefCurrent: boolean;
  planStaged: boolean;
  fix: SharedFixInput;
  contradictionMessageIds: string[];
}): EligibilityEval {
  const r = input.recipient;
  if (r.conversationResolved) {
    return { eligibility: "excluded", reasonCode: "conversation_resolved", evidenceRefs: [] };
  }
  if (r.userMessageIds.length === 0) {
    return { eligibility: "excluded", reasonCode: "no_customer_report", evidenceRefs: [] };
  }
  if (!input.briefCurrent) {
    return { eligibility: "needs_review", reasonCode: "brief_not_current", evidenceRefs: r.userMessageIds.slice(0, 4) };
  }
  if (!input.planStaged) {
    return { eligibility: "needs_review", reasonCode: "no_staged_plan", evidenceRefs: r.userMessageIds.slice(0, 4) };
  }
  if (!r.coveredByBrief) {
    return { eligibility: "excluded", reasonCode: "no_brief_source", evidenceRefs: r.userMessageIds.slice(0, 4) };
  }
  const hit = r.userMessageIds.filter((id) => input.contradictionMessageIds.includes(id));
  if (hit.length > 0) {
    return { eligibility: "needs_review", reasonCode: "contradictory_evidence", evidenceRefs: hit.slice(0, 4) };
  }
  if (!input.fix || input.fix.status !== "shared") {
    return { eligibility: "needs_review", reasonCode: "no_shared_fix", evidenceRefs: r.userMessageIds.slice(0, 4) };
  }
  const obs = r.observations[0];
  if (!obs || !obs.text.trim()) {
    return { eligibility: "needs_review", reasonCode: "missing_symptom_detail", evidenceRefs: r.userMessageIds.slice(0, 4) };
  }
  return {
    eligibility: "eligible",
    reasonCode: "grounded_report_with_shared_fix",
    evidenceRefs: [...obs.messageIds.slice(0, 4), input.fix.refId],
  };
}

const DRAFT_MAX = 1200;

/**
 * Bounded deterministic draft from allowlisted inputs only: the
 * recipient's own symptom observation plus the shared fix excerpt.
 * No invented claims, no promises, explicit uncertainty, no other
 * customer's content.
 */
export function buildRecipientDraft(input: {
  symptomText: string;
  fixExcerpt: string;
  fixRefId: string;
  customerDisplay: string | null;
}): string | null {
  const symptom = input.symptomText.trim().replace(/\s+/g, " ").slice(0, 220);
  if (!symptom) return null;
  const excerpt = input.fixExcerpt.trim().replace(/\s+/g, " ").slice(0, 320);
  if (!excerpt) return null;
  const lines = [
    "Following up on your report:",
    `“${symptom}”`,
    "",
    "A previously reviewed fix that matched similar reports says:",
    `“${excerpt}” (ref ${input.fixRefId.slice(0, 8)})`,
    "",
    "This isn't confirmed for your case. If safe to try, let us know what happens either way — your reply helps us verify.",
    "— Meros support (human-reviewed, not automated)",
  ];
  const text = lines.join("\n").slice(0, DRAFT_MAX);
  const redaction = checkRedaction(text);
  if (!redaction.passed) return null;
  return text;
}

export function draftPayloadHash(args: {
  incidentId: string;
  planId: string;
  planVersion: number;
  briefFingerprint: string;
  recipients: {
    recipientKey: string;
    conversationId: string;
    customerId: string;
    draftText: string;
    eligibility?: RecipientEligibility;
    reasonCode?: string;
    evidenceRefs?: string[];
  }[];
}): string {
  const sorted = [...args.recipients].sort((a, b) => (a.recipientKey < b.recipientKey ? -1 : 1));
  return hashPayload({
    incidentId: args.incidentId,
    planId: args.planId,
    planVersion: args.planVersion,
    briefFingerprint: args.briefFingerprint,
    recipients: sorted.map((r) => ({
      key: r.recipientKey,
      conversation: r.conversationId,
      customer: r.customerId,
      eligibility: r.eligibility ?? null,
      reasonCode: r.reasonCode ?? null,
      evidenceRefs: r.evidenceRefs ?? [],
      draftHash: hashPayload({ text: r.draftText }),
    })),
  });
}

// ---- Batch + recipient store (Neon, workspace-scoped SQL + audit) ----

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

function toBatch(r: Record<string, unknown>): BatchRow {
  return {
    id: r.id as string,
    incident_id: r.incident_id as string,
    workspace_id: r.workspace_id as string,
    plan_id: (r.plan_id as string | null) ?? null,
    plan_version: r.plan_version as number,
    brief_fingerprint: r.brief_fingerprint as string,
    scope_hash: r.scope_hash as string,
    fingerprint: r.fingerprint as string,
    status: r.status as BatchStatus,
    high_impact: !!r.high_impact,
    created_by_user_id: (r.created_by_user_id as string | null) ?? null,
    approved_by_user_id: (r.approved_by_user_id as string | null) ?? null,
    approved_at: (r.approved_at as string | null) ?? null,
    note: (r.note as string | null) ?? null,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

function toRecipient(r: Record<string, unknown>): RecipientRow {
  return {
    id: r.id as string,
    batch_id: r.batch_id as string,
    incident_id: r.incident_id as string,
    workspace_id: r.workspace_id as string,
    conversation_id: r.conversation_id as string,
    customer_id: r.customer_id as string,
    eligibility: r.eligibility as RecipientEligibility,
    reason_code: r.reason_code as string,
    evidence_refs: (r.evidence_refs as string[]) ?? [],
    draft_text: r.draft_text as string,
    payload_hash: r.payload_hash as string,
    status: r.status as RecipientStatus,
    idempotency_key: r.idempotency_key as string,
    provider_message_id: (r.provider_message_id as string | null) ?? null,
    decided_by_user_id: (r.decided_by_user_id as string | null) ?? null,
    decided_at: (r.decided_at as string | null) ?? null,
    error_note: (r.error_note as string | null) ?? null,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

const BATCH_COLS = `id, incident_id, workspace_id, plan_id, plan_version,
  brief_fingerprint, scope_hash, fingerprint, status, high_impact,
  created_by_user_id, approved_by_user_id, approved_at, note, created_at, updated_at`;

const RECIPIENT_COLS = `id, batch_id, incident_id, workspace_id, conversation_id, customer_id,
  eligibility, reason_code, evidence_refs, draft_text, payload_hash, status,
  idempotency_key, provider_message_id, decided_by_user_id, decided_at, error_note, created_at, updated_at`;

export type BatchStore = {
  activeForIncident: (incidentId: string, workspaceId: string) => Promise<BatchRow | null>;
  loadById: (batchId: string, workspaceId: string) => Promise<BatchRow | null>;
  createDraft: (input: {
    incidentId: string;
    workspaceId: string;
    planId: string | null;
    planVersion: number;
    briefFingerprint: string;
    scopeHash: string;
    fingerprint: string;
    highImpact: boolean;
    createdBy: string;
  }) => Promise<BatchRow>;
  finalizeDecision: (input: {
    batchId: string;
    workspaceId: string;
    to: "approved" | "revoked";
    actorUserId: string;
    note: string | null;
  }) => Promise<BatchRow>;
  markStale: (batchId: string, workspaceId: string, reason: string) => Promise<void>;
};

export type RecipientStore = {
  listForBatch: (batchId: string, workspaceId: string) => Promise<RecipientRow[]>;
  upsertRecipient: (input: {
    batchId: string;
    incidentId: string;
    workspaceId: string;
    conversationId: string;
    customerId: string;
    eligibility: RecipientEligibility;
    reasonCode: string;
    evidenceRefs: string[];
    draftText: string;
    payloadHash: string;
    idempotencyKey: string;
  }) => Promise<{ row: RecipientRow; created: boolean }>;
  setDraft: (input: { recipientId: string; workspaceId: string; draftText: string; payloadHash: string }) => Promise<RecipientRow>;
  loadRecipient: (recipientId: string, workspaceId: string) => Promise<RecipientRow | null>;
  approveEligible: (batchId: string, workspaceId: string, actorUserId: string) => Promise<number>;
  unapproveOnEdit: (batchId: string, workspaceId: string, actorUserId: string, reason: string) => Promise<void>;
  markPublished: (input: { recipientId: string; workspaceId: string; messageId: string; actorUserId: string }) => Promise<RecipientRow>;
  markFailed: (input: { recipientId: string; workspaceId: string; error: string; terminal: boolean; actorUserId: string | null }) => Promise<RecipientRow>;
};


export type LinkedConversation = { conversationId: string; customerId: string; resolved: boolean };
export type UserMessage = { id: string; createdAt: string; excerpt: string };

export type RecoverManyDeps = {
  loadIncident: (incidentId: string, workspaceId: string) => Promise<{ id: string; status: string } | null>;
  loadBrief: (incidentId: string, workspaceId: string) => Promise<{
    status: string; version: number; fingerprint: string;
    facts: { observation: string; identifiers: string[]; sources: string[] }[];
    unknowns: string[];
    contradictions: { description: string; between: string[] }[];
  } | null>;
  loadStagedPlan: (incidentId: string, workspaceId: string, briefFingerprint: string) => Promise<{ id: string; version: number } | null>;
  listLinkedConversations: (incidentId: string, workspaceId: string) => Promise<LinkedConversation[]>;
  listUserMessages: (conversationId: string, workspaceId: string) => Promise<UserMessage[]>;
  loadMatches: (incidentId: string, workspaceId: string, fingerprint: string) => Promise<SharedFixInput[]>;
  getCardStatus: (cardId: string, workspaceId: string) => Promise<string | null>;
  batches: BatchStore;
  recipients: RecipientStore;
  publishMessage: (input: { conversationId: string; text: string; clientId: string }) => Promise<{ messageId: string; deduped: boolean }>;
  isConversationLinked: (incidentId: string, conversationId: string, workspaceId: string, expectedCustomerId: string) => Promise<boolean>;
};

export type ProposeResult =
  | { action: "proposed" | "duplicate"; batch: BatchRow; recipients: RecipientRow[] }
  | { action: "deferred"; reason: string };

function recipientKey(conversationId: string, customerId: string): string {
  return hashPayload({ conversationId, customerId });
}

/**
 * Propose (or refresh) a recover-many batch: eligibility per linked
 * customer, deterministic grounded drafts, idempotent per incident.
 * A changed evidence fingerprint supersedes the prior active batch.
 */
export async function proposeBatch(
  incidentId: string,
  workspaceId: string,
  actorUserId: string,
  deps: RecoverManyDeps,
): Promise<ProposeResult> {
  const incident = await deps.loadIncident(incidentId, workspaceId).catch(() => null);
  if (!incident) return { action: "deferred", reason: "incident not found in this workspace" };
  if (!["investigating", "ready_for_action", "recovering", "monitoring"].includes(incident.status)) {
    return { action: "deferred", reason: "incident is not in an actionable state" };
  }
  const brief = await deps.loadBrief(incidentId, workspaceId).catch(() => null);
  if (!brief || brief.status !== "current") {
    return { action: "deferred", reason: "no current evidence brief" };
  }
  const plan = await deps.loadStagedPlan(incidentId, workspaceId, brief.fingerprint).catch(() => null);
  if (!plan) {
    return { action: "deferred", reason: "no staged plan for the current evidence" };
  }
  const matches = await deps.loadMatches(incidentId, workspaceId, brief.fingerprint).catch(() => [] as SharedFixInput[]);
  let fix: SharedFixInput = null;
  for (const m of matches) {
    if (!m) continue;
    const live = await deps.getCardStatus(m.refId, workspaceId).catch(() => null);
    if (live !== "shared") continue;
    if (!fix || (m.tier === "verified_fix" && fix.tier !== "verified_fix")) fix = { ...m, status: live };
    if (fix && fix.tier === "verified_fix") break;
  }
  const contradictionIds = [...new Set(brief.contradictions.flatMap((c) => c.between ?? []))];
  const factFor = (messageIds: string[]): { text: string; messageIds: string[] } | null => {
    for (const f of brief.facts) {
      const hit = (f.sources ?? []).filter((s) => messageIds.includes(s));
      if (hit.length > 0 && f.observation.trim()) return { text: f.observation, messageIds: hit.slice(0, 4) };
    }
    return null;
  };
  const linked = await deps.listLinkedConversations(incidentId, workspaceId).catch(() => []);
  if (linked.length === 0) return { action: "deferred", reason: "no linked conversations" };

  type Built = {
    conversationId: string; customerId: string;
    eligibility: RecipientEligibility; reasonCode: string; evidenceRefs: string[];
    draftText: string;
  };
  const built: Built[] = [];
  for (const conv of linked) {
    const msgs = await deps.listUserMessages(conv.conversationId, workspaceId).catch(() => []);
    const ids = msgs.map((m) => m.id);
    const ev = evaluateRecipient({
      recipient: {
        conversationId: conv.conversationId,
        customerId: conv.customerId,
        userMessageIds: ids,
        observations: (() => {
          const f = factFor(ids);
          return f ? [{ text: f.text, messageIds: f.messageIds }] : [];
        })(),
        conversationResolved: conv.resolved,
        coveredByBrief: factFor(ids) !== null,
      },
      briefFingerprint: brief.fingerprint,
      briefCurrent: true,
      planStaged: true,
      fix,
      contradictionMessageIds: contradictionIds,
    });
    let eligibility = ev.eligibility;
    let reasonCode = ev.reasonCode;
    let draftText = "";
    if (ev.eligibility === "eligible" && fix) {
      // Prefer this customer's own latest report over the shared brief wording.
      // The brief still gates eligibility; the draft stays individualized.
      const symptom = msgs[0]?.excerpt ?? factFor(ids)?.text ?? "";
      const draft = buildRecipientDraft({
        symptomText: symptom,
        fixExcerpt: fix.excerpt,
        fixRefId: fix.refId,
        customerDisplay: null,
      });
      if (draft) draftText = draft;
      else {
        eligibility = "needs_review";
        reasonCode = "draft_failed_safety_check";
      }
    }
    built.push({
      conversationId: conv.conversationId,
      customerId: conv.customerId,
      eligibility,
      reasonCode,
      evidenceRefs: ev.evidenceRefs,
      draftText,
    });
  }
  const fingerprint = draftPayloadHash({
    incidentId,
    planId: plan.id,
    planVersion: plan.version,
    briefFingerprint: brief.fingerprint,
    recipients: built.map((b) => ({
      recipientKey: recipientKey(b.conversationId, b.customerId),
      conversationId: b.conversationId,
      customerId: b.customerId,
      draftText: b.draftText,
      eligibility: b.eligibility,
      reasonCode: b.reasonCode,
      evidenceRefs: b.evidenceRefs,
    })),
  });
  const existing = await deps.batches.activeForIncident(incidentId, workspaceId).catch(() => null);
  if (existing && existing.fingerprint === fingerprint && existing.plan_id === plan.id) {
    const rows = await deps.recipients.listForBatch(existing.id, workspaceId).catch(() => []);
    return { action: "duplicate", batch: existing, recipients: rows };
  }
  if (existing) {
    await deps.batches.markStale(existing.id, workspaceId, "evidence changed").catch(() => null);
  }
  const scopeHash = hashPayload({ incidentId, plan: plan.id, brief: brief.fingerprint, recipients: built.length });
  const highImpact = built.some((b) => b.eligibility === "needs_review");
  const batch = await deps.batches.createDraft({
    incidentId,
    workspaceId,
    planId: plan.id,
    planVersion: plan.version,
    briefFingerprint: brief.fingerprint,
    scopeHash,
    fingerprint,
    highImpact,
    createdBy: actorUserId,
  });
  const { randomUUID } = await import("node:crypto");
  const rows: RecipientRow[] = [];
  for (const b of built) {
    const payloadHash = hashPayload({ draft: b.draftText, key: recipientKey(b.conversationId, b.customerId) });
    const { row } = await deps.recipients.upsertRecipient({
      batchId: batch.id,
      incidentId,
      workspaceId,
      conversationId: b.conversationId,
      customerId: b.customerId,
      eligibility: b.eligibility,
      reasonCode: b.reasonCode,
      evidenceRefs: b.evidenceRefs,
      draftText: b.draftText,
      payloadHash,
      idempotencyKey: randomUUID(),
    });
    rows.push(row);
  }
  return { action: "proposed", batch, recipients: rows };
}

export type DecisionResult =
  | { action: "decided"; batch: BatchRow }
  | { action: "deferred"; reason: string };

/**
 * Approve an exact batch payload. Any drift (new evidence, new plan,
 * edited drafts, changed membership) fails closed and supersedes.
 */
export async function approveBatch(
  batchId: string,
  workspaceId: string,
  actorUserId: string,
  deps: RecoverManyDeps,
): Promise<DecisionResult> {
  const batch = await deps.batches.loadById(batchId, workspaceId).catch(() => null);
  if (!batch) return { action: "deferred", reason: "batch not found in this workspace" };
  if (batch.status !== "draft") return { action: "deferred", reason: `batch is ${batch.status}` };
  const recipients = await deps.recipients.listForBatch(batch.id, workspaceId).catch(() => []);
  const recomputed = draftPayloadHash({
    incidentId: batch.incident_id,
    planId: batch.plan_id ?? "",
    planVersion: batch.plan_version,
    briefFingerprint: batch.brief_fingerprint,
    recipients: recipients.map((r) => ({
      recipientKey: recipientKey(r.conversation_id, r.customer_id),
      conversationId: r.conversation_id,
      customerId: r.customer_id,
      draftText: r.draft_text,
      eligibility: r.eligibility,
      reasonCode: r.reason_code,
      evidenceRefs: r.evidence_refs,
    })),
  });
  // Recompute against LIVE evidence to catch drift since drafting.
  const liveBrief = await deps.loadBrief(batch.incident_id, workspaceId).catch(() => null);
  const livePlan = liveBrief
    ? await deps.loadStagedPlan(batch.incident_id, workspaceId, liveBrief.fingerprint).catch(() => null)
    : null;
  const liveFp =
    liveBrief && livePlan
      ? draftPayloadHash({
          incidentId: batch.incident_id,
          planId: livePlan.id,
          planVersion: livePlan.version,
          briefFingerprint: liveBrief.fingerprint,
          recipients: recipients.map((r) => ({
            recipientKey: recipientKey(r.conversation_id, r.customer_id),
            conversationId: r.conversation_id,
            customerId: r.customer_id,
            draftText: r.draft_text,
            eligibility: r.eligibility,
            reasonCode: r.reason_code,
            evidenceRefs: r.evidence_refs,
          })),
        })
      : null;
  if (!liveFp || !livePlan || !liveBrief || livePlan.id !== batch.plan_id || liveBrief.fingerprint !== batch.brief_fingerprint) {
    await deps.batches.markStale(batch.id, workspaceId, "evidence changed").catch(() => null);
    return { action: "deferred", reason: "evidence changed since proposal — review a fresh batch" };
  }
  if (recomputed !== batch.fingerprint || liveFp !== batch.fingerprint) {
    await deps.batches.markStale(batch.id, workspaceId, "payload changed").catch(() => null);
    return { action: "deferred", reason: "payload changed since proposal — review a fresh batch" };
  }
  if (batch.high_impact && batch.created_by_user_id && batch.created_by_user_id === actorUserId) {
    return { action: "deferred", reason: "high-impact batch requires an independent reviewer (no self-approval)" };
  }
  try {
    const next = await deps.batches.finalizeDecision({ batchId, workspaceId, to: "approved", actorUserId, note: null });
    await deps.recipients.approveEligible(batchId, workspaceId, actorUserId).catch(() => 0);
    return { action: "decided", batch: next };
  } catch (e) {
    return { action: "deferred", reason: e instanceof Error ? e.message : "approve failed" };
  }
}

export type EditResult =
  | { action: "updated"; recipient: RecipientRow }
  | { action: "deferred"; reason: string };

/**
 * Staff edits a recipient draft. Allowed in draft; allowed in approved
 * ONLY by invalidating the approval first (batch + all recipients revert
 * to draft). Never editable once published.
 */
export async function editRecipientDraft(
  batchId: string,
  recipientId: string,
  workspaceId: string,
  actorUserId: string,
  text: string,
  deps: RecoverManyDeps,
): Promise<EditResult> {
  const batch = await deps.batches.loadById(batchId, workspaceId).catch(() => null);
  if (!batch) return { action: "deferred", reason: "batch not found in this workspace" };
  if (batch.status !== "draft" && batch.status !== "approved") {
    return { action: "deferred", reason: `batch is ${batch.status}` };
  }
  const clean = text.trim().replace(/\s+/g, " ");
  if (!clean) return { action: "deferred", reason: "draft text is required" };
  if (clean.length > 2000) return { action: "deferred", reason: "draft too long" };
  const { checkRedaction } = await import("./support-memory");
  const redaction = checkRedaction(clean);
  if (!redaction.passed) {
    return { action: "deferred", reason: "draft failed redaction: " + redaction.issues.join(", ") };
  }
  const row = await deps.recipients.listForBatch(batchId, workspaceId).then(
    (rows) => rows.find((r) => r.id === recipientId) ?? null,
    () => null,
  );
  if (!row) return { action: "deferred", reason: "recipient not found in this batch" };
  if (row.eligibility !== "eligible") {
    return { action: "deferred", reason: "only eligible recipients can carry a draft" };
  }
  const payloadHash = hashPayload({
    draft: clean,
    key: recipientKey(row.conversation_id, row.customer_id),
  });
  try {
    // Revoke approval before changing an approved payload. This removes the
    // publish gate first, so an edit can never race with an approved send.
    if (batch.status === "approved") {
      await deps.recipients.unapproveOnEdit(batchId, workspaceId, actorUserId, "draft edited");
    }
    const updated = await deps.recipients.setDraft({ recipientId, workspaceId, draftText: clean, payloadHash });
    return { action: "updated", recipient: updated };
  } catch (e) {
    return { action: "deferred", reason: e instanceof Error ? e.message : "draft update failed" };
  }
}

export type PublishResult =
  | { action: "published"; recipient: RecipientRow; deduped: boolean }
  | { action: "deferred"; reason: string };

/**
 * Publish one approved recipient's EXACT approved draft into their own
 * conversation as a staff-authored message. Idempotent per recipient key:
 * concurrent or repeated publishes land a single message. Never creates
 * customer content, never touches other conversations.
 */
export async function publishRecipient(
  batchId: string,
  recipientId: string,
  workspaceId: string,
  actorUserId: string,
  deps: RecoverManyDeps,
): Promise<PublishResult> {
  const batch = await deps.batches.loadById(batchId, workspaceId).catch(() => null);
  if (!batch) return { action: "deferred", reason: "batch not found in this workspace" };
  if (batch.status !== "approved") return { action: "deferred", reason: "batch is not approved" };
  const recipient = await deps.recipients.loadRecipient(recipientId, workspaceId).catch(() => null);
  if (!recipient || recipient.batch_id !== batchId) {
    return { action: "deferred", reason: "recipient not found in this batch" };
  }
  if (recipient.eligibility !== "eligible") {
    return { action: "deferred", reason: "only eligible recipients can be published" };
  }
  // Freshness gate: exact approved payload, current evidence, staged plan.
  const recipients = await deps.recipients.listForBatch(batchId, workspaceId).catch(() => []);
  const recomputed = draftPayloadHash({
    incidentId: batch.incident_id,
    planId: batch.plan_id ?? "",
    planVersion: batch.plan_version,
    briefFingerprint: batch.brief_fingerprint,
    recipients: recipients.map((r) => ({
      recipientKey: recipientKey(r.conversation_id, r.customer_id),
      conversationId: r.conversation_id,
      customerId: r.customer_id,
      draftText: r.draft_text,
      eligibility: r.eligibility,
      reasonCode: r.reason_code,
      evidenceRefs: r.evidence_refs,
    })),
  });
  if (recomputed !== batch.fingerprint) {
    await deps.batches.markStale(batch.id, workspaceId, "payload changed").catch(() => null);
    return { action: "deferred", reason: "payload changed since approval — re-review first" };
  }
  const liveLinked = await deps.isConversationLinked(batch.incident_id, recipient.conversation_id, workspaceId, recipient.customer_id).catch(() => false);
  if (!liveLinked) return { action: "deferred", reason: "conversation no longer linked to this incident" };
  const brief = await deps.loadBrief(batch.incident_id, workspaceId).catch(() => null);
  if (!brief || brief.status !== "current" || brief.fingerprint !== batch.brief_fingerprint) {
    await deps.batches.markStale(batch.id, workspaceId, "evidence changed").catch(() => null);
    return { action: "deferred", reason: "evidence changed since approval" };
  }
  const plan = await deps.loadStagedPlan(batch.incident_id, workspaceId, brief.fingerprint).catch(() => null);
  if (!plan || plan.id !== batch.plan_id) {
    await deps.batches.markStale(batch.id, workspaceId, "plan changed").catch(() => null);
    return { action: "deferred", reason: "recovery plan changed since approval" };
  }
  if (recipient.status === "published_to_conversation" && recipient.provider_message_id) {
    return { action: "published", recipient, deduped: true };
  }
  if (recipient.status !== "approved" && recipient.status !== "unknown") {
    return { action: "deferred", reason: `recipient is ${recipient.status}` };
  }
  let messageId: string;
  let deduped = false;
  try {
    const res = await deps.publishMessage({
      conversationId: recipient.conversation_id,
      text: recipient.draft_text,
      clientId: recipient.idempotency_key,
    });
    messageId = res.messageId;
    deduped = res.deduped;
  } catch (e) {
    await deps.recipients
      .markFailed({ recipientId, workspaceId, error: e instanceof Error ? e.message : "publish failed", terminal: false, actorUserId })
      .catch(() => null);
    return { action: "deferred", reason: "publish failed with an ambiguous outcome — check the conversation before retrying" };
  }
  try {
    const updated = await deps.recipients.markPublished({ recipientId, workspaceId, messageId, actorUserId });
    return { action: "published", recipient: updated, deduped };
  } catch {
    // Message exists but the status write failed: surface unknown rather
    // than claim success or silently retry.
    await deps.recipients.markFailed({ recipientId, workspaceId, error: "status write failed after insert", terminal: false, actorUserId }).catch(() => null);
    return { action: "deferred", reason: "published but unconfirmed — verify in the conversation before retrying" };
  }
}

export async function realRecoverManyDeps(): Promise<RecoverManyDeps> {
  const batches = await realBatchStore();
  const recipients = await realRecipientStore();
  return {
    batches,
    recipients,
    loadIncident: async (incidentId, workspaceId) => {
      const { getIncidentForWorkspace } = await import("./incidents");
      const r = await getIncidentForWorkspace(workspaceId, incidentId).catch(() => null);
      return r ? { id: r.id, status: r.status } : null;
    },
    loadBrief: async (incidentId, workspaceId) => {
      const { getIncidentBrief } = await import("./evidence-brief");
      const b = await getIncidentBrief(incidentId, workspaceId).catch(() => null);
      if (!b) return null;
      return {
        status: b.status,
        version: b.version,
        fingerprint: b.fingerprint,
        facts: (b.findings.facts ?? []).map((f) => ({ observation: f.observation, identifiers: f.identifiers ?? [], sources: f.sources ?? [] })),
        unknowns: b.findings.unknowns ?? [],
        contradictions: (b.findings.contradictions ?? []).map((c) => ({ description: c.description, between: c.between ?? [] })),
      };
    },
    loadStagedPlan: async (incidentId, workspaceId, briefFingerprint) => {
      const { realPlanStore } = await import("./recovery-plans");
      const store = await realPlanStore();
      const active = await store.loadActive(incidentId, workspaceId).catch(() => []);
      const staged = active
        .filter((p) => p.status === "staged" && p.brief_fingerprint === briefFingerprint)
        .sort((a, b) => b.plan_version - a.plan_version);
      return staged[0] ? { id: staged[0].id, version: staged[0].plan_version } : null;
    },
    listLinkedConversations: async (incidentId, workspaceId) => {
      const { listIncidentConversations } = await import("./incidents");
      const { listWorkspaceConversations } = await import("./support-ops");
      const [linked, all] = await Promise.all([
        listIncidentConversations(incidentId, workspaceId).catch(() => []),
        listWorkspaceConversations(workspaceId).catch(() => []),
      ]);
      const byId = new Map(all.map((c) => [c.id, c]));
      const out: LinkedConversation[] = [];
      for (const l of linked) {
        const c = byId.get(l.conversation_id);
        if (!c) continue;
        out.push({ conversationId: c.id, customerId: c.customer_id, resolved: c.status === "resolved" });
      }
      return out;
    },
    listUserMessages: async (conversationId) => {
      const { listMessages } = await import("./support-ops");
      const rows = await listMessages(conversationId).catch(() => []);
      return rows
        .filter((m) => m.role === "user")
        .slice(-8)
        .reverse()
        .map((m) => ({ id: m.id, createdAt: m.created_at, excerpt: m.content.slice(0, 200) }));
    },
    loadMatches: async (incidentId, workspaceId, fingerprint) => {
      const { realMatchStore } = await import("./fix-matches");
      const store = await realMatchStore();
      const rows = await store.loadForBrief(incidentId, workspaceId, fingerprint).catch(() => []);
      return rows.map((r) => ({
        refId: r.ref_id,
        tier: r.tier,
        status: r.payload.cardStatus ?? "",
        excerpt: r.payload.cardExcerpt ?? "",
        reasons: r.payload.reasons ?? [],
      }));
    },
    getCardStatus: async (cardId, workspaceId) => {
      const { getFixCardForWorkspace } = await import("./support-ops");
      const c = await getFixCardForWorkspace(cardId, workspaceId).catch(() => null);
      return c ? c.status : null;
    },
    publishMessage: async (input) => {
      const { addAssistantMessage } = await import("./support-ops");
      // Workspace/customer scoping is enforced by the caller via
      // isConversationLinked + recipient customer binding; the insert is
      // additionally idempotent on (conversation_id, client_id).
      const before = await (async () => {
        const { listMessages } = await import("./support-ops");
        const rows = await listMessages(input.conversationId).catch(() => []);
        return rows.find((m) => m.client_id === input.clientId)?.id ?? null;
      })();
      const id = await addAssistantMessage({
        conversationId: input.conversationId,
        content: input.text,
        model: null,
        privateUsed: false,
        sharedUsed: false,
        knowledgeUsed: false,
        provenance: [],
        clientId: input.clientId,
        authorKind: "staff",
      });
      return { messageId: id, deduped: before !== null && before === id };
    },
    isConversationLinked: async (incidentId, conversationId, workspaceId, expectedCustomerId) => {
      const { getIncidentForWorkspace, listIncidentConversations } = await import("./incidents");
      const inc = await getIncidentForWorkspace(workspaceId, incidentId).catch(() => null);
      if (!inc || !["investigating", "ready_for_action", "recovering", "monitoring"].includes(inc.status)) return false;
      const linked = await listIncidentConversations(incidentId, workspaceId).catch(() => []);
      if (!linked.some((l) => l.conversation_id === conversationId)) return false;
      const { listWorkspaceConversations } = await import("./support-ops");
      const all = await listWorkspaceConversations(workspaceId).catch(() => []);
      const conv = all.find((c) => c.id === conversationId);
      return !!conv && conv.status !== "resolved" && conv.customer_id === expectedCustomerId;
    },
  };
}
export async function realBatchStore(): Promise<BatchStore> {
  const sql = await requireSql();
  const { recordEvent } = await import("./incidents");
  return {
    activeForIncident: async (incidentId, workspaceId) => {
      const rows = (await sql`
        select id, incident_id, workspace_id, plan_id, plan_version,
          brief_fingerprint, scope_hash, fingerprint, status, high_impact,
          created_by_user_id, approved_by_user_id, approved_at, note, created_at, updated_at
        from incident_recovery_batches
        where incident_id = ${incidentId} and workspace_id = ${workspaceId}
          and status in ('draft', 'approved')
        order by created_at desc limit 1
      `) as unknown as Record<string, unknown>[];
      return rows[0] ? toBatch(rows[0]) : null;
    },
    loadById: async (batchId, workspaceId) => {
      const rows = (await sql`
        select id, incident_id, workspace_id, plan_id, plan_version,
          brief_fingerprint, scope_hash, fingerprint, status, high_impact,
          created_by_user_id, approved_by_user_id, approved_at, note, created_at, updated_at
        from incident_recovery_batches
        where id = ${batchId} and workspace_id = ${workspaceId} limit 1
      `) as unknown as Record<string, unknown>[];
      return rows[0] ? toBatch(rows[0]) : null;
    },
    createDraft: async (input) => {
      const rows = (await sql`
        insert into incident_recovery_batches
          (incident_id, workspace_id, plan_id, plan_version, brief_fingerprint,
           scope_hash, fingerprint, status, high_impact, created_by_user_id)
        values (${input.incidentId}, ${input.workspaceId}, ${input.planId}, ${input.planVersion},
                ${input.briefFingerprint}, ${input.scopeHash}, ${input.fingerprint}, 'draft', ${input.highImpact}, ${input.createdBy})
        on conflict (incident_id) where status in ('draft', 'approved') do nothing
        returning id, incident_id, workspace_id, plan_id, plan_version,
          brief_fingerprint, scope_hash, fingerprint, status, high_impact,
          created_by_user_id, approved_by_user_id, approved_at, note, created_at, updated_at
      `) as unknown as Record<string, unknown>[];
      if (rows[0]) {
        const row = toBatch(rows[0]);
        await recordEvent({
          incidentId: input.incidentId,
          kind: "recover_many_proposed",
          actorUserId: input.createdBy,
          detail: { batchId: row.id, fingerprint: input.fingerprint },
        }).catch(() => null);
        return row;
      }
      const winner = (await sql`
        select id, incident_id, workspace_id, plan_id, plan_version,
          brief_fingerprint, scope_hash, fingerprint, status, high_impact,
          created_by_user_id, approved_by_user_id, approved_at, note, created_at, updated_at
        from incident_recovery_batches
        where incident_id = ${input.incidentId} and workspace_id = ${input.workspaceId}
          and status in ('draft', 'approved')
        order by created_at desc limit 1
      `) as unknown as Record<string, unknown>[];
      if (!winner[0]) throw new Error("batch persist failed");
      return toBatch(winner[0]);
    },
    finalizeDecision: async (input) => {
      const current = (await sql`
        select id, status from incident_recovery_batches
        where id = ${input.batchId} and workspace_id = ${input.workspaceId} limit 1
      `) as unknown as { id: string; status: BatchStatus }[];
      if (!current[0]) throw Object.assign(new Error("batch not found"), { status: 404 });
      const from = current[0].status;
      const ok = (input.to === "approved" && from === "draft") || (input.to === "revoked" && from === "approved");
      if (!ok) throw Object.assign(new Error(`cannot move batch from ${from} to ${input.to}`), { status: 409 });
      const rows = (await sql`
        update incident_recovery_batches
        set status = ${input.to},
            approved_by_user_id = case when ${input.to} = 'approved' then ${input.actorUserId} else approved_by_user_id end,
            approved_at = case when ${input.to} = 'approved' then now() else approved_at end,
            note = coalesce(${input.note}, note), updated_at = now()
        where id = ${input.batchId} and workspace_id = ${input.workspaceId} and status = ${from}
        returning id, incident_id, workspace_id, plan_id, plan_version,
          brief_fingerprint, scope_hash, fingerprint, status, high_impact,
          created_by_user_id, approved_by_user_id, approved_at, note, created_at, updated_at
      `) as unknown as Record<string, unknown>[];
      if (!rows[0]) throw Object.assign(new Error("batch already decided"), { status: 409 });
      const row = toBatch(rows[0]);
      await recordEvent({
        incidentId: row.incident_id,
        kind: input.to === "approved" ? "recover_many_approved" : "recover_many_revoked",
        actorUserId: input.actorUserId,
        detail: { batchId: row.id },
      }).catch(() => null);
      return row;
    },
    markStale: async (batchId, workspaceId, reason) => {
      await sql`
        update incident_recovery_batches set status = 'superseded', updated_at = now()
        where id = ${batchId} and workspace_id = ${workspaceId} and status in ('draft', 'approved')
      `.catch(() => []);
      const rows = (await sql`
        select incident_id from incident_recovery_batches where id = ${batchId} limit 1
      `) as unknown as { incident_id: string }[];
      if (rows[0]) {
        const { recordEvent: record } = await import("./incidents");
        await record({ incidentId: rows[0].incident_id, kind: "recover_many_stale", actorUserId: null, detail: { batchId, reason } }).catch(() => null);
      }
    },
  };
}

export async function realRecipientStore(): Promise<RecipientStore> {
  const sql = await requireSql();
  return {
    listForBatch: async (batchId, workspaceId) => {
      const rows = (await sql`
        select id, batch_id, incident_id, workspace_id, conversation_id, customer_id,
               eligibility, reason_code, evidence_refs, draft_text, payload_hash, status,
               idempotency_key, provider_message_id, decided_by_user_id, decided_at, error_note, created_at, updated_at
        from incident_recovery_recipients
        where batch_id = ${batchId} and workspace_id = ${workspaceId}
        order by created_at
      `) as unknown as Record<string, unknown>[];
      return rows.map(toRecipient);
    },
    upsertRecipient: async (input) => {
      const rows = (await sql`
        insert into incident_recovery_recipients
          (batch_id, incident_id, workspace_id, conversation_id, customer_id,
           eligibility, reason_code, evidence_refs, draft_text, payload_hash, status, idempotency_key)
        values (${input.batchId}, ${input.incidentId}, ${input.workspaceId}, ${input.conversationId}, ${input.customerId},
                ${input.eligibility}, ${input.reasonCode}, ${JSON.stringify(input.evidenceRefs)}::jsonb,
                ${input.draftText}, ${input.payloadHash}, 'draft', ${input.idempotencyKey})
        on conflict (batch_id, conversation_id) do nothing
        returning id, batch_id, incident_id, workspace_id, conversation_id, customer_id,
          eligibility, reason_code, evidence_refs, draft_text, payload_hash, status,
          idempotency_key, provider_message_id, decided_by_user_id, decided_at, error_note, created_at, updated_at
      `) as unknown as Record<string, unknown>[];
      if (rows[0]) return { row: toRecipient(rows[0]), created: true };
      const winner = (await sql`
        select id, batch_id, incident_id, workspace_id, conversation_id, customer_id,
               eligibility, reason_code, evidence_refs, draft_text, payload_hash, status,
               idempotency_key, provider_message_id, decided_by_user_id, decided_at, error_note, created_at, updated_at
        from incident_recovery_recipients
        where batch_id = ${input.batchId} and conversation_id = ${input.conversationId}
        limit 1
      `) as unknown as Record<string, unknown>[];
      if (!winner[0]) throw new Error("recipient persist failed");
      return { row: toRecipient(winner[0]), created: false };
    },
    setDraft: async (input) => {
      const rows = (await sql`
        update incident_recovery_recipients
        set draft_text = ${input.draftText}, payload_hash = ${input.payloadHash},
            decided_by_user_id = null, decided_at = null, updated_at = now()
        where id = ${input.recipientId} and workspace_id = ${input.workspaceId}
          and status in ('draft', 'approved')
        returning id, batch_id, incident_id, workspace_id, conversation_id, customer_id,
          eligibility, reason_code, evidence_refs, draft_text, payload_hash, status,
          idempotency_key, provider_message_id, decided_by_user_id, decided_at, error_note, created_at, updated_at
      `) as unknown as Record<string, unknown>[];
      if (!rows[0]) throw Object.assign(new Error("recipient not editable"), { status: 409 });
      return toRecipient(rows[0]);
    },
    loadRecipient: async (recipientId, workspaceId) => {
      const rows = (await sql`
        select id, batch_id, incident_id, workspace_id, conversation_id, customer_id,
               eligibility, reason_code, evidence_refs, draft_text, payload_hash, status,
               idempotency_key, provider_message_id, decided_by_user_id, decided_at, error_note, created_at, updated_at
        from incident_recovery_recipients
        where id = ${recipientId} and workspace_id = ${workspaceId} limit 1
      `) as unknown as Record<string, unknown>[];
      return rows[0] ? toRecipient(rows[0]) : null;
    },
    approveEligible: async (batchId, workspaceId, actorUserId) => {
      // Batch approval flips every ELIGIBLE recipient to approved in one
      // statement; needs_review/excluded rows stay untouched and can never
      // be published.
      const rows = (await sql`
        update incident_recovery_recipients
        set status = 'approved', decided_by_user_id = ${actorUserId}, decided_at = now(), updated_at = now()
        where batch_id = ${batchId} and workspace_id = ${workspaceId}
          and eligibility = 'eligible' and status = 'draft'
        returning id
      `) as unknown as { id: string }[];
      return rows.length;
    },
    unapproveOnEdit: async (batchId, workspaceId, actorUserId, reason) => {
      // Any draft edit after approval invalidates that approval: the batch
      // returns to draft (approval cleared) and approved recipients return
      // to draft so nothing stale can be published.
      const b = (await sql`
        update incident_recovery_batches
        set status = 'draft', approved_by_user_id = null, approved_at = null, updated_at = now()
        where id = ${batchId} and workspace_id = ${workspaceId} and status = 'approved'
        returning id, incident_id
      `) as unknown as { id: string; incident_id: string }[];
      if (!b[0]) return;
      await sql`
        update incident_recovery_recipients
        set status = 'draft', decided_by_user_id = null, decided_at = null, updated_at = now()
        where batch_id = ${batchId} and workspace_id = ${workspaceId} and status = 'approved'
      `;
      const { recordEvent } = await import("./incidents");
      await recordEvent({
        incidentId: b[0].incident_id,
        kind: "recover_many_unapproved",
        actorUserId,
        detail: { batchId, reason },
      }).catch(() => null);
    },
    markPublished: async (input) => {
      const rows = (await sql`
        update incident_recovery_recipients
        set status = 'published_to_conversation', provider_message_id = ${input.messageId},
            decided_at = now(), updated_at = now(), error_note = null
        where id = ${input.recipientId} and workspace_id = ${input.workspaceId}
        returning id, batch_id, incident_id, workspace_id, conversation_id, customer_id,
          eligibility, reason_code, evidence_refs, draft_text, payload_hash, status,
          idempotency_key, provider_message_id, decided_by_user_id, decided_at, error_note, created_at, updated_at
      `) as unknown as Record<string, unknown>[];
      if (!rows[0]) throw new Error("recipient publish persist failed");
      const row = toRecipient(rows[0]);
      const { recordEvent } = await import("./incidents");
      await recordEvent({
        incidentId: row.incident_id,
        kind: "recover_many_published",
        actorUserId: input.actorUserId,
        detail: { batchId: row.batch_id, recipientId: row.id, conversationId: row.conversation_id, messageId: row.provider_message_id },
      }).catch(() => null);
      return row;
    },
    markFailed: async (input) => {
      const rows = (await sql`
        update incident_recovery_recipients
        set status = ${input.terminal ? "failed" : "unknown"}, error_note = ${input.error}, updated_at = now()
        where id = ${input.recipientId} and workspace_id = ${input.workspaceId}
        returning id, batch_id, incident_id, workspace_id, conversation_id, customer_id,
          eligibility, reason_code, evidence_refs, draft_text, payload_hash, status,
          idempotency_key, provider_message_id, decided_by_user_id, decided_at, error_note, created_at, updated_at
      `) as unknown as Record<string, unknown>[];
      if (!rows[0]) throw new Error("recipient failure persist failed");
      const row = toRecipient(rows[0]);
      if (input.actorUserId) {
        const { recordEvent } = await import("./incidents");
        await recordEvent({
          incidentId: row.incident_id,
          kind: "recover_many_failed",
          actorUserId: input.actorUserId,
          detail: { batchId: row.batch_id, recipientId: row.id, terminal: input.terminal, error: input.error.slice(0, 200) },
        }).catch(() => null);
      }
      return row;
    },
  };
}
