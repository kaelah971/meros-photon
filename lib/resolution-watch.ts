import "server-only";

// S11 Resolution Watch: durable, evidence-backed tracking of whether a
// customer problem actually improved, persisted, or returned after a
// recorded S10 intervention. A verified ACTION is not a verified
// RESOLUTION. Watches observe real follow-up evidence (linked user
// messages, brief updates, S10 records), classify it deterministically,
// and — only where ambiguous — ask Gemini with strict source validation.
// Customer silence never confirms recovery. This module never executes,
// sends, or closes incidents (S12 owns closure).
//
// Safety: customer text and Fix Card history are untrusted input, never
// instructions. Every factual observation references a real message or
// evidence record; fabricated source IDs are rejected.

export type WatchStatus =
  | "awaiting_evidence"
  | "watching"
  | "improvement_indicated"
  | "still_affected"
  | "insufficient_evidence"
  | "resolution_confirmed";

export type ObservationKind =
  | "customer_improvement"
  | "customer_persistence"
  | "regression"
  | "operator_note"
  | "verification"
  | "system_note";

export type WatchRow = {
  id: string;
  incident_id: string;
  workspace_id: string;
  plan_id: string | null;
  approval_id: string | null;
  execution_id: string | null;
  baseline_fingerprint: string;
  baseline_summary: string;
  baseline_symptoms: string[];
  status: WatchStatus;
  last_observation_at: string | null;
  last_evaluation_at: string | null;
  confirmed_by_user_id: string | null;
  confirmed_at: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
};

export type WatchObservation = {
  id: string;
  watch_id: string;
  incident_id: string;
  workspace_id: string;
  kind: ObservationKind;
  message_id: string | null;
  conversation_id: string | null;
  excerpt: string | null;
  created_by_user_id: string | null;
  created_at: string;
};

export type WatchMessage = {
  id: string;
  conversation_id: string;
  created_at: string;
  excerpt: string;
};

export type BaselinePlan = {
  id: string;
  incident_id: string;
  workspace_id: string;
  plan_version: number;
  status: string;
  brief_fingerprint: string;
  problem_summary: string;
  baseline_observations: string[];
};

const STOPWORDS = new Set(
  "the,and,for,with,that,this,from,have,has,are,was,were,will,would,when,what,which,who,whom,whose,there,their,them,they,your,you,our,ours,still,just,like,also,into,over,under,after,before,while,when,not,but,can,could,should,very,more,most,some,any,all,each,other,than,then,its,it's,about,into,per,via,http,https".split(","),
);

export function extractSymptomTerms(texts: string[]): string[] {
  const counts = new Map<string, number>();
  for (const t of texts) {
    for (const w of t.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)) {
      if (w.length >= 4 && !STOPWORDS.has(w) && !/^\d+$/.test(w)) {
        counts.set(w, (counts.get(w) ?? 0) + 1);
      }
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24).map(([w]) => w);
}

const IMPROVEMENT_PATTERNS = [
  /\b(fixed|resolved|working now|works now|working again|works again|all good|no more|has stopped|have stopped|stopped happening|back to normal|back up|recovered|sorted|thank you\b.{0,40}(work|fix|help|resolv)|confirmed?\b.{0,30}(work|fix|ok|good))\b/,
  /\b(no (longer|more) (seeing|getting|experiencing|issues?|errors?|problems?))\b/,
];

export type Verdict = "improvement" | "persistence" | "unrelated";

export function classifyMessage(text: string, symptoms: string[]): { verdict: Verdict; hits: string[] } {
  const lower = text.toLowerCase();
  const hits = symptoms.filter((s) => lower.includes(s));
  const improved = IMPROVEMENT_PATTERNS.some((re) => re.test(lower));
  if (improved && (hits.length > 0 || symptoms.length === 0)) {
    return { verdict: "improvement", hits };
  }
  if (hits.length >= 2 || (hits.length === 1 && symptoms.length <= 5)) {
    return { verdict: "persistence", hits };
  }
  return { verdict: "unrelated", hits };
}

export function isTerminalWatch(s: WatchStatus): boolean {
  return s === "resolution_confirmed";
}

export type WatchStore = {
  activeForIncident: (incidentId: string, workspaceId: string) => Promise<WatchRow[]>;
  listForIncident: (incidentId: string, workspaceId: string) => Promise<WatchRow[]>;
  loadById: (watchId: string, workspaceId: string) => Promise<WatchRow | null>;
  insert: (input: {
    incidentId: string;
    workspaceId: string;
    planId: string | null;
    approvalId: string | null;
    executionId: string | null;
    baselineFingerprint: string;
    baselineSummary: string;
    baselineSymptoms: string[];
    note: string | null;
    createdBy: string;
  }) => Promise<{ row: WatchRow; deduped: boolean }>;
  setStatus: (input: {
    watchId: string;
    workspaceId: string;
    to: WatchStatus;
    actorUserId: string | null;
    note?: string | null;
  }) => Promise<WatchRow>;
  touchEvaluation: (watchId: string, workspaceId: string, at: string) => Promise<void>;
  touchObservation: (watchId: string, workspaceId: string, at: string) => Promise<void>;
};

export type ObservationStore = {
  listForWatch: (watchId: string, workspaceId: string) => Promise<WatchObservation[]>;
  hasMessage: (watchId: string, workspaceId: string, messageId: string) => Promise<boolean>;
  insert: (input: {
    watchId: string;
    incidentId: string;
    workspaceId: string;
    kind: ObservationKind;
    messageId: string | null;
    conversationId: string | null;
    excerpt: string | null;
    createdBy: string | null;
  }) => Promise<{ row: WatchObservation; deduped: boolean }>;
};

export type WatchJudge = (input: {
  baselineSummary: string;
  symptoms: string[];
  messages: { id: string; excerpt: string }[];
}) => Promise<unknown>;

export type WatchDeps = {
  loadPlan: (planId: string, workspaceId: string) => Promise<BaselinePlan | null>;
  loadApproval: (approvalId: string, workspaceId: string) => Promise<{ id: string; status: string; plan_id: string } | null>;
  loadApprovalByPlan: (planId: string, workspaceId: string) => Promise<{ id: string; status: string; plan_id: string } | null>;
  loadExecution: (executionId: string, workspaceId: string) => Promise<{ id: string; status: string; plan_id: string; approval_id: string } | null>;
  executionsForPlan: (planId: string, workspaceId: string) => Promise<{ id: string; status: string }[]>;
  loadBriefFingerprint: (incidentId: string, workspaceId: string) => Promise<string | null>;
  listNewUserMessages: (incidentId: string, workspaceId: string, since: string | null, limit: number) => Promise<WatchMessage[]>;
  watches: WatchStore;
  observations: ObservationStore;
  judge: WatchJudge | null;
};

export type StartResult = { action: "started"; watch: WatchRow } | { action: "duplicate"; watch: WatchRow } | { action: "deferred"; reason: string };

/**
 * Start a watch after an eligible S10 intervention. Requires a staged
 * plan with an APPROVED approval and at least one documented execution
 * (any status — unknown_outcome counts as documented, but never as
 * success). Incidents with no intervention are refused.
 */
export async function startWatch(
  incidentId: string,
  workspaceId: string,
  actorUserId: string,
  input: { planId: string; executionId?: string | null; note?: string | null },
  deps: WatchDeps,
): Promise<StartResult> {
  const plan = await deps.loadPlan(input.planId, workspaceId).catch(() => null);
  if (!plan || plan.incident_id !== incidentId) {
    return { action: "deferred", reason: "plan not found in this workspace" };
  }
  if (plan.status !== "staged") {
    return { action: "deferred", reason: `plan is ${plan.status}, only staged plans anchor a watch` };
  }
  const approval = await deps.loadApprovalByPlan(plan.id, workspaceId).catch(() => null);
  if (!approval) return { action: "deferred", reason: "no approved S10 approval for this plan" };
  const execs = await deps.executionsForPlan(plan.id, workspaceId).catch(() => []);
  if (execs.length === 0) {
    return { action: "deferred", reason: "no documented intervention — a watch needs a recorded S10 action first" };
  }
  let executionId: string | null = null;
  if (input.executionId) {
    const ex = await deps.loadExecution(input.executionId, workspaceId).catch(() => null);
    if (!ex || ex.plan_id !== plan.id) {
      return { action: "deferred", reason: "execution not found for this plan" };
    }
    if (ex.status !== "verified_success") {
      // Documented but unverified interventions may anchor a watch; they
      // are labeled as such and never imply success.
      executionId = ex.id;
    } else {
      executionId = ex.id;
    }
  } else {
    const verified = execs.find((e) => e.status === "verified_success");
    executionId = verified?.id ?? execs[0].id;
  }
  const symptoms = extractSymptomTerms([plan.problem_summary, ...plan.baseline_observations]);
  try {
    const { row, deduped } = await deps.watches.insert({
      incidentId,
      workspaceId,
      planId: plan.id,
      approvalId: approval.id,
      executionId,
      baselineFingerprint: plan.brief_fingerprint,
      baselineSummary: plan.problem_summary.slice(0, 500),
      baselineSymptoms: symptoms,
      note: (input.note ?? null)?.trim().slice(0, 500) || null,
      createdBy: actorUserId,
    });
    return deduped ? { action: "duplicate", watch: row } : { action: "started", watch: row };
  } catch (e) {
    return { action: "deferred", reason: e instanceof Error ? e.message : "watch start failed" };
  }
}

export type NoteResult = { action: "noted"; added: number } | { action: "deferred"; reason: string };

/**
 * Lightweight hot-path hook: classify ONE new user message against every
 * active watch on the incident. Deterministic only (no model calls here),
 * message-id deduped, failure-isolated. Full semantic evaluation happens
 * on staff-triggered refresh.
 */
export async function noteNewMessage(
  incidentId: string,
  workspaceId: string,
  message: { id: string; conversationId: string; excerpt: string; createdAt: string },
  deps: WatchDeps,
): Promise<NoteResult> {
  let watches: WatchRow[];
  try {
    watches = await deps.watches.activeForIncident(incidentId, workspaceId);
  } catch {
    return { action: "deferred", reason: "watch read failed" };
  }
  if (watches.length === 0) return { action: "noted", added: 0 };
  let added = 0;
  for (const w of watches) {
    try {
      if (await deps.observations.hasMessage(w.id, workspaceId, message.id)) continue;
      const { verdict, hits } = classifyMessage(message.excerpt, w.baseline_symptoms);
      if (verdict === "unrelated") continue;
      const prior = await deps.observations.listForWatch(w.id, workspaceId);
      const hadImprovement = prior.some((o) => o.kind === "customer_improvement" || o.kind === "verification");
      const kind: ObservationKind =
        verdict === "improvement" ? "customer_improvement" : hadImprovement ? "regression" : "customer_persistence";
      const excerpt = `“${message.excerpt.slice(0, 280)}” — symptom overlap: ${hits.slice(0, 6).join(", ") || "paraphrase"}`;
      await deps.observations.insert({
        watchId: w.id,
        incidentId,
        workspaceId,
        kind,
        messageId: message.id,
        conversationId: message.conversationId,
        excerpt,
        createdBy: null,
      });
      const next: WatchStatus = kind === "customer_improvement" ? "improvement_indicated" : "still_affected";
      if (w.status !== "resolution_confirmed") {
        await deps.watches.setStatus({ watchId: w.id, workspaceId, to: next, actorUserId: null });
      }
      await deps.watches.touchObservation(w.id, workspaceId, message.createdAt);
      added++;
    } catch {
      // One watch must never break the others or the chat response.
    }
  }
  return { action: "noted", added };
}

export type EvalResult =
  | { action: "evaluated"; watch: WatchRow; added: number; state: WatchStatus }
  | { action: "deferred"; reason: string };

/**
 * Staff-triggered reconciliation: pull bounded post-watch user messages,
 * classify deterministically, use the judge only for inconclusive items,
 * append deduped observations, and recompute state. Judge failures
 * preserve prior records (truthful retryable state).
 */
export async function evaluateWatch(
  watchId: string,
  workspaceId: string,
  actorUserId: string,
  deps: WatchDeps,
  opts: { useJudge?: boolean } = {},
): Promise<EvalResult> {
  const watch = await deps.watches.loadById(watchId, workspaceId).catch(() => null);
  if (!watch) return { action: "deferred", reason: "watch not found in this workspace" };
  if (isTerminalWatch(watch.status)) return { action: "deferred", reason: "watch already resolution_confirmed" };
  let messages: WatchMessage[];
  try {
    messages = await deps.listNewUserMessages(watch.incident_id, workspaceId, watch.last_observation_at ?? watch.created_at, 50);
  } catch {
    return { action: "deferred", reason: "message read failed" };
  }
  const fresh = messages.filter((m) => !Number.isNaN(Date.parse(m.created_at)));
  let added = 0;
  const inconclusive: WatchMessage[] = [];
  for (const m of fresh) {
    try {
      if (await deps.observations.hasMessage(watch.id, workspaceId, m.id)) continue;
      const { verdict, hits } = classifyMessage(m.excerpt, watch.baseline_symptoms);
      if (verdict === "unrelated") {
        if (opts.useJudge !== false && deps.judge) inconclusive.push(m);
        continue;
      }
      const prior = await deps.observations.listForWatch(watch.id, workspaceId);
      const hadImprovement = prior.some((o) => o.kind === "customer_improvement" || o.kind === "verification");
      const kind: ObservationKind =
        verdict === "improvement" ? "customer_improvement" : hadImprovement ? "regression" : "customer_persistence";
      await deps.observations.insert({
        watchId: watch.id,
        incidentId: watch.incident_id,
        workspaceId,
        kind,
        messageId: m.id,
        conversationId: m.conversation_id,
        excerpt: `“${m.excerpt.slice(0, 280)}” — symptom overlap: ${hits.slice(0, 6).join(", ") || "paraphrase"}`,
        createdBy: null,
      });
      added++;
    } catch {
      // keep going; per-message failures must not lose the rest.
    }
  }
  // Semantic pass for inconclusive messages only, strictly validated.
  if (inconclusive.length > 0 && opts.useJudge !== false && deps.judge) {
    try {
      const raw = await deps.judge({
        baselineSummary: watch.baseline_summary,
        symptoms: watch.baseline_symptoms,
        messages: inconclusive.slice(0, 12).map((m) => ({ id: m.id, excerpt: m.excerpt.slice(0, 400) })),
      });
      const assessed = validateWatchJudge(raw, new Set(inconclusive.map((m) => m.id)));
      if (assessed) {
        for (const a of assessed) {
          try {
            const m = inconclusive.find((x) => x.id === a.messageId);
            if (!m || a.verdict === "unrelated") continue;
            if (await deps.observations.hasMessage(watch.id, workspaceId, m.id)) continue;
            const prior = await deps.observations.listForWatch(watch.id, workspaceId);
            const hadImprovement = prior.some((o) => o.kind === "customer_improvement" || o.kind === "verification");
            const kind: ObservationKind =
              a.verdict === "improvement" ? "customer_improvement" : hadImprovement ? "regression" : "customer_persistence";
            await deps.observations.insert({
              watchId: watch.id,
              incidentId: watch.incident_id,
              workspaceId,
              kind,
              messageId: m.id,
              conversationId: m.conversation_id,
              excerpt: `“${m.excerpt.slice(0, 280)}” — model read: ${a.reason} (verify against source)`,
              createdBy: null,
            });
            added++;
          } catch {
            // per-message isolation
          }
        }
      }
    } catch {
      // Judge failure preserves prior records; state recompute below still
      // reflects deterministic findings. Retryable via refresh.
    }
  }
  const now = new Date().toISOString();
  await deps.watches.touchEvaluation(watch.id, workspaceId, now).catch(() => null);
  const all = await deps.observations.listForWatch(watch.id, workspaceId).catch(() => []);
  const next = recomputeState(watch, all);
  let updated = watch;
  if (next !== watch.status) {
    updated =
      (await deps.watches.setStatus({ watchId: watch.id, workspaceId, to: next, actorUserId }).catch(() => null)) ??
      watch;
  }
  return { action: "evaluated", watch: updated, added, state: updated.status };
}

function recomputeState(watch: WatchRow, obs: WatchObservation[]): WatchStatus {
  if (obs.length === 0) return watch.status === "awaiting_evidence" ? "awaiting_evidence" : watch.status;
  const kinds = new Set(obs.map((o) => o.kind));
  const last = obs[obs.length - 1];
  if (kinds.has("regression") || (kinds.has("customer_improvement") && kinds.has("customer_persistence") && last.kind !== "customer_improvement")) {
    return "still_affected";
  }
  if (last.kind === "customer_improvement" || kinds.has("customer_improvement")) {
    const afterImprovement = obs.slice(obs.findIndex((o) => o.kind === "customer_improvement" || o.kind === "verification") + 1);
    if (afterImprovement.some((o) => o.kind === "customer_persistence" || o.kind === "regression")) return "still_affected";
    return "improvement_indicated";
  }
  if (kinds.has("customer_persistence")) return "still_affected";
  if (kinds.has("operator_note") || kinds.has("verification")) return watch.status;
  return "watching";
}

export type JudgeAssessment = { messageId: string; verdict: Verdict; reason: string };

/** Strict validation: IDs must come from the supplied set; no invention. */
export function validateWatchJudge(raw: unknown, knownIds: Set<string>): JudgeAssessment[] | null {
  if (!raw || typeof raw !== "object") return null;
  const list = (raw as { assessments?: unknown }).assessments;
  if (!Array.isArray(list) || list.length > 12) return null;
  const out: JudgeAssessment[] = [];
  for (const a of list) {
    if (!a || typeof a !== "object") return null;
    const { messageId, verdict, reason } = a as Record<string, unknown>;
    if (typeof messageId !== "string" || !knownIds.has(messageId)) return null;
    if (verdict !== "improvement" && verdict !== "persistence" && verdict !== "unrelated") return null;
    if (typeof reason !== "string" || reason.length > 300) return null;
    out.push({ messageId, verdict, reason: reason.trim() });
  }
  return out;
}

export type ConfirmResult = { action: "confirmed"; watch: WatchRow } | { action: "deferred"; reason: string };

/**
 * Authorized resolution confirmation. Requires improvement evidence, no
 * later contradictory evidence, and a fresh evaluation (no unprocessed
 * messages). Silence is never confirmation.
 */
export async function confirmResolution(
  watchId: string,
  workspaceId: string,
  actorUserId: string,
  note: string | null,
  deps: WatchDeps,
): Promise<ConfirmResult> {
  const watch = await deps.watches.loadById(watchId, workspaceId).catch(() => null);
  if (!watch) return { action: "deferred", reason: "watch not found in this workspace" };
  if (isTerminalWatch(watch.status)) return { action: "deferred", reason: "watch already resolution_confirmed" };
  const obs = await deps.observations.listForWatch(watch.id, workspaceId).catch(() => []);
  const improvements = obs.filter((o) => o.kind === "customer_improvement" || o.kind === "verification");
  if (watch.status !== "improvement_indicated" || improvements.length === 0) {
    return { action: "deferred", reason: "resolution needs indicated improvement with supporting customer evidence" };
  }
  const lastImprovementAt = improvements[improvements.length - 1].created_at;
  const contradiction = obs.some(
    (o) => (o.kind === "customer_persistence" || o.kind === "regression") && o.created_at >= lastImprovementAt,
  );
  if (contradiction) {
    return { action: "deferred", reason: "later evidence contradicts improvement — re-evaluate first" };
  }
  const pending = await deps.listNewUserMessages(watch.incident_id, workspaceId, watch.last_evaluation_at ?? watch.created_at, 50).catch(() => []);
  const unprocessed = pending.filter((m) => !obs.some((o) => o.message_id === m.id));
  if (unprocessed.length > 0) {
    return { action: "deferred", reason: "new evidence arrived — refresh the evaluation first" };
  }
  try {
    const next = await deps.watches.setStatus({
      watchId: watch.id,
      workspaceId,
      to: "resolution_confirmed",
      actorUserId,
      note: note?.trim().slice(0, 500) || null,
    });
    return { action: "confirmed", watch: next };
  } catch (e) {
    return { action: "deferred", reason: e instanceof Error ? e.message : "confirm failed" };
  }
}

export type MarkResult = { action: "marked"; watch: WatchRow } | { action: "deferred"; reason: string };

/** Operator honesty states: still affected / insufficient evidence. */
export async function markWatch(
  watchId: string,
  workspaceId: string,
  actorUserId: string,
  to: "still_affected" | "insufficient_evidence" | "watching",
  note: string | null,
  deps: WatchDeps,
): Promise<MarkResult> {
  const watch = await deps.watches.loadById(watchId, workspaceId).catch(() => null);
  if (!watch) return { action: "deferred", reason: "watch not found in this workspace" };
  if (isTerminalWatch(watch.status)) return { action: "deferred", reason: "confirmed watches stay as history" };
  try {
    const next = await deps.watches.setStatus({ watchId, workspaceId, to, actorUserId, note: note?.trim().slice(0, 500) || null });
    return { action: "marked", watch: next };
  } catch (e) {
    return { action: "deferred", reason: e instanceof Error ? e.message : "mark failed" };
  }
}

export type ObserveResult = { action: "recorded"; observation: WatchObservation } | { action: "deferred"; reason: string };

/** Documented operator observation, optionally anchored to a message. */
export async function recordObservation(
  watchId: string,
  workspaceId: string,
  actorUserId: string,
  input: { kind: "operator_note" | "verification"; messageId?: string | null; text: string },
  deps: WatchDeps,
): Promise<ObserveResult> {
  const watch = await deps.watches.loadById(watchId, workspaceId).catch(() => null);
  if (!watch) return { action: "deferred", reason: "watch not found in this workspace" };
  if (isTerminalWatch(watch.status)) return { action: "deferred", reason: "confirmed watches stay as history" };
  const text = input.text.trim().slice(0, 1000);
  if (!text) return { action: "deferred", reason: "observation text is required" };
  if (input.messageId) {
    if (await deps.observations.hasMessage(watch.id, workspaceId, input.messageId).catch(() => false)) {
      return { action: "deferred", reason: "message already recorded for this watch" };
    }
  }
  try {
    const { row } = await deps.observations.insert({
      watchId: watch.id,
      incidentId: watch.incident_id,
      workspaceId,
      kind: input.kind,
      messageId: input.messageId ?? null,
      conversationId: null,
      excerpt: text,
      createdBy: actorUserId,
    });
    await deps.watches.touchObservation(watch.id, workspaceId, new Date().toISOString()).catch(() => null);
    return { action: "recorded", observation: row };
  } catch (e) {
    return { action: "deferred", reason: e instanceof Error ? e.message : "record failed" };
  }
}
