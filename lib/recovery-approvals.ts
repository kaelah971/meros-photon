import "server-only";

import { createHash } from "node:crypto";

// S10 human-approved recovery control: approval + execution-control plane
// for staged S9 proposals. Approvals are durable, scoped, expiring
// decisions; executions are durable, idempotent records. There is NO
// automatic provider-backed execution in Meros today — the only supported
// action type is `manual_external_record` (operator-reported work with
// independent verification). Anything else fails closed as
// `no_supported_executor`. Staged ≠ approved; provider acceptance ≠
// success; execution success ≠ customer recovery (S11 owns resolution).
//
// Safety: AI text and Fix Card history are untrusted, never authorization.
// Every mutation is staff-authed at the route layer and workspace-scoped
// here. Scope changes, fingerprint changes, or expiry invalidate approvals.

export type ApprovalStatus =
  | "requested"
  | "approved"
  | "rejected"
  | "revoked"
  | "expired"
  | "invalidated";

export type ExecutionStatus =
  | "pending"
  | "in_progress"
  | "provider_accepted"
  | "verified_success"
  | "verified_failure"
  | "unknown_outcome";

/** Only operator-reported manual work is supported. No auto executors. */
export const SUPPORTED_ACTION_TYPES = ["manual_external_record"] as const;
export type SupportedActionType = (typeof SUPPORTED_ACTION_TYPES)[number];

export type ApprovalScope = {
  planId: string;
  planVersion: number;
  briefFingerprint: string;
  actionType: SupportedActionType;
  /** Exact step indexes (0-based) of the staged plan being authorized. */
  steps: number[];
  params: Record<string, unknown>;
};

export type ApprovalRow = {
  id: string;
  plan_id: string;
  incident_id: string;
  workspace_id: string;
  plan_version: number;
  brief_fingerprint: string;
  scope_hash: string;
  scope: ApprovalScope;
  status: ApprovalStatus;
  risk_ack: boolean;
  high_impact: boolean;
  requested_by_user_id: string | null;
  decided_by_user_id: string | null;
  expires_at: string | null;
  decided_at: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
};

export type ExecutionRow = {
  id: string;
  incident_id: string;
  workspace_id: string;
  plan_id: string;
  approval_id: string;
  action_type: SupportedActionType;
  params: Record<string, unknown>;
  idempotency_key: string;
  status: ExecutionStatus;
  actor_user_id: string | null;
  verifier_user_id: string | null;
  provider_ref: string | null;
  result_note: string | null;
  verification_evidence: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type PlanRef = {
  id: string;
  incident_id: string;
  workspace_id: string;
  plan_version: number;
  status: string;
  brief_fingerprint: string;
  payload: {
    riskLevel?: string;
    steps?: { risk?: string; kind?: string }[];
    prerequisites?: string[];
  };
};

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(",")}}`;
}

export function canonicalScope(input: {
  planId: string;
  planVersion: number;
  briefFingerprint: string;
  actionType: SupportedActionType;
  steps: number[];
  params: Record<string, unknown>;
}): { scope: ApprovalScope; hash: string } {
  const scope: ApprovalScope = {
    planId: input.planId,
    planVersion: input.planVersion,
    briefFingerprint: input.briefFingerprint,
    actionType: input.actionType,
    steps: [...input.steps].sort((a, b) => a - b),
    params: input.params,
  };
  const hash = createHash("sha256").update(stableStringify(scope)).digest("hex").slice(0, 32);
  return { scope, hash };
}

export function isHighImpact(payload: PlanRef["payload"]): boolean {
  if ((payload.riskLevel ?? "").toLowerCase() === "high") return true;
  return (payload.steps ?? []).some((s) => (s.risk ?? "").toLowerCase() === "high");
}

export function isTerminalApproval(s: ApprovalStatus): boolean {
  return s === "rejected" || s === "revoked" || s === "expired" || s === "invalidated";
}

export type ApprovalStore = {
  listForPlan: (planId: string, workspaceId: string) => Promise<ApprovalRow[]>;
  loadById: (approvalId: string, workspaceId: string) => Promise<ApprovalRow | null>;
  insertRequested: (input: {
    plan: PlanRef;
    scope: ApprovalScope;
    scopeHash: string;
    highImpact: boolean;
    riskAck: boolean;
    requestedBy: string;
    expiresAt: string;
    note: string | null;
  }) => Promise<{ row: ApprovalRow; deduped: boolean }>;
  decide: (input: {
    approvalId: string;
    workspaceId: string;
    to: "approved" | "rejected" | "revoked";
    actorUserId: string;
    note: string | null;
  }) => Promise<ApprovalRow>;
  markStale: (input: {
    approvalId: string;
    workspaceId: string;
    to: "expired" | "invalidated";
    reason: string;
  }) => Promise<ApprovalRow | null>;
};

export type ExecutionStore = {
  listForPlan: (planId: string, workspaceId: string) => Promise<ExecutionRow[]>;
  loadById: (executionId: string, workspaceId: string) => Promise<ExecutionRow | null>;
  activeForApproval: (approvalId: string, workspaceId: string) => Promise<ExecutionRow[]>;
  claim: (input: {
    incidentId: string;
    workspaceId: string;
    planId: string;
    approvalId: string;
    actionType: SupportedActionType;
    params: Record<string, unknown>;
    idempotencyKey: string;
    actorUserId: string;
    providerRef: string | null;
    resultNote: string | null;
  }) => Promise<{ row: ExecutionRow; deduped: boolean }>;
  verify: (input: {
    executionId: string;
    workspaceId: string;
    outcome: "verified_success" | "verified_failure";
    verifierUserId: string;
    evidence: string;
  }) => Promise<ExecutionRow>;
};

export type ApprovalDeps = {
  loadPlan: (planId: string, workspaceId: string) => Promise<PlanRef | null>;
  loadBriefFingerprint: (incidentId: string, workspaceId: string) => Promise<string | null>;
  approvals: ApprovalStore;
  executions: ExecutionStore;
};

function expired(row: ApprovalRow, now = Date.now()): boolean {
  return !!row.expires_at && new Date(row.expires_at).getTime() <= now;
}

export type RequestResult =
  | { action: "requested"; approval: ApprovalRow }
  | { action: "duplicate"; approval: ApprovalRow }
  | { action: "deferred"; reason: string };

/**
 * Request approval for a STAGED plan. Exact scope (plan version +
 * fingerprint + steps + params) is hashed; duplicates return the active
 * row instead of forking. High-impact scopes require explicit risk_ack.
 */
export async function requestApproval(
  planId: string,
  workspaceId: string,
  actorUserId: string,
  input: {
    actionType: SupportedActionType;
    steps: number[];
    params?: Record<string, unknown>;
    riskAck: boolean;
    expiresInHours?: number;
    note?: string | null;
  },
  deps: ApprovalDeps,
): Promise<RequestResult> {
  if (!SUPPORTED_ACTION_TYPES.includes(input.actionType)) {
    return { action: "deferred", reason: "no_supported_executor" };
  }
  const plan = await deps.loadPlan(planId, workspaceId).catch(() => null);
  if (!plan) return { action: "deferred", reason: "plan not found in this workspace" };
  if (plan.status !== "staged") {
    return { action: "deferred", reason: `plan is ${plan.status}, only staged plans can be approved` };
  }
  const stepCount = plan.payload.steps?.length ?? 0;
  const steps = [...new Set(input.steps)].filter((n) => Number.isInteger(n) && n >= 0 && n < stepCount);
  if (steps.length === 0) {
    return { action: "deferred", reason: "approval scope must name at least one valid plan step" };
  }
  const highImpact = isHighImpact(plan.payload);
  if (highImpact && !input.riskAck) {
    return { action: "deferred", reason: "high-impact scope requires explicit risk acknowledgment" };
  }
  const hours = input.expiresInHours ?? 24;
  if (!Number.isFinite(hours) || hours < 1 || hours > 168) {
    return { action: "deferred", reason: "expiry must be 1–168 hours" };
  }
  const params = (input.params ?? {}) as Record<string, unknown>;
  if (stableStringify(params).length > 4000) {
    return { action: "deferred", reason: "approval params too large" };
  }
  const { scope, hash } = canonicalScope({
    planId: plan.id,
    planVersion: plan.plan_version,
    briefFingerprint: plan.brief_fingerprint,
    actionType: input.actionType,
    steps,
    params,
  });
  const expiresAt = new Date(Date.now() + hours * 3600_000).toISOString();
  try {
    const { row, deduped } = await deps.approvals.insertRequested({
      plan,
      scope,
      scopeHash: hash,
      highImpact,
      riskAck: input.riskAck,
      requestedBy: actorUserId,
      expiresAt,
      note: (input.note ?? null)?.trim().slice(0, 500) || null,
    });
    return deduped ? { action: "duplicate", approval: row } : { action: "requested", approval: row };
  } catch (e) {
    return { action: "deferred", reason: e instanceof Error ? e.message : "approval write failed" };
  }
}

export type DecideResult =
  | { action: "decided"; approval: ApprovalRow }
  | { action: "deferred"; reason: string };

/**
 * Decide a requested approval. Approve requires: still requested,
 * unexpired, plan still staged at the same fingerprint/version, exact
 * scope match (checked at eligibility time and re-checked here via the
 * stored hash inputs), risk_ack for high-impact, and — for high-impact —
 * a decider other than the requester (no self-approval).
 */
export async function decideApproval(
  approvalId: string,
  workspaceId: string,
  actorUserId: string,
  decision: "approve" | "reject" | "revoke",
  note: string | null,
  deps: ApprovalDeps,
): Promise<DecideResult> {
  const row = await deps.approvals.loadById(approvalId, workspaceId).catch(() => null);
  if (!row) return { action: "deferred", reason: "approval not found in this workspace" };
  if (expired(row)) {
    await deps.approvals.markStale({ approvalId, workspaceId, to: "expired", reason: "past expires_at" }).catch(() => null);
    return { action: "deferred", reason: "approval expired" };
  }
  const plan = await deps.loadPlan(row.plan_id, workspaceId).catch(() => null);
  if (!plan) return { action: "deferred", reason: "plan not found in this workspace" };
  // Fingerprint / version drift invalidates — never approve stale scope.
  if (plan.status !== "staged" || plan.brief_fingerprint !== row.brief_fingerprint || plan.plan_version !== row.plan_version) {
    await deps.approvals
      .markStale({ approvalId, workspaceId, to: "invalidated", reason: "plan changed or evidence moved on" })
      .catch(() => null);
    return { action: "deferred", reason: "approval invalidated by changed plan or evidence" };
  }
  if (decision === "revoke") {
    if (row.status !== "approved") return { action: "deferred", reason: `cannot revoke ${row.status} approval` };
    try {
      const next = await deps.approvals.decide({
        approvalId,
        workspaceId,
        to: "revoked",
        actorUserId,
        note,
      });
      return { action: "decided", approval: next };
    } catch (e) {
      return { action: "deferred", reason: e instanceof Error ? e.message : "revoke failed" };
    }
  }
  if (row.status !== "requested") {
    return { action: "deferred", reason: `cannot decide ${row.status} approval` };
  }
  const liveFp = await deps.loadBriefFingerprint(row.incident_id, workspaceId).catch(() => null);
  if (liveFp && liveFp !== row.brief_fingerprint) {
    await deps.approvals
      .markStale({ approvalId, workspaceId, to: "invalidated", reason: "evidence fingerprint moved on" })
      .catch(() => null);
    return { action: "deferred", reason: "approval invalidated by changed evidence" };
  }
  if (decision === "reject") {
    try {
      const next = await deps.approvals.decide({
        approvalId,
        workspaceId,
        to: "rejected",
        actorUserId,
        note,
      });
      return { action: "decided", approval: next };
    } catch (e) {
      return { action: "deferred", reason: e instanceof Error ? e.message : "reject failed" };
    }
  }
  // approve
  if (row.high_impact) {
    if (!row.risk_ack) return { action: "deferred", reason: "high-impact approval lacks risk acknowledgment" };
    if (row.requested_by_user_id === actorUserId) {
      return { action: "deferred", reason: "high-impact approval requires an independent reviewer (no self-approval)" };
    }
  }
  try {
    const next = await deps.approvals.decide({
      approvalId,
      workspaceId,
      to: "approved",
      actorUserId,
      note,
    });
    return { action: "decided", approval: next };
  } catch (e) {
    return { action: "deferred", reason: e instanceof Error ? e.message : "approve failed" };
  }
}

export type Eligibility =
  | { eligible: true; approval: ApprovalRow }
  | { eligible: false; reason: string };

/**
 * Automatic-execution eligibility. Meros has no provider-backed executors,
 * so automatic dispatch ALWAYS resolves to `no_supported_executor` once
 * the approval itself is valid — callers must use the manual fallback.
 * The checks before that verdict still enforce staged/fresh/scope/expiry.
 */
export async function checkAutoEligibility(
  approvalId: string,
  workspaceId: string,
  deps: ApprovalDeps,
): Promise<Eligibility> {
  const row = await deps.approvals.loadById(approvalId, workspaceId).catch(() => null);
  if (!row) return { eligible: false, reason: "approval not found in this workspace" };
  if (expired(row)) {
    await deps.approvals.markStale({ approvalId, workspaceId, to: "expired", reason: "past expires_at" }).catch(() => null);
    return { eligible: false, reason: "approval expired" };
  }
  if (row.status !== "approved") {
    return { eligible: false, reason: `approval is ${row.status}, not approved` };
  }
  const plan = await deps.loadPlan(row.plan_id, workspaceId).catch(() => null);
  if (!plan) return { eligible: false, reason: "plan not found in this workspace" };
  if (plan.status !== "staged") {
    await deps.approvals
      .markStale({ approvalId, workspaceId, to: "invalidated", reason: `plan is ${plan.status}` })
      .catch(() => null);
    return { eligible: false, reason: `plan is ${plan.status}, approval invalidated` };
  }
  const currentFp = await deps.loadBriefFingerprint(plan.incident_id, workspaceId).catch(() => null);
  if (currentFp && currentFp !== row.brief_fingerprint) {
    await deps.approvals
      .markStale({ approvalId, workspaceId, to: "invalidated", reason: "evidence fingerprint moved on" })
      .catch(() => null);
    return { eligible: false, reason: "approval invalidated by changed evidence" };
  }
  const { hash } = canonicalScope({
    planId: row.scope.planId,
    planVersion: row.scope.planVersion,
    briefFingerprint: row.scope.briefFingerprint,
    actionType: row.scope.actionType,
    steps: row.scope.steps,
    params: row.scope.params,
  });
  if (hash !== row.scope_hash) {
    return { eligible: false, reason: "approval scope mismatch (parameter substitution blocked)" };
  }
  // No verified provider adapters exist for recovery operations.
  return { eligible: false, reason: "no_supported_executor: approved work requires manual intervention" };
}

export type ClaimResult =
  | { action: "claimed"; execution: ExecutionRow }
  | { action: "duplicate"; execution: ExecutionRow }
  | { action: "deferred"; reason: string };

/**
 * Claim manual-work intent durably (idempotent on workspace +
 * idempotency key). Initial state is `unknown_outcome` — Meros never ran
 * it, so nothing is proven until an independent verifier confirms.
 */
export async function claimManualExecution(
  approvalId: string,
  workspaceId: string,
  actorUserId: string,
  input: { idempotencyKey: string; externalRef?: string | null; resultNote?: string | null },
  deps: ApprovalDeps,
): Promise<ClaimResult> {
  const key = (input.idempotencyKey ?? "").trim().slice(0, 128);
  if (!key) return { action: "deferred", reason: "idempotency key is required" };
  const row = await deps.approvals.loadById(approvalId, workspaceId).catch(() => null);
  if (!row) return { action: "deferred", reason: "approval not found in this workspace" };
  if (expired(row)) {
    await deps.approvals.markStale({ approvalId, workspaceId, to: "expired", reason: "past expires_at" }).catch(() => null);
    return { action: "deferred", reason: "approval expired" };
  }
  if (row.status !== "approved") {
    return { action: "deferred", reason: `approval is ${row.status}, manual work needs an approved scope` };
  }
  const plan = await deps.loadPlan(row.plan_id, workspaceId).catch(() => null);
  if (!plan) return { action: "deferred", reason: "plan not found in this workspace" };
  if (plan.status !== "staged" || plan.brief_fingerprint !== row.brief_fingerprint) {
    await deps.approvals
      .markStale({ approvalId, workspaceId, to: "invalidated", reason: "plan or evidence changed" })
      .catch(() => null);
    return { action: "deferred", reason: "approval invalidated by changed plan or evidence" };
  }
  const liveFp = await deps.loadBriefFingerprint(row.incident_id, workspaceId).catch(() => null);
  if (liveFp && liveFp !== row.brief_fingerprint) {
    await deps.approvals
      .markStale({ approvalId, workspaceId, to: "invalidated", reason: "evidence fingerprint moved on" })
      .catch(() => null);
    return { action: "deferred", reason: "approval invalidated by changed evidence" };
  }
  const active = await deps.executions.activeForApproval(approvalId, workspaceId).catch(() => []);
  if (active.length > 0) {
    return { action: "duplicate", execution: active[0] };
  }
  try {
    const { row: exec, deduped } = await deps.executions.claim({
      incidentId: row.incident_id,
      workspaceId,
      planId: row.plan_id,
      approvalId: row.id,
      actionType: "manual_external_record",
      params: row.scope.params,
      idempotencyKey: key,
      actorUserId,
      providerRef: (input.externalRef ?? null)?.trim().slice(0, 200) || null,
      resultNote: (input.resultNote ?? null)?.trim().slice(0, 1000) || null,
    });
    return deduped ? { action: "duplicate", execution: exec } : { action: "claimed", execution: exec };
  } catch (e) {
    return { action: "deferred", reason: e instanceof Error ? e.message : "execution claim failed" };
  }
}

export type VerifyResult =
  | { action: "verified"; execution: ExecutionRow }
  | { action: "deferred"; reason: string };

/**
 * Independent verification of operator-reported work. The verifier must
 * differ from the recorder; evidence is required; success here means the
 * REPORTED work checked out — not that customers recovered (S11).
 */
export async function verifyManualExecution(
  executionId: string,
  workspaceId: string,
  verifierUserId: string,
  outcome: "verified_success" | "verified_failure",
  evidence: string,
  deps: ApprovalDeps,
): Promise<VerifyResult> {
  const exec = await deps.executions.loadById(executionId, workspaceId).catch(() => null);
  if (!exec) return { action: "deferred", reason: "execution not found in this workspace" };
  if (exec.action_type !== "manual_external_record") {
    return { action: "deferred", reason: "only manual records can be verified here" };
  }
  if (exec.status === "verified_success" || exec.status === "verified_failure") {
    return { action: "deferred", reason: `execution already ${exec.status}` };
  }
  if (exec.actor_user_id === verifierUserId) {
    return { action: "deferred", reason: "verification requires an independent reviewer" };
  }
  if (!evidence.trim()) return { action: "deferred", reason: "verification evidence is required" };
  try {
    const next = await deps.executions.verify({
      executionId,
      workspaceId,
      outcome,
      verifierUserId,
      evidence: evidence.trim().slice(0, 1000),
    });
    return { action: "verified", execution: next };
  } catch (e) {
    return { action: "deferred", reason: e instanceof Error ? e.message : "verify failed" };
  }
}

// ---- Neon stores (mirrors S9 patterns: workspace-scoped SQL + audit) ----

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

function toApproval(r: Record<string, unknown>): ApprovalRow {
  return {
    id: r.id as string,
    plan_id: r.plan_id as string,
    incident_id: r.incident_id as string,
    workspace_id: r.workspace_id as string,
    plan_version: r.plan_version as number,
    brief_fingerprint: r.brief_fingerprint as string,
    scope_hash: r.scope_hash as string,
    scope: r.scope as ApprovalScope,
    status: r.status as ApprovalStatus,
    risk_ack: !!r.risk_ack,
    high_impact: !!r.high_impact,
    requested_by_user_id: (r.requested_by_user_id as string | null) ?? null,
    decided_by_user_id: (r.decided_by_user_id as string | null) ?? null,
    expires_at: (r.expires_at as string | null) ?? null,
    decided_at: (r.decided_at as string | null) ?? null,
    note: (r.note as string | null) ?? null,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

function toExecution(r: Record<string, unknown>): ExecutionRow {
  return {
    id: r.id as string,
    incident_id: r.incident_id as string,
    workspace_id: r.workspace_id as string,
    plan_id: r.plan_id as string,
    approval_id: r.approval_id as string,
    action_type: r.action_type as SupportedActionType,
    params: (r.params as Record<string, unknown>) ?? {},
    idempotency_key: r.idempotency_key as string,
    status: r.status as ExecutionStatus,
    actor_user_id: (r.actor_user_id as string | null) ?? null,
    verifier_user_id: (r.verifier_user_id as string | null) ?? null,
    provider_ref: (r.provider_ref as string | null) ?? null,
    result_note: (r.result_note as string | null) ?? null,
    verification_evidence: (r.verification_evidence as string | null) ?? null,
    started_at: (r.started_at as string | null) ?? null,
    completed_at: (r.completed_at as string | null) ?? null,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

const APPROVAL_COLS = `id, plan_id, incident_id, workspace_id, plan_version,
  brief_fingerprint, scope_hash, scope, status, risk_ack, high_impact,
  requested_by_user_id, decided_by_user_id, expires_at, decided_at, note,
  created_at, updated_at`;

const EXEC_COLS = `id, incident_id, workspace_id, plan_id, approval_id,
  action_type, params, idempotency_key, status, actor_user_id, verifier_user_id,
  provider_ref, result_note, verification_evidence, started_at, completed_at,
  created_at, updated_at`;

export async function realApprovalStore(): Promise<ApprovalStore> {
  const sql = await requireSql();
  const { recordEvent } = await import("./incidents");
  return {
    listForPlan: async (planId, workspaceId) => {
      const rows = (await sql`
        select id, plan_id, incident_id, workspace_id, plan_version, brief_fingerprint, scope_hash, scope, status, risk_ack, high_impact, requested_by_user_id, decided_by_user_id, expires_at, decided_at, note, created_at, updated_at from incident_plan_approvals
        where plan_id = ${planId} and workspace_id = ${workspaceId}
        order by created_at desc limit 20
      `) as unknown as Record<string, unknown>[];
      return rows.map(toApproval);
    },
    loadById: async (approvalId, workspaceId) => {
      const rows = (await sql`
        select id, plan_id, incident_id, workspace_id, plan_version, brief_fingerprint, scope_hash, scope, status, risk_ack, high_impact, requested_by_user_id, decided_by_user_id, expires_at, decided_at, note, created_at, updated_at from incident_plan_approvals
        where id = ${approvalId} and workspace_id = ${workspaceId} limit 1
      `) as unknown as Record<string, unknown>[];
      return rows[0] ? toApproval(rows[0]) : null;
    },
    insertRequested: async (input) => {
      const existing = (await sql`
        select id, plan_id, incident_id, workspace_id, plan_version, brief_fingerprint, scope_hash, scope, status, risk_ack, high_impact, requested_by_user_id, decided_by_user_id, expires_at, decided_at, note, created_at, updated_at from incident_plan_approvals
        where plan_id = ${input.plan.id} and workspace_id = ${input.plan.workspace_id}
          and scope_hash = ${input.scopeHash}
          and status in ('requested', 'approved')
        order by created_at desc limit 1
      `) as unknown as Record<string, unknown>[];
      if (existing[0]) return { row: toApproval(existing[0]), deduped: true };
      const rows = (await sql`
        insert into incident_plan_approvals
          (plan_id, incident_id, workspace_id, plan_version, brief_fingerprint,
           scope_hash, scope, status, risk_ack, high_impact,
           requested_by_user_id, expires_at, note)
        values (${input.plan.id}, ${input.plan.incident_id}, ${input.plan.workspace_id},
                ${input.plan.plan_version}, ${input.plan.brief_fingerprint},
                ${input.scopeHash}, ${JSON.stringify(input.scope)}::jsonb, 'requested',
                ${input.riskAck}, ${input.highImpact},
                ${input.requestedBy}, ${input.expiresAt}, ${input.note})
        on conflict (plan_id) where status in ('requested', 'approved') do nothing
        returning id, plan_id, incident_id, workspace_id, plan_version, brief_fingerprint, scope_hash, scope, status, risk_ack, high_impact, requested_by_user_id, decided_by_user_id, expires_at, decided_at, note, created_at, updated_at
      `) as unknown as Record<string, unknown>[];
      if (rows[0]) {
        const row = toApproval(rows[0]);
        await recordEvent({
          incidentId: input.plan.incident_id,
          kind: "approval_requested",
          actorUserId: input.requestedBy,
          detail: { planId: input.plan.id, approvalId: row.id, scopeHash: input.scopeHash },
        }).catch(() => null);
        return { row, deduped: false };
      }
      const winner = (await sql`
        select id, plan_id, incident_id, workspace_id, plan_version, brief_fingerprint, scope_hash, scope, status, risk_ack, high_impact, requested_by_user_id, decided_by_user_id, expires_at, decided_at, note, created_at, updated_at from incident_plan_approvals
        where plan_id = ${input.plan.id} and workspace_id = ${input.plan.workspace_id}
          and status in ('requested', 'approved')
        order by created_at desc limit 1
      `) as unknown as Record<string, unknown>[];
      if (!winner[0]) throw new Error("approval persist failed");
      return { row: toApproval(winner[0]), deduped: true };
    },
    decide: async (input) => {
      const current = (await sql`
        select id, status from incident_plan_approvals
        where id = ${input.approvalId} and workspace_id = ${input.workspaceId} limit 1
      `) as unknown as { id: string; status: ApprovalStatus }[];
      if (!current[0]) throw Object.assign(new Error("approval not found"), { status: 404 });
      const from = current[0].status;
      const ok =
        (input.to === "approved" && from === "requested") ||
        (input.to === "rejected" && from === "requested") ||
        (input.to === "revoked" && from === "approved");
      if (!ok) {
        throw Object.assign(new Error(`cannot move approval from ${from} to ${input.to}`), { status: 409 });
      }
      const rows = (await sql`
        update incident_plan_approvals
        set status = ${input.to}, decided_by_user_id = ${input.actorUserId},
            decided_at = now(), note = coalesce(${input.note}, note), updated_at = now()
        where id = ${input.approvalId} and workspace_id = ${input.workspaceId}
        returning id, plan_id, incident_id, workspace_id, plan_version, brief_fingerprint, scope_hash, scope, status, risk_ack, high_impact, requested_by_user_id, decided_by_user_id, expires_at, decided_at, note, created_at, updated_at
      `) as unknown as Record<string, unknown>[];
      if (!rows[0]) throw new Error("approval decide failed");
      const row = toApproval(rows[0]);
      const kind =
        input.to === "approved" ? "approval_approved" : input.to === "rejected" ? "approval_rejected" : "approval_revoked";
      await recordEvent({
        incidentId: row.incident_id,
        kind,
        actorUserId: input.actorUserId,
        detail: { planId: row.plan_id, approvalId: row.id, from, to: input.to },
      }).catch(() => null);
      return row;
    },
    markStale: async (input) => {
      const rows = (await sql`
        update incident_plan_approvals
        set status = ${input.to}, updated_at = now()
        where id = ${input.approvalId} and workspace_id = ${input.workspaceId}
          and status in ('requested', 'approved')
        returning id, plan_id, incident_id, workspace_id, plan_version, brief_fingerprint, scope_hash, scope, status, risk_ack, high_impact, requested_by_user_id, decided_by_user_id, expires_at, decided_at, note, created_at, updated_at
      `) as unknown as Record<string, unknown>[];
      if (!rows[0]) return null;
      const row = toApproval(rows[0]);
      await recordEvent({
        incidentId: row.incident_id,
        kind: input.to === "expired" ? "approval_expired" : "approval_invalidated",
        actorUserId: null,
        detail: { planId: row.plan_id, approvalId: row.id, reason: input.reason },
      }).catch(() => null);
      return row;
    },
  };
}

export async function realExecutionStore(): Promise<ExecutionStore> {
  const sql = await requireSql();
  const { recordEvent } = await import("./incidents");
  return {
    listForPlan: async (planId, workspaceId) => {
      const rows = (await sql`
        select id, incident_id, workspace_id, plan_id, approval_id, action_type, params, idempotency_key, status, actor_user_id, verifier_user_id, provider_ref, result_note, verification_evidence, started_at, completed_at, created_at, updated_at from incident_action_executions
        where plan_id = ${planId} and workspace_id = ${workspaceId}
        order by created_at desc limit 20
      `) as unknown as Record<string, unknown>[];
      return rows.map(toExecution);
    },
    loadById: async (executionId, workspaceId) => {
      const rows = (await sql`
        select id, incident_id, workspace_id, plan_id, approval_id, action_type, params, idempotency_key, status, actor_user_id, verifier_user_id, provider_ref, result_note, verification_evidence, started_at, completed_at, created_at, updated_at from incident_action_executions
        where id = ${executionId} and workspace_id = ${workspaceId} limit 1
      `) as unknown as Record<string, unknown>[];
      return rows[0] ? toExecution(rows[0]) : null;
    },
    activeForApproval: async (approvalId, workspaceId) => {
      const rows = (await sql`
        select id, incident_id, workspace_id, plan_id, approval_id, action_type, params, idempotency_key, status, actor_user_id, verifier_user_id, provider_ref, result_note, verification_evidence, started_at, completed_at, created_at, updated_at from incident_action_executions
        where approval_id = ${approvalId} and workspace_id = ${workspaceId}
          and status in ('pending', 'in_progress', 'provider_accepted', 'unknown_outcome')
        order by created_at desc limit 5
      `) as unknown as Record<string, unknown>[];
      return rows.map(toExecution);
    },
    claim: async (input) => {
      // Durable intent first: idempotency key wins across double clicks,
      // retries, refreshes, and serverless re-invocations.
      const rows = (await sql`
        insert into incident_action_executions
          (incident_id, workspace_id, plan_id, approval_id, action_type, params,
           idempotency_key, status, actor_user_id, provider_ref, result_note,
           started_at)
        values (${input.incidentId}, ${input.workspaceId}, ${input.planId},
                ${input.approvalId}, ${input.actionType}, ${JSON.stringify(input.params)}::jsonb,
                ${input.idempotencyKey}, 'unknown_outcome', ${input.actorUserId},
                ${input.providerRef}, ${input.resultNote}, now())
        on conflict (workspace_id, idempotency_key) do nothing
        returning id, incident_id, workspace_id, plan_id, approval_id, action_type, params, idempotency_key, status, actor_user_id, verifier_user_id, provider_ref, result_note, verification_evidence, started_at, completed_at, created_at, updated_at
      `) as unknown as Record<string, unknown>[];
      if (rows[0]) {
        const row = toExecution(rows[0]);
        await recordEvent({
          incidentId: input.incidentId,
          kind: "execution_claimed",
          actorUserId: input.actorUserId,
          detail: {
            planId: input.planId,
            approvalId: input.approvalId,
            executionId: row.id,
            actionType: input.actionType,
            manual: true,
          },
        }).catch(() => null);
        return { row, deduped: false };
      }
      const winner = (await sql`
        select id, incident_id, workspace_id, plan_id, approval_id, action_type, params, idempotency_key, status, actor_user_id, verifier_user_id, provider_ref, result_note, verification_evidence, started_at, completed_at, created_at, updated_at from incident_action_executions
        where workspace_id = ${input.workspaceId} and idempotency_key = ${input.idempotencyKey}
        limit 1
      `) as unknown as Record<string, unknown>[];
      if (!winner[0]) throw new Error("execution claim failed");
      return { row: toExecution(winner[0]), deduped: true };
    },
    verify: async (input) => {
      const rows = (await sql`
        update incident_action_executions
        set status = ${input.outcome}, verifier_user_id = ${input.verifierUserId},
            verification_evidence = ${input.evidence}, completed_at = now(), updated_at = now()
        where id = ${input.executionId} and workspace_id = ${input.workspaceId}
          and status in ('pending', 'in_progress', 'provider_accepted', 'unknown_outcome')
        returning id, incident_id, workspace_id, plan_id, approval_id, action_type, params, idempotency_key, status, actor_user_id, verifier_user_id, provider_ref, result_note, verification_evidence, started_at, completed_at, created_at, updated_at
      `) as unknown as Record<string, unknown>[];
      if (!rows[0]) throw Object.assign(new Error("execution already decided or missing"), { status: 409 });
      const row = toExecution(rows[0]);
      await recordEvent({
        incidentId: row.incident_id,
        kind: input.outcome === "verified_success" ? "execution_verified_success" : "execution_verified_failure",
        actorUserId: input.verifierUserId,
        detail: { planId: row.plan_id, approvalId: row.approval_id, executionId: row.id, outcome: input.outcome },
      }).catch(() => null);
      return row;
    },
  };
}

/** Production wiring shared by S10 routes and server components. */
export async function realApprovalDeps(): Promise<ApprovalDeps> {
  const [approvals, executions] = await Promise.all([realApprovalStore(), realExecutionStore()]);
  return {
    approvals,
    executions,
    loadPlan: async (planId, workspaceId) => {
      const { realPlanStore } = await import("./recovery-plans");
      const store = await realPlanStore();
      const row = await store.loadById(planId, workspaceId);
      return row
        ? {
            id: row.id,
            incident_id: row.incident_id,
            workspace_id: row.workspace_id,
            plan_version: row.plan_version,
            status: row.status,
            brief_fingerprint: row.brief_fingerprint,
            payload: {
              riskLevel: row.payload.riskLevel,
              steps: row.payload.steps?.map((s) => ({ risk: s.risk, kind: s.kind })),
              prerequisites: row.payload.prerequisites,
            },
          }
        : null;
    },
    loadBriefFingerprint: async (incidentId, workspaceId) => {
      const { getIncidentBrief } = await import("./evidence-brief");
      const brief = await getIncidentBrief(incidentId, workspaceId).catch(() => null);
      return brief?.fingerprint ?? null;
    },
  };
}
