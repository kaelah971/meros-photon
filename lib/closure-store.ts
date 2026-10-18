import "server-only";

import type {
  ClosureDeps,
  ClosureEvent,
  PostmortemContent,
  PostmortemRow,
  PostmortemStore,
} from "./closure";

// Neon persistence for S12 (workspace-scoped SQL + audit). Drafts upsert
// idempotently; finalized rows are immutable, append-only history.

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

const PM_COLS = `id, incident_id, workspace_id, watch_id, status,
  source_fingerprint, brief_fingerprint, content,
  created_by_user_id, finalized_by_user_id, finalized_at, note,
  created_at, updated_at`;

function toRow(r: Record<string, unknown>): PostmortemRow {
  return {
    id: r.id as string,
    incident_id: r.incident_id as string,
    workspace_id: r.workspace_id as string,
    watch_id: (r.watch_id as string | null) ?? null,
    status: r.status as PostmortemRow["status"],
    source_fingerprint: r.source_fingerprint as string,
    brief_fingerprint: r.brief_fingerprint as string,
    content: r.content as PostmortemContent,
    created_by_user_id: (r.created_by_user_id as string | null) ?? null,
    finalized_by_user_id: (r.finalized_by_user_id as string | null) ?? null,
    finalized_at: (r.finalized_at as string | null) ?? null,
    note: (r.note as string | null) ?? null,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

export async function realPostmortemStore(): Promise<PostmortemStore> {
  const sql = await requireSql();
  const { recordEvent } = await import("./incidents");
  return {
    loadDraft: async (incidentId, workspaceId) => {
      const rows = (await sql`
        select id, incident_id, workspace_id, watch_id, status,
          source_fingerprint, brief_fingerprint, content,
          created_by_user_id, finalized_by_user_id, finalized_at, note,
          created_at, updated_at
        from incident_postmortems
        where incident_id = ${incidentId} and workspace_id = ${workspaceId}
          and status = 'draft'
        order by updated_at desc limit 1
      `) as unknown as Record<string, unknown>[];
      return rows[0] ? toRow(rows[0]) : null;
    },
    loadById: async (postmortemId, workspaceId) => {
      const rows = (await sql`
        select id, incident_id, workspace_id, watch_id, status,
          source_fingerprint, brief_fingerprint, content,
          created_by_user_id, finalized_by_user_id, finalized_at, note,
          created_at, updated_at
        from incident_postmortems
        where id = ${postmortemId} and workspace_id = ${workspaceId}
        limit 1
      `) as unknown as Record<string, unknown>[];
      return rows[0] ? toRow(rows[0]) : null;
    },
    listFinalized: async (incidentId, workspaceId) => {
      const rows = (await sql`
        select id, incident_id, workspace_id, watch_id, status,
          source_fingerprint, brief_fingerprint, content,
          created_by_user_id, finalized_by_user_id, finalized_at, note,
          created_at, updated_at
        from incident_postmortems
        where incident_id = ${incidentId} and workspace_id = ${workspaceId}
          and status = 'finalized'
        order by finalized_at desc limit 10
      `) as unknown as Record<string, unknown>[];
      return rows.map(toRow);
    },
    saveDraft: async (input) => {
      const rows = (await sql`
        insert into incident_postmortems
          (incident_id, workspace_id, watch_id, status, source_fingerprint,
           brief_fingerprint, content, created_by_user_id)
        values (${input.incidentId}, ${input.workspaceId}, ${input.watchId}, 'draft',
                ${input.fingerprint}, ${input.briefFingerprint},
                ${JSON.stringify(input.content)}::jsonb, ${input.createdBy})
        on conflict (incident_id) where status = 'draft'
        do update set watch_id = excluded.watch_id,
                      source_fingerprint = excluded.source_fingerprint,
                      brief_fingerprint = excluded.brief_fingerprint,
                      content = excluded.content,
                      updated_at = now()
        returning id, incident_id, workspace_id, watch_id, status,
          source_fingerprint, brief_fingerprint, content,
          created_by_user_id, finalized_by_user_id, finalized_at, note,
          created_at, updated_at
      `) as unknown as Record<string, unknown>[];
      if (!rows[0]) throw new Error("postmortem draft persist failed");
      const row = toRow(rows[0]);
      await recordEvent({
        incidentId: input.incidentId,
        kind: "postmortem_drafted",
        actorUserId: input.createdBy,
        detail: { postmortemId: row.id, fingerprint: input.fingerprint },
      }).catch(() => null);
      return { row, deduped: false };
    },
    finalize: async (postmortemId, workspaceId, actorUserId, note) => {
      const current = (await sql`
        select id, incident_id, status from incident_postmortems
        where id = ${postmortemId} and workspace_id = ${workspaceId} limit 1
      `) as unknown as { id: string; incident_id: string; status: string }[];
      if (!current[0]) throw Object.assign(new Error("postmortem not found"), { status: 404 });
      if (current[0].status === "finalized") {
        const rows = (await sql`
          select id, incident_id, workspace_id, watch_id, status,
            source_fingerprint, brief_fingerprint, content,
            created_by_user_id, finalized_by_user_id, finalized_at, note,
            created_at, updated_at
          from incident_postmortems
          where id = ${postmortemId} and workspace_id = ${workspaceId} limit 1
        `) as unknown as Record<string, unknown>[];
        return toRow(rows[0]);
      }
      if (current[0].status !== "draft") throw Object.assign(new Error("postmortem is not a draft"), { status: 409 });
      const rows = (await sql`
        update incident_postmortems
        set status = 'finalized', finalized_by_user_id = ${actorUserId},
            finalized_at = now(), note = coalesce(${note}, note), updated_at = now()
        where id = ${postmortemId} and workspace_id = ${workspaceId} and status = 'draft'
        returning id, incident_id, workspace_id, watch_id, status,
          source_fingerprint, brief_fingerprint, content,
          created_by_user_id, finalized_by_user_id, finalized_at, note,
          created_at, updated_at
      `) as unknown as Record<string, unknown>[];
      if (!rows[0]) throw Object.assign(new Error("postmortem already decided"), { status: 409 });
      const row = toRow(rows[0]);
      await recordEvent({
        incidentId: row.incident_id,
        kind: "postmortem_finalized",
        actorUserId,
        detail: { postmortemId: row.id },
      }).catch(() => null);
      return row;
    },
  };
}

/** Production wiring: composes S4/S6/S9/S10/S11 reads into closure deps. */
export async function realClosureDeps(opts: { judge?: boolean } = {}): Promise<
  ClosureDeps & {
    bindTransition: (
      incidentId: string,
      workspaceId: string,
      actorUserId: string,
    ) => (postmortemId: string | null, reason: string | null, administrative: boolean) => Promise<{ status: string }>;
  }
> {
  const postmortems = await realPostmortemStore();
  const { geminiClosureJudge } = await import("./closure-gemini");
  let judge: ClosureDeps["judge"] = null;
  try {
    const { isGeminiConfigured } = await import("./env");
    judge = opts.judge === false || !isGeminiConfigured() ? null : geminiClosureJudge();
  } catch {
    judge = null;
  }
  const loadIncident: ClosureDeps["loadIncident"] = async (incidentId, workspaceId) => {
    const { getIncidentForWorkspace } = await import("./incidents");
    const row = await getIncidentForWorkspace(workspaceId, incidentId);
    return row
      ? { id: row.id, workspace_id: row.workspace_id, title: row.title, severity: row.severity, status: row.status, updated_at: row.updated_at }
      : null;
  };
  return {
    postmortems,
    judge,
    loadIncident,
    listEvents: async (incidentId, workspaceId) => {
      const { listIncidentEvents } = await import("./incidents");
      const rows = await listIncidentEvents(incidentId, workspaceId);
      return rows.map((e) => ({ kind: e.kind, at: e.created_at, detail: e.detail ?? {}, actor: e.actor_user_id })) as ClosureEvent[];
    },
    countLinks: async (incidentId, workspaceId) => {
      const { listIncidentCustomers, listIncidentConversations } = await import("./incidents");
      const [c, v] = await Promise.all([
        listIncidentCustomers(incidentId, workspaceId).catch(() => []),
        listIncidentConversations(incidentId, workspaceId).catch(() => []),
      ]);
      return { customers: c.length, conversations: v.length };
    },
    loadBrief: async (incidentId, workspaceId) => {
      const { getIncidentBrief } = await import("./evidence-brief");
      const brief = await getIncidentBrief(incidentId, workspaceId).catch(() => null);
      return brief
        ? {
            fingerprint: brief.fingerprint,
            findings: {
              facts: (brief.findings.facts ?? []).map((f) => ({ observation: f.observation, sources: f.sources ?? [] })),
              unknowns: brief.findings.unknowns ?? [],
              hypotheses: (brief.findings.hypotheses ?? []).map((h) => ({ text: h.text, basedOn: h.basedOn ?? [] })),
            },
          }
        : null;
    },
    listPlans: async (incidentId, workspaceId) => {
      const { realPlanStore } = await import("./recovery-plans");
      const store = await realPlanStore();
      const [active, history] = await Promise.all([
        store.loadActive(incidentId, workspaceId).catch(() => []),
        store.loadHistory(incidentId, workspaceId).catch(() => []),
      ]);
      const seen = new Set<string>();
      const all = [...active, ...history].filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));
      return all.map((p) => ({
        id: p.id,
        plan_version: p.plan_version,
        status: p.status,
        brief_fingerprint: p.brief_fingerprint,
        payload: { problemSummary: p.payload.problemSummary, historicalBasis: p.payload.historicalBasis },
      }));
    },
    listControls: async (planId, workspaceId) => {
      const { realApprovalDeps } = await import("./recovery-approvals");
      const adeps = await realApprovalDeps();
      const approvals = await adeps.approvals.listForPlan(planId, workspaceId).catch(() => []);
      const executions = await adeps.executions.listForPlan(planId, workspaceId).catch(() => []);
      return {
        approvals: approvals.map((a) => ({ id: a.id, status: a.status, scope: `steps ${a.scope.steps.map((s) => s + 1).join(",") || "—"} · fp ${a.scope_hash.slice(0, 8)}` })),
        executions: executions.map((e) => ({ id: e.id, status: e.status, ref: e.provider_ref })),
      };
    },
    loadWatchHistory: async (incidentId, workspaceId) => {
      const { realWatchDeps } = await import("./resolution-watch-store");
      const wdeps = await realWatchDeps({ judge: false });
      const rows = await wdeps.watches.listForIncident(incidentId, workspaceId).catch(() => []);
      const withObs = await Promise.all(
        rows.slice(0, 10).map(async (w) => ({
          id: w.id,
          status: w.status,
          baseline_fingerprint: w.baseline_fingerprint,
          baseline_summary: w.baseline_summary,
          last_evaluation_at: w.last_evaluation_at,
          confirmed_by_user_id: w.confirmed_by_user_id,
          confirmed_at: w.confirmed_at,
          observations: (await wdeps.observations.listForWatch(w.id, workspaceId).catch(() => [])).map((o) => ({
            kind: o.kind,
            message_id: o.message_id,
            created_at: o.created_at,
            excerpt: o.excerpt,
          })),
        })),
      );
      const current = withObs.find((w) => w.status !== "resolution_confirmed") ?? withObs[0] ?? null;
      return {
        current,
        history: current ? withObs.filter((w) => w.id !== current.id) : withObs,
      };
    },
    listRecentUserMessages: async (incidentId, workspaceId, since, limit) => {
      const sql = await requireSql();
      const rows = (await sql`
        select m.id, m.created_at
        from messages m
        join incident_conversations iv on iv.conversation_id = m.conversation_id
        join incidents i on i.id = iv.incident_id
        where iv.incident_id = ${incidentId} and i.workspace_id = ${workspaceId}
          and m.role = 'user' and m.created_at > ${since ?? "1970-01-01T00:00:00Z"}
        order by m.created_at asc limit ${limit}
      `) as unknown as { id: string; created_at: string }[];
      return rows.map((r) => ({ id: r.id, created_at: r.created_at }));
    },
    bindTransition: (incidentId, workspaceId, actorUserId) => async (postmortemId, reason, administrative) => {
      const { transitionIncident } = await import("./incidents");
      const after = await transitionIncident({
        incidentId,
        workspaceId,
        to: "resolved",
        actorUserId,
        resolutionSummary: administrative ? null : "Verified recovery — see finalized postmortem.",
        ...(administrative
          ? { closure: { mode: "administrative" as const, reason: reason ?? "" } }
          : { closure: { mode: "verified" as const, postmortemId: postmortemId ?? "" } }),
      });
      return { status: after.status };
    },
  };
}
