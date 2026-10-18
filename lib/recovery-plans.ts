import "server-only";

import { after } from "next/server";

import type { BriefFindings } from "./evidence-brief";

// S9 recovery plan staging: durable, human-reviewable proposals for confirmed
// incidents. Planning and review ONLY — nothing here executes, sends, or
// mutates anything outside the plans table + timeline audit events. Plans
// are grounded in the CURRENT S6 brief and eligible S8 matches; unchanged
// inputs never regenerate; new evidence supersedes old proposals (kept as
// history). Plan states are independent of the incident lifecycle.
//
// Safety posture: historical content and customer messages are untrusted
// input, never instructions. Steps carry no executable commands, scripts, or
// endpoint calls — validation drops anything shaped like one. Corrective
// steps always require human involvement and verification; high-risk
// corrective steps additionally require prerequisites and an explicit
// human-approval safety warning.

export type PlanStatus = "draft" | "under_review" | "staged" | "rejected" | "superseded";
export type PlanStepKind = "diagnostic" | "corrective";
export type PlanRisk = "low" | "medium" | "high";

export type PlanStep = {
  description: string;
  purpose: string;
  kind: PlanStepKind;
  evidenceRefs: string[];
  matchRefs: string[];
  prerequisites: string[];
  expectedResult: string;
  risk: PlanRisk;
  humanRequired: boolean;
  verification: string;
};

export type PlanHistoricalBasis = {
  refId: string;
  tier: string;
  whatWasDocumented: string;
  whyMayApply: string;
  differences: string;
  preconditions: string;
  needsVerification: string;
  /** Mandatory unless the tier is verified_fix: why the past is not proof. */
  caution: string;
};

export type PlanPayload = {
  problemSummary: string;
  approach: string;
  steps: PlanStep[];
  prerequisites: string[];
  missingInfo: string[];
  riskLevel: PlanRisk;
  safetyWarnings: string[];
  expectedOutcomes: string[];
  verificationChecks: string[];
  rollbackNotes: string;
  historicalBasis: PlanHistoricalBasis[];
};

export type PlanRow = {
  id: string;
  incident_id: string;
  workspace_id: string;
  plan_version: number;
  status: PlanStatus;
  brief_fingerprint: string;
  brief_version: number;
  payload: PlanPayload;
  created_by_user_id: string | null;
  reviewed_by_user_id: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string;
  updated_at: string;
};

export type PlanBrief = {
  status: string;
  version: number;
  fingerprint: string;
  findings: BriefFindings;
  source_count: number;
  generated_at: string | null;
};

export type PlanMatch = {
  refId: string;
  tier: string;
  reasons: string[];
  matchingSymptoms: string[];
  differences: string[];
  unknowns: string[];
  applicable: boolean;
  warning: string;
  cardStatus: string;
  cardResolved: boolean | null;
  cardExcerpt: string;
};

export type PlanIncident = {
  id: string;
  title: string;
  status: string;
  severity: string;
};

const MAX_LIST = 8;
const MAX_TEXT = 500;
const MAX_STEPS = 8;

/** Phrases that turn speculation into false certainty — output is invalid. */
const BANNED_CERTAINTY = [
  "root cause is",
  "root-cause is",
  "confirmed the cause",
  "definitely caused",
  "definitely know",
  "certainly caused",
  "certainly know",
  "proven to be",
  "we are certain",
];

/** Shapes of automatically runnable operations — never staged. */
const EXECUTABLE_PATTERNS = [
  /```/,
  /^\s*(sudo|rm\s+-rf?\b|curl\s|wget\s|ssh\s|kubectl\s|psql\s|mysql\s|drop\s+table|delete\s+from|truncate\s+table)/i,
  /\|\s*(sh|bash|zsh)\b/,
  /https?:\/\/\S+\/(exec|execute|run-command|api\/v\d+\/execute)/i,
  /\b(eval|exec)\s*\(/,
];

function str(v: unknown, max = MAX_TEXT): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().replace(/\s+/g, " ");
  if (!t) return null;
  return t.length > max ? t.slice(0, max) : t;
}

function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return (v as unknown[])
    .map((x) => str(x))
    .filter((x): x is string => x !== null)
    .slice(0, MAX_LIST);
}

function hasBannedCertainty(text: string): boolean {
  const lower = text.toLowerCase();
  return BANNED_CERTAINTY.some((p) => lower.includes(p));
}

function looksExecutable(text: string): boolean {
  return EXECUTABLE_PATTERNS.some((re) => re.test(text));
}

/** Every message id the brief cites — the only citable evidence. */
export function briefEvidenceIds(brief: PlanBrief): Set<string> {
  const ids = new Set<string>();
  const f = brief.findings ?? { facts: [], corroborated: [], contradictions: [], unknowns: [], hypotheses: [] };
  for (const fact of f.facts ?? []) for (const s of fact.sources ?? []) ids.add(s);
  for (const c of f.corroborated ?? []) for (const s of c.sources ?? []) ids.add(s);
  for (const c of f.contradictions ?? []) for (const s of c.between ?? []) ids.add(s);
  for (const h of f.hypotheses ?? []) for (const s of h.basedOn ?? []) ids.add(s);
  ids.delete("");
  return ids;
}

function cleanIdList(v: unknown, allowed: ReadonlySet<string>): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set((v as unknown[]).filter((x): x is string => typeof x === "string" && allowed.has(x)))].slice(
    0,
    MAX_LIST,
  );
}

function validRisk(v: unknown): PlanRisk | null {
  return v === "low" || v === "medium" || v === "high" ? v : null;
}

function validKind(v: unknown): PlanStepKind | null {
  return v === "diagnostic" || v === "corrective" ? v : null;
}

function validateStep(
  raw: unknown,
  evidenceIds: ReadonlySet<string>,
  matchIds: ReadonlySet<string>,
): PlanStep | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const description = str(o.description);
  const purpose = str(o.purpose);
  const expectedResult = str(o.expectedResult);
  const verification = str(o.verification);
  const kind = validKind(o.kind);
  const risk = validRisk(o.risk);
  if (!description || !purpose || !expectedResult || !verification || !kind || !risk) return null;
  for (const t of [description, purpose, expectedResult, verification]) {
    if (looksExecutable(t)) return null;
  }
  const evidenceRefs = cleanIdList(o.evidenceRefs, evidenceIds);
  const matchRefs = cleanIdList(o.matchRefs, matchIds);
  if (evidenceRefs.length === 0 && matchRefs.length === 0) return null;
  const prerequisites = strList(o.prerequisites);
  const humanRequired = o.humanRequired === true;
  if (kind === "corrective") {
    // Corrective action without a named human owner or verification is not
    // reviewable — reject the step, never soften it.
    if (!humanRequired || prerequisites.length === 0) return null;
  }
  return {
    description,
    purpose,
    kind,
    evidenceRefs,
    matchRefs,
    prerequisites,
    expectedResult,
    risk,
    humanRequired,
    verification,
  };
}

function validateHistoricalBasis(
  raw: unknown,
  matchIds: ReadonlySet<string>,
  tiers: ReadonlyMap<string, string>,
): PlanHistoricalBasis | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const refId = typeof o.refId === "string" ? o.refId : "";
  if (!matchIds.has(refId)) return null;
  const whatWasDocumented = str(o.whatWasDocumented);
  const whyMayApply = str(o.whyMayApply);
  if (!whatWasDocumented || !whyMayApply) return null;
  for (const t of [whatWasDocumented, whyMayApply]) {
    if (looksExecutable(t) || hasBannedCertainty(t)) return null;
  }
  const tier = tiers.get(refId) ?? "";
  const caution = str(o.caution) ?? "";
  // A historically resolved issue is not proof of present-day applicability:
  // non-verified tiers must carry an explicit caution.
  if (tier !== "verified_fix" && !caution) return null;
  return {
    refId,
    tier,
    whatWasDocumented,
    whyMayApply,
    differences: str(o.differences) ?? "",
    preconditions: str(o.preconditions) ?? "",
    needsVerification: str(o.needsVerification) ?? "",
    caution,
  };
}

/**
 * Strict validation of model output. Returns a storable payload or null
 * (invalid/unsafe → retain existing data, show failure). Never repairs by
 * invention: ungrounded or unsafe entries are dropped, and empty results
 * invalidate the whole proposal.
 */
export function validateRecoveryPlan(
  raw: unknown,
  evidenceIds: ReadonlySet<string>,
  matchIds: ReadonlySet<string>,
  tiers: ReadonlyMap<string, string>,
): PlanPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const problemSummary = str(o.problemSummary);
  const approach = str(o.approach);
  if (!problemSummary || !approach) return null;
  if (hasBannedCertainty(problemSummary) || hasBannedCertainty(approach)) return null;
  if (looksExecutable(problemSummary) || looksExecutable(approach)) return null;

  const steps: PlanStep[] = [];
  if (Array.isArray(o.steps)) {
    for (const s of o.steps.slice(0, MAX_STEPS)) {
      const step = validateStep(s, evidenceIds, matchIds);
      if (step) steps.push(step);
    }
  }
  if (steps.length === 0) return null;

  const riskLevel = validRisk(o.riskLevel);
  if (!riskLevel) return null;
  const safetyWarnings = strList(o.safetyWarnings);
  const hasHighRiskCorrective = steps.some((s) => s.kind === "corrective" && s.risk === "high");
  if (hasHighRiskCorrective) {
    // High-impact proposals without an explicit human-approval warning are
    // not stageable.
    const joined = safetyWarnings.join(" ").toLowerCase();
    if (!/(human|approval|manual|review)/.test(joined)) return null;
  }

  const historicalBasis: PlanHistoricalBasis[] = [];
  if (Array.isArray(o.historicalBasis)) {
    for (const h of o.historicalBasis.slice(0, MAX_LIST)) {
      const entry = validateHistoricalBasis(h, matchIds, tiers);
      if (entry) historicalBasis.push(entry);
    }
  }

  return {
    problemSummary,
    approach,
    steps,
    prerequisites: strList(o.prerequisites),
    missingInfo: strList(o.missingInfo),
    riskLevel,
    safetyWarnings,
    expectedOutcomes: strList(o.expectedOutcomes),
    verificationChecks: strList(o.verificationChecks),
    rollbackNotes: str(o.rollbackNotes) ?? "",
    historicalBasis,
  };
}

// ---- Persistence (Neon; additive S9 table) ----

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

const EMPTY_PAYLOAD: PlanPayload = {
  problemSummary: "",
  approach: "",
  steps: [],
  prerequisites: [],
  missingInfo: [],
  riskLevel: "low",
  safetyWarnings: [],
  expectedOutcomes: [],
  verificationChecks: [],
  rollbackNotes: "",
  historicalBasis: [],
};

function toRow(r: Record<string, unknown>): PlanRow {
  return {
    id: r.id as string,
    incident_id: r.incident_id as string,
    workspace_id: r.workspace_id as string,
    plan_version: r.plan_version as number,
    status: r.status as PlanStatus,
    brief_fingerprint: r.brief_fingerprint as string,
    brief_version: r.brief_version as number,
    payload: (r.payload ?? EMPTY_PAYLOAD) as PlanPayload,
    created_by_user_id: (r.created_by_user_id as string | null) ?? null,
    reviewed_by_user_id: (r.reviewed_by_user_id as string | null) ?? null,
    reviewed_at: (r.reviewed_at as string | null) ?? null,
    review_note: (r.review_note as string | null) ?? null,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

export type PlanStore = {
  loadActive: (incidentId: string, workspaceId: string) => Promise<PlanRow[]>;
  loadHistory: (incidentId: string, workspaceId: string) => Promise<PlanRow[]>;
  loadById: (planId: string, workspaceId: string) => Promise<PlanRow | null>;
  createDraft: (input: {
    incidentId: string;
    workspaceId: string;
    fingerprint: string;
    briefVersion: number;
    payload: PlanPayload;
    createdByUserId: string | null;
  }) => Promise<{ row: PlanRow; deduped: boolean }>;
  transition: (input: {
    planId: string;
    workspaceId: string;
    to: PlanStatus;
    actorUserId: string | null;
    note?: string | null;
  }) => Promise<PlanRow>;
  supersedeOlder: (incidentId: string, workspaceId: string, keepFingerprint: string) => Promise<number>;
};

const ALLOWED_PLAN_TRANSITIONS: Record<PlanStatus, readonly PlanStatus[]> = {
  draft: ["under_review", "rejected"],
  under_review: ["staged", "rejected"],
  staged: [],
  rejected: [],
  superseded: [],
};

export function canPlanTransition(from: PlanStatus, to: PlanStatus): boolean {
  return (ALLOWED_PLAN_TRANSITIONS[from] ?? []).includes(to);
}

export async function realPlanStore(): Promise<PlanStore> {
  const sql = await requireSql();
  const { recordEvent } = await import("./incidents");
  return {
    loadActive: async (incidentId, workspaceId) => {
      const rows = (await sql`
        select id, incident_id, workspace_id, plan_version, status,
               brief_fingerprint, brief_version, payload, created_by_user_id,
               reviewed_by_user_id, reviewed_at, review_note, created_at, updated_at
        from incident_recovery_plans
        where incident_id = ${incidentId} and workspace_id = ${workspaceId}
          and status in ('draft', 'under_review', 'staged')
        order by plan_version desc
      `) as unknown as Record<string, unknown>[];
      return rows.map(toRow);
    },
    loadHistory: async (incidentId, workspaceId) => {
      const rows = (await sql`
        select id, incident_id, workspace_id, plan_version, status,
               brief_fingerprint, brief_version, payload, created_by_user_id,
               reviewed_by_user_id, reviewed_at, review_note, created_at, updated_at
        from incident_recovery_plans
        where incident_id = ${incidentId} and workspace_id = ${workspaceId}
        order by plan_version desc limit 20
      `) as unknown as Record<string, unknown>[];
      return rows.map(toRow);
    },
    loadById: async (planId, workspaceId) => {
      const rows = (await sql`
        select id, incident_id, workspace_id, plan_version, status,
               brief_fingerprint, brief_version, payload, created_by_user_id,
               reviewed_by_user_id, reviewed_at, review_note, created_at, updated_at
        from incident_recovery_plans
        where id = ${planId} and workspace_id = ${workspaceId}
        limit 1
      `) as unknown as Record<string, unknown>[];
      return rows[0] ? toRow(rows[0]) : null;
    },
    createDraft: async (input) => {
      const next = (await sql`
        select coalesce(max(plan_version), 0) + 1 as v
        from incident_recovery_plans
        where incident_id = ${input.incidentId} and workspace_id = ${input.workspaceId}
      `) as unknown as { v: number }[];
      const version = next[0]?.v ?? 1;
      const rows = (await sql`
        insert into incident_recovery_plans
          (incident_id, workspace_id, plan_version, status, brief_fingerprint,
           brief_version, payload, created_by_user_id)
        values (${input.incidentId}, ${input.workspaceId}, ${version}, 'draft',
                ${input.fingerprint}, ${input.briefVersion}, ${JSON.stringify(input.payload)}::jsonb,
                ${input.createdByUserId})
        on conflict (incident_id, brief_fingerprint)
          where status in ('draft', 'under_review', 'staged') do nothing
        returning id, incident_id, workspace_id, plan_version, status,
                  brief_fingerprint, brief_version, payload, created_by_user_id,
                  reviewed_by_user_id, reviewed_at, review_note, created_at, updated_at
      `) as unknown as Record<string, unknown>[];
      if (rows[0]) {
        await recordEvent({
          incidentId: input.incidentId,
          kind: "plan_created",
          actorUserId: input.createdByUserId,
          detail: { planId: rows[0].id as string, version, fingerprint: input.fingerprint },
        }).catch(() => null);
        return { row: toRow(rows[0]), deduped: false };
      }
      // Lost the race (or an active plan already exists for this
      // evidence): return the winner instead of duplicating.
      const existing = (await sql`
        select id, incident_id, workspace_id, plan_version, status,
               brief_fingerprint, brief_version, payload, created_by_user_id,
               reviewed_by_user_id, reviewed_at, review_note, created_at, updated_at
        from incident_recovery_plans
        where incident_id = ${input.incidentId} and workspace_id = ${input.workspaceId}
          and brief_fingerprint = ${input.fingerprint}
          and status in ('draft', 'under_review', 'staged')
        order by plan_version desc limit 1
      `) as unknown as Record<string, unknown>[];
      if (!existing[0]) throw new Error("recovery plan persist failed");
      return { row: toRow(existing[0]), deduped: true };
    },
    transition: async (input) => {
      const current = (await sql`
        select id, status from incident_recovery_plans
        where id = ${input.planId} and workspace_id = ${input.workspaceId}
        limit 1
      `) as unknown as { id: string; status: PlanStatus }[];
      if (!current[0]) throw Object.assign(new Error("plan not found"), { status: 404 });
      const from = current[0].status;
      if (!canPlanTransition(from, input.to)) {
        throw Object.assign(new Error(`cannot move plan from ${from} to ${input.to}`), { status: 409 });
      }
      const note = input.note?.trim().slice(0, 500) || null;
      const rows = (await sql`
        update incident_recovery_plans
        set status = ${input.to}, reviewed_by_user_id = ${input.actorUserId},
            reviewed_at = now(), review_note = ${note}, updated_at = now()
        where id = ${input.planId} and workspace_id = ${input.workspaceId}
        returning id, incident_id, workspace_id, plan_version, status,
                  brief_fingerprint, brief_version, payload, created_by_user_id,
                  reviewed_by_user_id, reviewed_at, review_note, created_at, updated_at
      `) as unknown as Record<string, unknown>[];
      if (!rows[0]) throw new Error("recovery plan transition failed");
      const kind =
        input.to === "staged" ? "plan_staged" : input.to === "rejected" ? "plan_rejected" : "plan_submitted";
      await recordEvent({
        incidentId: rows[0].incident_id as string,
        kind,
        actorUserId: input.actorUserId,
        detail: { planId: input.planId, from, to: input.to, ...(note ? { note } : {}) },
      }).catch(() => null);
      return toRow(rows[0]);
    },
    supersedeOlder: async (incidentId, workspaceId, keepFingerprint) => {
      const rows = (await sql`
        update incident_recovery_plans
        set status = 'superseded', updated_at = now()
        where incident_id = ${incidentId} and workspace_id = ${workspaceId}
          and brief_fingerprint != ${keepFingerprint}
          and status in ('draft', 'under_review', 'staged')
        returning id
      `) as unknown as { id: string }[];
      if (rows.length > 0) {
        await recordEvent({
          incidentId,
          kind: "plan_superseded",
          actorUserId: null,
          detail: { count: rows.length, byFingerprint: keepFingerprint },
        }).catch(() => null);
      }
      return rows.length;
    },
  };
}

// ---- Generation + review orchestration (planning only, never execution) ----

export type PlanJudge = (input: {
  incidentTitle: string;
  incidentSeverity: string;
  observations: string[];
  identifiers: string[];
  corroborated: string[];
  unknowns: string[];
  matches: {
    refId: string;
    tier: string;
    reasons: string[];
    matchingSymptoms: string[];
    differences: string[];
    unknowns: string[];
    warning: string;
    cardStatus: string;
    cardResolved: boolean | null;
    cardExcerpt: string;
  }[];
}) => Promise<unknown>;

export type PlanDeps = {
  loadIncident: (incidentId: string, workspaceId: string) => Promise<PlanIncident | null>;
  loadBrief: (incidentId: string, workspaceId: string) => Promise<PlanBrief | null>;
  loadMatches: (incidentId: string, workspaceId: string, fingerprint: string) => Promise<PlanMatch[]>;
  store: PlanStore;
  judge: PlanJudge;
};

export type GenerateResult =
  | { action: "built"; plan: PlanRow }
  | { action: "unchanged"; plan: PlanRow }
  | { action: "insufficient"; reason: string }
  | { action: "deferred"; reason: string }
  | { action: "in_progress" }
  | { action: "failed"; error: string };

/** In-process single-flight per (incident, fingerprint). */
const generating = new Set<string>();

/**
 * Generate (or return) the draft proposal for the brief's CURRENT
 * fingerprint. Unchanged evidence returns the existing plan with zero model
 * calls; invalid or unsafe model output stores nothing; failures retain
 * existing data. Older-fingerprint proposals are superseded, never deleted.
 */
export async function generatePlanIfNeeded(
  incidentId: string,
  workspaceId: string,
  actorUserId: string | null,
  deps: PlanDeps,
): Promise<GenerateResult> {
  let incident: PlanIncident | null;
  try {
    incident = await deps.loadIncident(incidentId, workspaceId);
  } catch {
    return { action: "deferred", reason: "incident read failed" };
  }
  if (!incident) return { action: "deferred", reason: "incident not found in this workspace" };

  let brief: PlanBrief | null;
  try {
    brief = await deps.loadBrief(incidentId, workspaceId);
  } catch {
    return { action: "deferred", reason: "brief read failed" };
  }
  if (!brief) return { action: "insufficient", reason: "no evidence brief yet" };
  if (brief.status !== "current") {
    return { action: "insufficient", reason: `brief is ${brief.status}` };
  }
  const evidenceIds = briefEvidenceIds(brief);
  const hasFacts = (brief.findings.facts ?? []).length > 0;
  if (!hasFacts) {
    // Unknowns-only briefs carry no citable evidence: any proposal would
    // be invention. Truthful insufficient state instead of a plan.
    return { action: "insufficient", reason: "brief has no grounded observations yet" };
  }

  let active: PlanRow[];
  try {
    active = await deps.store.loadActive(incidentId, workspaceId);
  } catch {
    return { action: "deferred", reason: "plan read failed" };
  }
  const current = active.find((p) => p.brief_fingerprint === brief.fingerprint);
  if (current) return { action: "unchanged", plan: current };

  const lockKey = `${incidentId}:${brief.fingerprint}`;
  if (generating.has(lockKey)) return { action: "in_progress" };
  generating.add(lockKey);
  try {
    try {
      const raced = await deps.store.loadActive(incidentId, workspaceId);
      const winner = raced.find((p) => p.brief_fingerprint === (brief as PlanBrief).fingerprint);
      if (winner) return { action: "unchanged", plan: winner };
    } catch {
      return { action: "deferred", reason: "plan read failed" };
    }

    let matches: PlanMatch[];
    try {
      matches = await deps.loadMatches(incidentId, workspaceId, (brief as PlanBrief).fingerprint);
    } catch {
      return { action: "deferred", reason: "match read failed" };
    }

    const b = brief as PlanBrief;
    const matchIds = new Set(matches.map((m) => m.refId));
    const tiers = new Map(matches.map((m) => [m.refId, m.tier] as [string, string]));
    let raw: unknown;
    try {
      raw = await deps.judge({
        incidentTitle: incident.title,
        incidentSeverity: incident.severity,
        observations: (b.findings.facts ?? []).map((f) => f.observation).slice(0, 10),
        identifiers: [...new Set((b.findings.facts ?? []).flatMap((f) => f.identifiers ?? []))].slice(0, 12),
        corroborated: (b.findings.corroborated ?? []).map((c) => c.pattern).slice(0, 6),
        unknowns: b.findings.unknowns ?? [],
        matches: matches.map((m) => ({
          refId: m.refId,
          tier: m.tier,
          reasons: m.reasons.slice(0, 4),
          matchingSymptoms: m.matchingSymptoms.slice(0, 6),
          differences: m.differences.slice(0, 4),
          unknowns: m.unknowns.slice(0, 4),
          warning: m.warning,
          cardStatus: m.cardStatus,
          cardResolved: m.cardResolved,
          cardExcerpt: m.cardExcerpt.slice(0, 300),
        })),
      });
    } catch (e) {
      return { action: "failed", error: e instanceof Error ? e.message : "judge failed" };
    }
    const payload = validateRecoveryPlan(raw, evidenceIds, matchIds, tiers);
    if (!payload) {
      return { action: "failed", error: "judge returned unusable or unsafe proposal" };
    }
    try {
      const { row } = await deps.store.createDraft({
        incidentId,
        workspaceId,
        fingerprint: b.fingerprint,
        briefVersion: b.version,
        payload,
        createdByUserId: actorUserId,
      });
      await deps.store.supersedeOlder(incidentId, workspaceId, b.fingerprint).catch(() => 0);
      return { action: "built", plan: row };
    } catch {
      return { action: "deferred", reason: "plan write failed" };
    }
  } finally {
    generating.delete(lockKey);
  }
}

export type ReviewAction = "submit_for_review" | "stage" | "reject";

export type ReviewResult =
  | { action: "reviewed"; plan: PlanRow }
  | { action: "deferred"; reason: string };

const REVIEW_TARGETS: Record<ReviewAction, PlanStatus> = {
  submit_for_review: "under_review",
  stage: "staged",
  reject: "rejected",
};

/**
 * Operator review transition with actor attribution + timeline audit.
 * Staged means documented for later approval consideration — never
 * approval, never execution. No execute path exists in this module.
 */
export async function reviewPlan(
  planId: string,
  workspaceId: string,
  actorUserId: string,
  action: ReviewAction,
  note: string | null,
  deps: { store: PlanStore },
): Promise<ReviewResult> {
  try {
    const plan = await deps.store.transition({
      planId,
      workspaceId,
      to: REVIEW_TARGETS[action],
      actorUserId,
      note,
    });
    return { action: "reviewed", plan };
  } catch (e) {
    const status = (e as { status?: unknown })?.status;
    if (status === 404) return { action: "deferred", reason: "plan not found in this workspace" };
    return { action: "deferred", reason: e instanceof Error ? e.message : "review failed" };
  }
}

/**
 * Production wiring: persisted brief + S8 matches for the brief's
 * fingerprint, Neon plan store, Gemini judge. Shared by the background
 * scheduler, the explicit generate route, and the chat background refresh.
 */
export async function realPlanDeps(): Promise<PlanDeps> {
  const { geminiPlanJudge } = await import("./recovery-plans-gemini");
  const store = await realPlanStore();
  return {
    loadIncident: async (incidentId, workspaceId) => {
      const { getIncidentForWorkspace } = await import("./incidents");
      const row = await getIncidentForWorkspace(workspaceId, incidentId);
      return row ? { id: row.id, title: row.title, status: row.status, severity: row.severity } : null;
    },
    loadBrief: async (incidentId, workspaceId) => {
      const { getIncidentBrief } = await import("./evidence-brief");
      const row = await getIncidentBrief(incidentId, workspaceId);
      return row
        ? {
            status: row.status,
            version: row.version,
            fingerprint: row.fingerprint,
            findings: row.findings,
            source_count: row.source_count,
            generated_at: row.generated_at,
          }
        : null;
    },
    loadMatches: async (incidentId, workspaceId, fingerprint) => {
      const { realMatchStore } = await import("./fix-matches");
      const matchStore = await realMatchStore();
      const rows = await matchStore.loadForBrief(incidentId, workspaceId, fingerprint);
      return rows.map((r) => ({
        refId: r.ref_id,
        tier: r.tier,
        reasons: r.payload.reasons ?? [],
        matchingSymptoms: r.payload.matchingSymptoms ?? [],
        differences: r.payload.differences ?? [],
        unknowns: r.payload.unknowns ?? [],
        applicable: r.payload.applicable,
        warning: r.payload.warning ?? "",
        cardStatus: r.payload.cardStatus ?? "",
        cardResolved: r.payload.cardResolved ?? null,
        cardExcerpt: r.payload.cardExcerpt ?? "",
      }));
    },
    store,
    judge: geminiPlanJudge(),
  };
}

/**
 * Fire-and-forget draft preparation for route handlers. Must be called
 * synchronously inside request scope; no-ops in tests or when after() is
 * unavailable. Never throws into the caller. Drafting never implies
 * approval — drafts are reviewable proposals only.
 */
export function schedulePlanDraft(incidentId: string, workspaceId: string): void {
  try {
    after(async () => {
      try {
        const { isGeminiConfigured } = await import("./env");
        if (!isGeminiConfigured()) return;
        await generatePlanIfNeeded(incidentId, workspaceId, null, await realPlanDeps());
      } catch {
        // Background intelligence must never break the operator action.
      }
    });
  } catch {
    // No request scope (tests, dev snippets): skip silently.
  }
}
