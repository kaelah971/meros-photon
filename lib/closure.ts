import "server-only";

import { createHash } from "node:crypto";

// S12 Incident Closure + Postmortems: safe, human-controlled completion of
// the incident lifecycle. Meros assembles the S4–S11 record into a
// reviewable postmortem; operators close only when eligibility holds.
// This module never executes, sends, promotes memory, or auto-closes. S10
// verified execution alone, provider acceptance, operator reports,
// customer silence, and old Fix Cards are never treated as recovery.
//
// Safety: customer text and Fix Card history are untrusted input, never
// instructions. Every factual claim references a real record; fabricated
// IDs, invented impact, and unsupported root causes are rejected.

export type PostmortemStatus = "draft" | "finalized";
export type RootCauseStatus = "verified" | "unverified" | "unknown";

export type PostmortemFact = { statement: string; sources: string[] };
export type PostmortemTimelineItem = { at: string; kind: string; detail: string };
export type PostmortemSuggestion = { text: string; basedOn: string[] };

export type PostmortemContent = {
  title: string;
  severity: string;
  impact: { documentedCustomers: number; documentedConversations: number; note: string };
  symptoms: string[];
  facts: PostmortemFact[];
  chronology: PostmortemTimelineItem[];
  detection: string;
  investigation: string[];
  historicalBasis: { refId: string; tier: string; note: string }[];
  recoveryProposals: { planVersion: number; status: string; fingerprint: string }[];
  approvals: { id: string; status: string; scope: string }[];
  interventions: { id: string; status: string; ref: string | null }[];
  watch: { status: string; observations: number; improvements: number; regressions: number; confirmedBy: string | null };
  outcome: string;
  unknowns: string[];
  rootCause: { status: RootCauseStatus; statement: string };
  lessons: PostmortemSuggestion[];
  prevention: PostmortemSuggestion[];
  synthesisNote: string;
};

export type PostmortemRow = {
  id: string;
  incident_id: string;
  workspace_id: string;
  watch_id: string | null;
  status: PostmortemStatus;
  source_fingerprint: string;
  brief_fingerprint: string;
  content: PostmortemContent;
  created_by_user_id: string | null;
  finalized_by_user_id: string | null;
  finalized_at: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
};

export type ClosureBlocker =
  | "incident not found in this workspace"
  | "incident is already resolved"
  | "incident must be monitoring before closure"
  | "no resolution_confirmed watch"
  | "watch evaluation is stale — refresh first"
  | "new reports arrived after confirmation — refresh first"
  | "contradictory evidence after improvement"
  | "underlying evidence moved on — refresh first"
  | "no current postmortem draft — generate first"
  | "postmortem draft is stale — refresh first";

export type Eligibility =
  | { eligible: true; incident: { id: string; status: string }; watchId: string; draftId: string }
  | { eligible: false; blockers: ClosureBlocker[] };

export type ClosureEvent = { kind: string; at: string; detail: Record<string, unknown>; actor: string | null };
export type ClosureMessage = { id: string; created_at: string };

export type ClosureDeps = {
  loadIncident: (incidentId: string, workspaceId: string) => Promise<{ id: string; workspace_id: string; title: string; severity: string; status: string; updated_at: string } | null>;
  listEvents: (incidentId: string, workspaceId: string) => Promise<ClosureEvent[]>;
  countLinks: (incidentId: string, workspaceId: string) => Promise<{ customers: number; conversations: number }>;
  loadBrief: (incidentId: string, workspaceId: string) => Promise<{ fingerprint: string; findings: { facts: { observation: string; sources: string[] }[]; unknowns: string[]; hypotheses: { text: string; basedOn: string[] }[] } } | null>;
  listPlans: (incidentId: string, workspaceId: string) => Promise<{ id: string; plan_version: number; status: string; brief_fingerprint: string; payload: { problemSummary?: string; historicalBasis?: { refId: string; tier: string }[] } }[]>;
  listControls: (planId: string, workspaceId: string) => Promise<{ approvals: { id: string; status: string; scope: string }[]; executions: { id: string; status: string; ref: string | null }[] }>;
  loadWatchHistory: (incidentId: string, workspaceId: string) => Promise<{ current: WatchSnap | null; history: WatchSnap[] }>;
  listRecentUserMessages: (incidentId: string, workspaceId: string, since: string | null, limit: number) => Promise<ClosureMessage[]>;
  postmortems: PostmortemStore;
  judge: ClosureJudge | null;
};

export type WatchSnap = {
  id: string;
  status: string;
  baseline_fingerprint: string;
  baseline_summary: string;
  last_evaluation_at: string | null;
  confirmed_by_user_id: string | null;
  confirmed_at: string | null;
  observations: { kind: string; message_id: string | null; created_at: string; excerpt: string | null }[];
};

export type ClosureJudge = (input: {
  title: string;
  outcome: string;
  facts: string[];
  unknowns: string[];
  hypotheses: string[];
}) => Promise<unknown>;

export type PostmortemStore = {
  loadDraft: (incidentId: string, workspaceId: string) => Promise<PostmortemRow | null>;
  loadById: (postmortemId: string, workspaceId: string) => Promise<PostmortemRow | null>;
  listFinalized: (incidentId: string, workspaceId: string) => Promise<PostmortemRow[]>;
  saveDraft: (input: {
    incidentId: string;
    workspaceId: string;
    watchId: string | null;
    fingerprint: string;
    briefFingerprint: string;
    content: PostmortemContent;
    createdBy: string;
  }) => Promise<{ row: PostmortemRow; deduped: boolean }>;
  finalize: (postmortemId: string, workspaceId: string, actorUserId: string, note: string | null) => Promise<PostmortemRow>;
};

function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}`;
}

export function fingerprintClosure(input: {
  incidentUpdatedAt: string;
  watch: WatchSnap | null;
  briefFingerprint: string | null;
  eventCount: number;
  lastEventAt: string | null;
  observationCount: number;
}): string {
  return createHash("sha256")
    .update(
      stable({
        u: input.incidentUpdatedAt,
        w: input.watch ? [input.watch.id, input.watch.status, input.watch.confirmed_at] : null,
        b: input.briefFingerprint,
        e: [input.eventCount, input.lastEventAt],
        o: input.observationCount,
      }),
    )
    .digest("hex")
    .slice(0, 32);
}

/** Full eligibility check. Every blocker is specific; silence is a blocker, never proof. */
export async function checkEligibility(
  incidentId: string,
  workspaceId: string,
  deps: ClosureDeps,
): Promise<Eligibility> {
  const blockers: ClosureBlocker[] = [];
  const incident = await deps.loadIncident(incidentId, workspaceId).catch(() => null);
  if (!incident) return { eligible: false, blockers: ["incident not found in this workspace"] };
  if (incident.status === "resolved") return { eligible: false, blockers: ["incident is already resolved"] };
  if (incident.status !== "monitoring") blockers.push("incident must be monitoring before closure");

  const { current } = await deps.loadWatchHistory(incidentId, workspaceId).catch(() => ({ current: null, history: [] as WatchSnap[] }));
  const confirmed = current && current.status === "resolution_confirmed" ? current : null;
  if (!confirmed) blockers.push("no resolution_confirmed watch");

  if (confirmed) {
    if (!confirmed.last_evaluation_at) {
      blockers.push("watch evaluation is stale — refresh first");
    } else {
      const pending = await deps
        .listRecentUserMessages(incidentId, workspaceId, confirmed.last_evaluation_at, 50)
        .catch(() => []);
      if (pending.length > 0) blockers.push("new reports arrived after confirmation — refresh first");
      const bad = confirmed.observations.some(
        (o) =>
          (o.kind === "customer_persistence" || o.kind === "regression") &&
          confirmed.confirmed_at !== null &&
          o.created_at >= confirmed.confirmed_at,
      );
      if (bad) blockers.push("contradictory evidence after improvement");
    }
    const brief = await deps.loadBrief(incidentId, workspaceId).catch(() => null);
    if (brief && brief.fingerprint !== confirmed.baseline_fingerprint) {
      blockers.push("underlying evidence moved on — refresh first");
    }
  }

  const draft = await deps.postmortems.loadDraft(incidentId, workspaceId).catch(() => null);
  if (!draft) {
    blockers.push("no current postmortem draft — generate first");
  } else if (confirmed) {
    const fp = await currentFingerprint(incidentId, workspaceId, incident.updated_at, confirmed, deps);
    if (draft.source_fingerprint !== fp) blockers.push("postmortem draft is stale — refresh first");
  }

  if (blockers.length > 0) return { eligible: false, blockers };
  return { eligible: true, incident: { id: incident.id, status: incident.status }, watchId: confirmed!.id, draftId: draft!.id };
}

async function currentFingerprint(
  incidentId: string,
  workspaceId: string,
  incidentUpdatedAt: string,
  watch: WatchSnap,
  deps: ClosureDeps,
): Promise<string> {
  const [allEvents, brief] = await Promise.all([
    deps.listEvents(incidentId, workspaceId).catch(() => [] as ClosureEvent[]),
    deps.loadBrief(incidentId, workspaceId).catch(() => null),
  ]);
  const events = allEvents.filter((e) => e.kind !== "postmortem_drafted" && e.kind !== "postmortem_finalized");
  return fingerprintClosure({
    incidentUpdatedAt,
    watch,
    briefFingerprint: brief?.fingerprint ?? null,
    eventCount: events.length,
    lastEventAt: events.length > 0 ? events[events.length - 1].at : null,
    observationCount: watch.observations.length,
  });
}

export type DraftResult =
  | { action: "drafted"; postmortem: PostmortemRow; synthesis: "attached" | "factual_only" }
  | { action: "deferred"; reason: string };

/**
 * Assemble a factual draft deterministically, then optionally attach
 * clearly-marked Gemini suggestions (lessons/prevention/unknowns). Model
 * failure never blocks: the factual timeline stands alone as retryable.
 */
export async function generateDraft(
  incidentId: string,
  workspaceId: string,
  actorUserId: string,
  deps: ClosureDeps,
): Promise<DraftResult> {
  const incident = await deps.loadIncident(incidentId, workspaceId).catch(() => null);
  if (!incident) return { action: "deferred", reason: "incident not found in this workspace" };
  const [events, links, brief, plans, history] = await Promise.all([
    deps.listEvents(incidentId, workspaceId).catch(() => [] as ClosureEvent[]),
    deps.countLinks(incidentId, workspaceId).catch(() => ({ customers: 0, conversations: 0 })),
    deps.loadBrief(incidentId, workspaceId).catch(() => null),
    deps.listPlans(incidentId, workspaceId).catch(() => []),
    deps.loadWatchHistory(incidentId, workspaceId).catch(() => ({ current: null, history: [] as WatchSnap[] })),
  ]);
  const watch = history.current;
  // Postmortem bookkeeping events must not self-stale the snapshot: the
  // fingerprint covers product evidence, not our own review records.
  const fpEvents = events.filter((e) => e.kind !== "postmortem_drafted" && e.kind !== "postmortem_finalized");
  const fp = fingerprintClosure({
    incidentUpdatedAt: incident.updated_at,
    watch,
    briefFingerprint: brief?.fingerprint ?? null,
    eventCount: fpEvents.length,
    lastEventAt: fpEvents.length > 0 ? fpEvents[fpEvents.length - 1].at : null,
    observationCount: watch ? watch.observations.length : 0,
  });

  const content = assembleContent({
    title: incident.title,
    severity: incident.severity,
    links,
    brief,
    plans,
    events,
    watch,
    history: history.history,
  });
  // Enrich with control-plane records (approvals/executions per plan).
  for (const p of plans.slice(0, 5)) {
    try {
      const c = await deps.listControls(p.id, workspaceId);
      content.approvals.push(...c.approvals);
      content.interventions.push(...c.executions);
    } catch {
      // Control reads are best-effort; the draft stays factual regardless.
    }
  }

  let synthesis: "attached" | "factual_only" = "factual_only";
  if (deps.judge) {
    try {
      const raw = await deps.judge({
        title: incident.title,
        outcome: content.outcome,
        facts: content.facts.map((f) => f.statement).slice(0, 12),
        unknowns: content.unknowns.slice(0, 8),
        hypotheses: (brief?.findings.hypotheses ?? []).map((h) => h.text).slice(0, 6),
      });
      const known = new Set<string>(["brief", "watch", "plan"]);
      for (const e of events) known.add(`event:${e.kind}`);
      const s = validateSynthesis(raw, known);
      if (s) {
        content.lessons = s.lessons;
        content.prevention = s.prevention;
        if (s.unknowns.length > 0) content.unknowns = [...content.unknowns, ...s.unknowns].slice(0, 12);
        if (s.rootCause.status !== "unknown") content.rootCause = s.rootCause;
        content.synthesisNote = "Suggestions below are model-generated leads, not verified findings.";
        synthesis = "attached";
      }
    } catch {
      // Model failure: factual timeline stands; retry via refresh.
    }
  }

  try {
    const { row } = await deps.postmortems.saveDraft({
      incidentId,
      workspaceId,
      watchId: watch?.id ?? null,
      fingerprint: fp,
      briefFingerprint: brief?.fingerprint ?? "",
      content,
      createdBy: actorUserId,
    });
    return { action: "drafted", postmortem: row, synthesis };
  } catch (e) {
    return { action: "deferred", reason: e instanceof Error ? e.message : "draft persist failed" };
  }
}

function assembleContent(input: {
  title: string;
  severity: string;
  links: { customers: number; conversations: number };
  brief: { fingerprint: string; findings: { facts: { observation: string; sources: string[] }[]; unknowns: string[]; hypotheses: { text: string; basedOn: string[] }[] } } | null;
  plans: { id: string; plan_version: number; status: string; brief_fingerprint: string; payload: { problemSummary?: string; historicalBasis?: { refId: string; tier: string }[] } }[];
  events: ClosureEvent[];
  watch: WatchSnap | null;
  history: WatchSnap[];
}): PostmortemContent {
  const facts: PostmortemFact[] = (input.brief?.findings.facts ?? []).map((f) => ({
    statement: f.observation.slice(0, 300),
    sources: f.sources.slice(0, 6),
  }));
  const symptoms = [...new Set((input.brief?.findings.facts ?? []).map((f) => f.observation.slice(0, 160)))].slice(0, 8);
  const chronology: PostmortemTimelineItem[] = input.events.slice(0, 200).map((e) => ({
    at: e.at,
    kind: e.kind,
    detail: JSON.stringify(e.detail).slice(0, 200),
  }));
  const obs = input.watch?.observations ?? [];
  const improvements = obs.filter((o) => o.kind === "customer_improvement" || o.kind === "verification").length;
  const regressions = obs.filter((o) => o.kind === "regression").length;
  const kinds = new Set(input.events.map((e) => e.kind));
  const detection = kinds.has("detected_by_system") || kinds.has("candidate_promoted")
    ? "Detected from customer reports with automated triage; see timeline."
    : "Detected from customer reports; see timeline for first linkage.";
  const investigation = [
    ...(kinds.has("brief_built") || input.brief ? [`Evidence brief assembled (${facts.length} grounded facts).`] : ["No evidence brief was assembled."]),
    ...input.plans.map((p) => `Recovery plan v${p.plan_version} ${p.status} (fingerprint ${p.brief_fingerprint.slice(0, 8)}).`),
  ];
  const unknowns = [...(input.brief?.findings.unknowns ?? []).map((u) => u.slice(0, 200))].slice(0, 10);
  return {
    title: input.title,
    severity: input.severity,
    impact: {
      documentedCustomers: input.links.customers,
      documentedConversations: input.links.conversations,
      note: "Documented linked records only; unlinked or unreported impact is unknown, not zero.",
    },
    symptoms,
    facts,
    chronology,
    detection,
    investigation,
    historicalBasis: input.plans.flatMap((p) => (p.payload.historicalBasis ?? []).map((h) => ({ refId: h.refId, tier: h.tier, note: "Lead, not prescription." }))).slice(0, 10),
    recoveryProposals: input.plans.map((p) => ({ planVersion: p.plan_version, status: p.status, fingerprint: p.brief_fingerprint })),
    approvals: [],
    interventions: [],
    watch: {
      status: input.watch?.status ?? "none",
      observations: obs.length,
      improvements,
      regressions,
      confirmedBy: input.watch?.confirmed_by_user_id ?? null,
    },
    outcome: input.watch?.status === "resolution_confirmed"
      ? "Resolution confirmed by an authorized operator on supporting customer evidence. Customers' own recovery is inferred from their reports, not proven."
      : "No confirmed resolution. This postmortem records investigation only.",
    unknowns,
    rootCause: { status: "unknown", statement: "No verified root cause recorded." },
    lessons: [],
    prevention: [],
    synthesisNote: "Factual timeline only — no model synthesis attached.",
  };
}

export type Synthesis = {
  lessons: PostmortemSuggestion[];
  prevention: PostmortemSuggestion[];
  unknowns: string[];
  rootCause: { status: RootCauseStatus; statement: string };
};

/**
 * Strict synthesis validation: suggestions must ground in known record IDs;
 * rootCause 'verified' is rejected (Meros has no root-cause verification);
 * nothing invented passes.
 */
export function validateSynthesis(raw: unknown, knownIds: Set<string>): Synthesis | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const pick = (v: unknown): PostmortemSuggestion[] | null => {
    if (!Array.isArray(v) || v.length > 6) return null;
    const out: PostmortemSuggestion[] = [];
    for (const s of v) {
      if (!s || typeof s !== "object") return null;
      const { text, basedOn } = s as Record<string, unknown>;
      if (typeof text !== "string" || !text.trim() || text.length > 300) return null;
      if (!Array.isArray(basedOn) || basedOn.length === 0 || basedOn.length > 6) return null;
      for (const b of basedOn) {
        if (typeof b !== "string" || (!knownIds.has(b) && b !== "brief" && b !== "watch" && b !== "plan")) return null;
      }
      out.push({ text: text.trim(), basedOn: basedOn as string[] });
    }
    return out;
  };
  const lessons = pick(r.lessons ?? []);
  const prevention = pick(r.prevention ?? []);
  if (!lessons || !prevention) return null;
  const unknowns = Array.isArray(r.unknowns) ? (r.unknowns as unknown[]) : [];
  if (unknowns.length > 6) return null;
  const cleanUnknowns: string[] = [];
  for (const u of unknowns) {
    if (typeof u !== "string" || !u.trim() || u.length > 200) return null;
    cleanUnknowns.push(u.trim());
  }
  let rootCause: Synthesis["rootCause"] = { status: "unknown", statement: "No verified root cause recorded." };
  if (r.rootCause !== undefined) {
    const rc = r.rootCause as Record<string, unknown>;
    if (rc.status === "verified") return null; // never trust a model claiming proof
    if (rc.status !== "unverified" && rc.status !== "unknown") return null;
    if (typeof rc.statement !== "string" || !rc.statement.trim() || rc.statement.length > 300) return null;
    rootCause = { status: rc.status, statement: rc.statement.trim() };
  }
  return { lessons, prevention, unknowns: cleanUnknowns, rootCause };
}

export type ConfirmResult =
  | { action: "closed"; incidentStatus: string; postmortemId: string }
  | { action: "duplicate"; incidentStatus: string; postmortemId: string }
  | { action: "deferred"; reason: string };

/**
 * Confirm closure: finalize the current draft and resolve the incident in
 * a safely recoverable order (finalize first; resolve retries idempotently
 * to 'duplicate' when already closed on the same snapshot).
 */
export async function confirmClosure(
  incidentId: string,
  workspaceId: string,
  actorUserId: string,
  input: { postmortemId: string; note?: string | null } | { administrative: true; reason: string },
  deps: ClosureDeps,
  transitionToResolved: (
    postmortemId: string | null,
    reason: string | null,
    administrative: boolean,
  ) => Promise<{ status: string }>,
): Promise<ConfirmResult> {
  if ("administrative" in input) {
    if (!input.reason.trim()) return { action: "deferred", reason: "administrative closure needs a reason" };
    try {
      const after = await transitionToResolved(null, input.reason.trim().slice(0, 500), true);
      if (after.status !== "resolved") return { action: "deferred", reason: "incident did not resolve" };
      return { action: "closed", incidentStatus: after.status, postmortemId: "" };
    } catch (e) {
      return { action: "deferred", reason: e instanceof Error ? e.message : "administrative closure failed" };
    }
  }
  const eligibility = await checkEligibility(incidentId, workspaceId, deps);
  if (!eligibility.eligible) {
    // Idempotent retry: already resolved on the same finalized snapshot.
    const incident = await deps.loadIncident(incidentId, workspaceId).catch(() => null);
    if (incident?.status === "resolved") {
      const finals = await deps.postmortems.listFinalized(incidentId, workspaceId).catch(() => []);
      if (finals.some((f) => f.id === input.postmortemId)) {
        return { action: "duplicate", incidentStatus: "resolved", postmortemId: input.postmortemId };
      }
    }
    return { action: "deferred", reason: eligibility.blockers.join("; ") };
  }
  if (eligibility.draftId !== input.postmortemId) {
    return { action: "deferred", reason: "postmortem is not the current draft" };
  }
  try {
    const finalized = await deps.postmortems.finalize(input.postmortemId, workspaceId, actorUserId, input.note ?? null);
    try {
      const after = await transitionToResolved(finalized.id, null, false);
      return { action: "closed", incidentStatus: after.status, postmortemId: finalized.id };
    } catch (e) {
      // Finalized first: a retry sees resolved + same finalized snapshot → duplicate. Recoverable.
      const incident = await deps.loadIncident(incidentId, workspaceId).catch(() => null);
      if (incident?.status === "resolved") {
        return { action: "duplicate", incidentStatus: "resolved", postmortemId: finalized.id };
      }
      return { action: "deferred", reason: e instanceof Error ? e.message : "resolve failed after finalize" };
    }
  } catch (e) {
    return { action: "deferred", reason: e instanceof Error ? e.message : "finalize failed" };
  }
}
