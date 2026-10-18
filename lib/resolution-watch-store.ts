import "server-only";

import type {
  ObservationStore,
  WatchDeps,
  WatchObservation,
  WatchRow,
  WatchStatus,
  WatchStore,
} from "./resolution-watch";

// Neon persistence for S11 (workspace-scoped SQL + audit, mirrors S9/S10).
// Additive tables only; watch history is append-only and never rewritten.

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

const WATCH_SELECT = `select id, incident_id, workspace_id, plan_id, approval_id, execution_id,
  baseline_fingerprint, baseline_summary, baseline_symptoms, status,
  last_observation_at, last_evaluation_at, confirmed_by_user_id, confirmed_at,
  note, created_at, updated_at from incident_resolution_watches`;

const OBS_SELECT = `select id, watch_id, incident_id, workspace_id, kind, message_id,
  conversation_id, excerpt, created_by_user_id, created_at from incident_watch_observations`;

function toWatch(r: Record<string, unknown>): WatchRow {
  return {
    id: r.id as string,
    incident_id: r.incident_id as string,
    workspace_id: r.workspace_id as string,
    plan_id: (r.plan_id as string | null) ?? null,
    approval_id: (r.approval_id as string | null) ?? null,
    execution_id: (r.execution_id as string | null) ?? null,
    baseline_fingerprint: r.baseline_fingerprint as string,
    baseline_summary: r.baseline_summary as string,
    baseline_symptoms: (r.baseline_symptoms as string[]) ?? [],
    status: r.status as WatchStatus,
    last_observation_at: (r.last_observation_at as string | null) ?? null,
    last_evaluation_at: (r.last_evaluation_at as string | null) ?? null,
    confirmed_by_user_id: (r.confirmed_by_user_id as string | null) ?? null,
    confirmed_at: (r.confirmed_at as string | null) ?? null,
    note: (r.note as string | null) ?? null,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

function toObservation(r: Record<string, unknown>): WatchObservation {
  return {
    id: r.id as string,
    watch_id: r.watch_id as string,
    incident_id: r.incident_id as string,
    workspace_id: r.workspace_id as string,
    kind: r.kind as WatchObservation["kind"],
    message_id: (r.message_id as string | null) ?? null,
    conversation_id: (r.conversation_id as string | null) ?? null,
    excerpt: (r.excerpt as string | null) ?? null,
    created_by_user_id: (r.created_by_user_id as string | null) ?? null,
    created_at: r.created_at as string,
  };
}

export async function realWatchStores(): Promise<{ watches: WatchStore; observations: ObservationStore }> {
  const sql = await requireSql();
  const { recordEvent } = await import("./incidents");
  const watches: WatchStore = {
    activeForIncident: async (incidentId, workspaceId) => {
      const rows = (await sql`
        select id, incident_id, workspace_id, plan_id, approval_id, execution_id,
          baseline_fingerprint, baseline_summary, baseline_symptoms, status,
          last_observation_at, last_evaluation_at, confirmed_by_user_id, confirmed_at,
          note, created_at, updated_at
        from incident_resolution_watches
        where incident_id = ${incidentId} and workspace_id = ${workspaceId}
          and status != 'resolution_confirmed'
        order by created_at desc
      `) as unknown as Record<string, unknown>[];
      void WATCH_SELECT;
      return rows.map(toWatch);
    },
    listForIncident: async (incidentId, workspaceId) => {
      const rows = (await sql`
        select id, incident_id, workspace_id, plan_id, approval_id, execution_id,
          baseline_fingerprint, baseline_summary, baseline_symptoms, status,
          last_observation_at, last_evaluation_at, confirmed_by_user_id, confirmed_at,
          note, created_at, updated_at
        from incident_resolution_watches
        where incident_id = ${incidentId} and workspace_id = ${workspaceId}
        order by created_at desc limit 20
      `) as unknown as Record<string, unknown>[];
      return rows.map(toWatch);
    },
    loadById: async (watchId, workspaceId) => {
      const rows = (await sql`
        select id, incident_id, workspace_id, plan_id, approval_id, execution_id,
          baseline_fingerprint, baseline_summary, baseline_symptoms, status,
          last_observation_at, last_evaluation_at, confirmed_by_user_id, confirmed_at,
          note, created_at, updated_at
        from incident_resolution_watches
        where id = ${watchId} and workspace_id = ${workspaceId} limit 1
      `) as unknown as Record<string, unknown>[];
      return rows[0] ? toWatch(rows[0]) : null;
    },
    insert: async (input) => {
      const existing = (await sql`
        select id, incident_id, workspace_id, plan_id, approval_id, execution_id,
          baseline_fingerprint, baseline_summary, baseline_symptoms, status,
          last_observation_at, last_evaluation_at, confirmed_by_user_id, confirmed_at,
          note, created_at, updated_at
        from incident_resolution_watches
        where incident_id = ${input.incidentId} and workspace_id = ${input.workspaceId}
          and status != 'resolution_confirmed'
        order by created_at desc limit 1
      `) as unknown as Record<string, unknown>[];
      if (existing[0]) return { row: toWatch(existing[0]), deduped: true };
      const rows = (await sql`
        insert into incident_resolution_watches
          (incident_id, workspace_id, plan_id, approval_id, execution_id,
           baseline_fingerprint, baseline_summary, baseline_symptoms, status, note)
        values (${input.incidentId}, ${input.workspaceId}, ${input.planId},
                ${input.approvalId}, ${input.executionId}, ${input.baselineFingerprint},
                ${input.baselineSummary}, ${JSON.stringify(input.baselineSymptoms)}::jsonb,
                'awaiting_evidence', ${input.note})
        on conflict (incident_id) where status != 'resolution_confirmed' do nothing
        returning id, incident_id, workspace_id, plan_id, approval_id, execution_id,
          baseline_fingerprint, baseline_summary, baseline_symptoms, status,
          last_observation_at, last_evaluation_at, confirmed_by_user_id, confirmed_at,
          note, created_at, updated_at
      `) as unknown as Record<string, unknown>[];
      if (rows[0]) {
        const row = toWatch(rows[0]);
        await recordEvent({
          incidentId: input.incidentId,
          kind: "watch_started",
          actorUserId: input.createdBy,
          detail: { watchId: row.id, planId: input.planId, executionId: input.executionId },
        }).catch(() => null);
        return { row, deduped: false };
      }
      const winner = (await sql`
        select id, incident_id, workspace_id, plan_id, approval_id, execution_id,
          baseline_fingerprint, baseline_summary, baseline_symptoms, status,
          last_observation_at, last_evaluation_at, confirmed_by_user_id, confirmed_at,
          note, created_at, updated_at
        from incident_resolution_watches
        where incident_id = ${input.incidentId} and workspace_id = ${input.workspaceId}
          and status != 'resolution_confirmed'
        order by created_at desc limit 1
      `) as unknown as Record<string, unknown>[];
      if (!winner[0]) throw new Error("watch persist failed");
      return { row: toWatch(winner[0]), deduped: true };
    },
    setStatus: async (input) => {
      const rows = (await sql`
        update incident_resolution_watches
        set status = ${input.to},
            confirmed_by_user_id = case when ${input.to} = 'resolution_confirmed' then ${input.actorUserId} else confirmed_by_user_id end,
            confirmed_at = case when ${input.to} = 'resolution_confirmed' then now() else confirmed_at end,
            note = coalesce(${input.note ?? null}, note),
            updated_at = now()
        where id = ${input.watchId} and workspace_id = ${input.workspaceId}
          and status != 'resolution_confirmed'
        returning id, incident_id, workspace_id, plan_id, approval_id, execution_id,
          baseline_fingerprint, baseline_summary, baseline_symptoms, status,
          last_observation_at, last_evaluation_at, confirmed_by_user_id, confirmed_at,
          note, created_at, updated_at
      `) as unknown as Record<string, unknown>[];
      if (!rows[0]) throw Object.assign(new Error("watch not found or already confirmed"), { status: 409 });
      const row = toWatch(rows[0]);
      const kind =
        input.to === "resolution_confirmed"
          ? "watch_confirmed"
          : input.to === "still_affected"
            ? "watch_regression"
            : "watch_updated";
      await recordEvent({
        incidentId: row.incident_id,
        kind,
        actorUserId: input.actorUserId,
        detail: { watchId: row.id, to: input.to },
      }).catch(() => null);
      return row;
    },
    touchEvaluation: async (watchId, workspaceId, at) => {
      await sql`
        update incident_resolution_watches
        set last_evaluation_at = ${at}, updated_at = now()
        where id = ${watchId} and workspace_id = ${workspaceId}
      `;
    },
    touchObservation: async (watchId, workspaceId, at) => {
      await sql`
        update incident_resolution_watches
        set last_observation_at = ${at}, updated_at = now()
        where id = ${watchId} and workspace_id = ${workspaceId}
      `;
    },
  };
  const observations: ObservationStore = {
    listForWatch: async (watchId, workspaceId) => {
      const rows = (await sql`
        select id, watch_id, incident_id, workspace_id, kind, message_id,
               conversation_id, excerpt, created_by_user_id, created_at
        from incident_watch_observations
        where watch_id = ${watchId} and workspace_id = ${workspaceId}
        order by created_at, id limit 100
      `) as unknown as Record<string, unknown>[];
      void OBS_SELECT;
      return rows.map(toObservation);
    },
    hasMessage: async (watchId, workspaceId, messageId) => {
      const rows = (await sql`
        select id from incident_watch_observations
        where watch_id = ${watchId} and workspace_id = ${workspaceId} and message_id = ${messageId}
        limit 1
      `) as unknown as { id: string }[];
      return rows.length > 0;
    },
    insert: async (input) => {
      if (input.messageId) {
        const dup = (await sql`
          select id, watch_id, incident_id, workspace_id, kind, message_id,
                 conversation_id, excerpt, created_by_user_id, created_at
          from incident_watch_observations
          where watch_id = ${input.watchId} and workspace_id = ${input.workspaceId}
            and message_id = ${input.messageId}
          limit 1
        `) as unknown as Record<string, unknown>[];
        if (dup[0]) return { row: toObservation(dup[0]), deduped: true };
      }
      const rows = (await sql`
        insert into incident_watch_observations
          (watch_id, incident_id, workspace_id, kind, message_id, conversation_id, excerpt, created_by_user_id)
        values (${input.watchId}, ${input.incidentId}, ${input.workspaceId}, ${input.kind},
                ${input.messageId}, ${input.conversationId}, ${input.excerpt}, ${input.createdBy})
        on conflict (watch_id, message_id) where message_id is not null do nothing
        returning id, watch_id, incident_id, workspace_id, kind, message_id,
                  conversation_id, excerpt, created_by_user_id, created_at
      `) as unknown as Record<string, unknown>[];
      if (rows[0]) {
        const row = toObservation(rows[0]);
        await recordEvent({
          incidentId: input.incidentId,
          kind: input.kind === "regression" ? "watch_regression" : "watch_observed",
          actorUserId: input.createdBy,
          detail: { watchId: input.watchId, kind: input.kind, messageId: input.messageId },
        }).catch(() => null);
        return { row, deduped: false };
      }
      const winner = (await sql`
        select id, watch_id, incident_id, workspace_id, kind, message_id,
               conversation_id, excerpt, created_by_user_id, created_at
        from incident_watch_observations
        where watch_id = ${input.watchId} and workspace_id = ${input.workspaceId}
          and message_id = ${input.messageId}
        limit 1
      `) as unknown as Record<string, unknown>[];
      if (!winner[0]) throw new Error("observation persist failed");
      return { row: toObservation(winner[0]), deduped: true };
    },
  };
  return { watches, observations };
}

/** Production wiring shared by S11 routes, server components, and chat hooks. */
export async function realWatchDeps(opts: { judge?: boolean } = {}): Promise<WatchDeps> {
  const { watches, observations } = await realWatchStores();
  const { geminiWatchJudge } = await import("./resolution-watch-gemini");
  let judge: WatchDeps["judge"] = null;
  try {
    const { isGeminiConfigured } = await import("./env");
    judge = opts.judge === false || !isGeminiConfigured() ? null : geminiWatchJudge();
  } catch {
    judge = null;
  }
  return {
    watches,
    observations,
    judge,
    loadPlan: async (planId, workspaceId) => {
      const { realPlanStore } = await import("./recovery-plans");
      const store = await realPlanStore();
      const row = await store.loadById(planId, workspaceId);
      if (!row) return null;
      const { getIncidentBrief } = await import("./evidence-brief");
      const brief = await getIncidentBrief(row.incident_id, workspaceId).catch(() => null);
      const facts = (brief?.findings.facts ?? []).map((f) => f.observation);
      return {
        id: row.id,
        incident_id: row.incident_id,
        workspace_id: row.workspace_id,
        plan_version: row.plan_version,
        status: row.status,
        brief_fingerprint: row.brief_fingerprint,
        problem_summary: row.payload.problemSummary ?? "",
        baseline_observations: facts.slice(0, 10),
      };
    },
    loadApproval: async (approvalId, workspaceId) => {
      const { realApprovalStore } = await import("./recovery-approvals");
      const store = await realApprovalStore();
      const row = await store.loadById(approvalId, workspaceId);
      return row ? { id: row.id, status: row.status, plan_id: row.plan_id } : null;
    },
    loadApprovalByPlan: async (planId, workspaceId) => {
      const { realApprovalStore } = await import("./recovery-approvals");
      const store = await realApprovalStore();
      const rows = await store.listForPlan(planId, workspaceId);
      const approved = rows.find((r) => r.status === "approved") ?? rows.find((r) => r.status === "requested");
      return approved ? { id: approved.id, status: approved.status, plan_id: approved.plan_id } : null;
    },
    loadExecution: async (executionId, workspaceId) => {
      const { realExecutionStore } = await import("./recovery-approvals");
      const store = await realExecutionStore();
      const row = await store.loadById(executionId, workspaceId);
      return row ? { id: row.id, status: row.status, plan_id: row.plan_id, approval_id: row.approval_id } : null;
    },
    executionsForPlan: async (planId, workspaceId) => {
      const { realExecutionStore } = await import("./recovery-approvals");
      const store = await realExecutionStore();
      const rows = await store.listForPlan(planId, workspaceId);
      return rows.map((r) => ({ id: r.id, status: r.status }));
    },
    loadBriefFingerprint: async (incidentId, workspaceId) => {
      const { getIncidentBrief } = await import("./evidence-brief");
      const brief = await getIncidentBrief(incidentId, workspaceId).catch(() => null);
      return brief?.fingerprint ?? null;
    },
    listNewUserMessages: async (incidentId, workspaceId, since, limit) => {
      const sql = await requireSql();
      const rows = (await sql`
        select m.id, m.conversation_id, m.created_at, substring(m.content, 1, 500) as excerpt
        from messages m
        join incident_conversations iv on iv.conversation_id = m.conversation_id
        join incidents i on i.id = iv.incident_id
        where iv.incident_id = ${incidentId} and i.workspace_id = ${workspaceId}
          and m.role = 'user' and m.created_at > ${since ?? "1970-01-01T00:00:00Z"}
        order by m.created_at asc limit ${limit}
      `) as unknown as { id: string; conversation_id: string; created_at: string; excerpt: string }[];
      return rows.map((r) => ({
        id: r.id,
        conversation_id: r.conversation_id,
        created_at: r.created_at,
        excerpt: r.excerpt ?? "",
      }));
    },
  };
}

/** Watch freshness: baseline fingerprint vs the live brief. */
export async function watchFreshness(
  watch: { incident_id: string; baseline_fingerprint: string },
  workspaceId: string,
): Promise<{ current: boolean; liveFingerprint: string | null }> {
  try {
    const { getIncidentBrief } = await import("./evidence-brief");
    const brief = await getIncidentBrief(watch.incident_id, workspaceId).catch(() => null);
    if (!brief) return { current: true, liveFingerprint: null };
    return { current: brief.fingerprint === watch.baseline_fingerprint, liveFingerprint: brief.fingerprint };
  } catch {
    return { current: true, liveFingerprint: null };
  }
}
