import "server-only";

import type {
  FindingConfidence,
  FindingDetail,
  FindingStatus,
  FindingStore,
  FindingType,
  HealthDeps,
  KnowledgeFinding,
} from "./knowledge-health";

// Neon persistence for S14 (workspace-scoped SQL, mirrors S9–S13).
// Open findings dedupe on (workspace, entity_key); changed evidence
// supersedes the prior open row (history preserved, never deleted).

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

const FINDING_COLS = `id, workspace_id, type, confidence, status, title,
  detail, fingerprint, entity_key, first_seen_at, last_seen_at,
  reviewed_by_user_id, review_note, created_at, updated_at`;

function toRow(r: Record<string, unknown>): KnowledgeFinding {
  return {
    id: r.id as string,
    workspace_id: r.workspace_id as string,
    type: r.type as FindingType,
    confidence: r.confidence as FindingConfidence,
    status: r.status as FindingStatus,
    title: r.title as string,
    detail: r.detail as FindingDetail,
    fingerprint: r.fingerprint as string,
    entity_key: r.entity_key as string,
    first_seen_at: r.first_seen_at as string,
    last_seen_at: r.last_seen_at as string,
    reviewed_by_user_id: (r.reviewed_by_user_id as string | null) ?? null,
    review_note: (r.review_note as string | null) ?? null,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

export async function realFindingStore(): Promise<FindingStore> {
  const sql = await requireSql();
  return {
    listOpen: async (workspaceId) => {
      const rows = (await sql`
        select id, workspace_id, type, confidence, status, title,
               detail, fingerprint, entity_key, first_seen_at, last_seen_at,
               reviewed_by_user_id, review_note, created_at, updated_at
        from knowledge_findings
        where workspace_id = ${workspaceId} and status in ('open', 'acknowledged')
        order by created_at desc limit 50
      `) as unknown as Record<string, unknown>[];
      return rows.map(toRow);
    },
    listForWorkspace: async (workspaceId, limit) => {
      const rows = (await sql`
        select id, workspace_id, type, confidence, status, title,
               detail, fingerprint, entity_key, first_seen_at, last_seen_at,
               reviewed_by_user_id, review_note, created_at, updated_at
        from knowledge_findings
        where workspace_id = ${workspaceId}
        order by updated_at desc limit ${limit}
      `) as unknown as Record<string, unknown>[];
      return rows.map(toRow);
    },
    loadById: async (findingId, workspaceId) => {
      const rows = (await sql`
        select id, workspace_id, type, confidence, status, title,
               detail, fingerprint, entity_key, first_seen_at, last_seen_at,
               reviewed_by_user_id, review_note, created_at, updated_at
        from knowledge_findings
        where id = ${findingId} and workspace_id = ${workspaceId} limit 1
      `) as unknown as Record<string, unknown>[];
      return rows[0] ? toRow(rows[0]) : null;
    },
    upsert: async (input) => {
      const existing = (await sql`
        select id, workspace_id, type, confidence, status, title,
               detail, fingerprint, entity_key, first_seen_at, last_seen_at,
               reviewed_by_user_id, review_note, created_at, updated_at
        from knowledge_findings
        where workspace_id = ${input.workspaceId} and entity_key = ${input.entityKey}
          and status in ('open', 'acknowledged')
        order by updated_at desc limit 1
      `) as unknown as Record<string, unknown>[];
      if (existing[0] && existing[0].fingerprint === input.fingerprint) {
        const touched = (await sql`
          update knowledge_findings set last_seen_at = now(), updated_at = now()
          where id = ${existing[0].id as string}
          returning id, workspace_id, type, confidence, status, title,
               detail, fingerprint, entity_key, first_seen_at, last_seen_at,
               reviewed_by_user_id, review_note, created_at, updated_at
        `) as unknown as Record<string, unknown>[];
        return { row: toRow(touched[0]), created: false, supersededId: null };
      }
      if (existing[0]) {
        await sql`
          update knowledge_findings set status = 'superseded', updated_at = now()
          where id = ${existing[0].id as string}
        `;
      }
      // A decided row (dismissed/addressed/superseded) with the SAME
      // fingerprint means the operator already judged this exact evidence:
      // hold the decision instead of reopening.
      const decided = (await sql`
        select id, workspace_id, type, confidence, status, title,
               detail, fingerprint, entity_key, first_seen_at, last_seen_at,
               reviewed_by_user_id, review_note, created_at, updated_at
        from knowledge_findings
        where workspace_id = ${input.workspaceId} and entity_key = ${input.entityKey}
          and fingerprint = ${input.fingerprint}
          and status in ('dismissed', 'addressed', 'superseded')
        order by updated_at desc limit 1
      `) as unknown as Record<string, unknown>[];
      if (decided[0]) {
        return { row: toRow(decided[0]), created: false, supersededId: null };
      }
      const rows = (await sql`
        insert into knowledge_findings
          (workspace_id, type, confidence, status, title, detail,
           fingerprint, entity_key, first_seen_at, last_seen_at)
        values (${input.workspaceId}, ${input.type}, ${input.confidence}, 'open',
                ${input.title}, ${JSON.stringify(input.detail)}::jsonb,
                ${input.fingerprint}, ${input.entityKey}, now(), now())
        on conflict (workspace_id, entity_key) where status in ('open', 'acknowledged') do nothing
        returning id, workspace_id, type, confidence, status, title,
               detail, fingerprint, entity_key, first_seen_at, last_seen_at,
               reviewed_by_user_id, review_note, created_at, updated_at
      `) as unknown as Record<string, unknown>[];
      if (rows[0]) {
        return { row: toRow(rows[0]), created: true, supersededId: (existing[0]?.id as string | undefined) ?? null };
      }
      // Lost a concurrent race (or a dismissed/decided row holds history):
      // return the live open winner instead of duplicating.
      const winner = (await sql`
        select id, workspace_id, type, confidence, status, title,
               detail, fingerprint, entity_key, first_seen_at, last_seen_at,
               reviewed_by_user_id, review_note, created_at, updated_at
        from knowledge_findings
        where workspace_id = ${input.workspaceId} and entity_key = ${input.entityKey}
          and status in ('open', 'acknowledged')
        order by updated_at desc limit 1
      `) as unknown as Record<string, unknown>[];
      if (winner[0]) return { row: toRow(winner[0]), created: false, supersededId: null };
      throw new Error("finding persist failed");
    },
    review: async (input) => {
      const rows = (await sql`
        update knowledge_findings
        set status = ${input.to}, reviewed_by_user_id = ${input.actorUserId},
            review_note = coalesce(${input.note}, review_note), updated_at = now()
        where id = ${input.findingId} and workspace_id = ${input.workspaceId}
          and status in ('open', 'acknowledged')
        returning id, workspace_id, type, confidence, status, title,
               detail, fingerprint, entity_key, first_seen_at, last_seen_at,
               reviewed_by_user_id, review_note, created_at, updated_at
      `) as unknown as Record<string, unknown>[];
      if (!rows[0]) throw Object.assign(new Error("finding not found or already decided"), { status: 409 });
      return toRow(rows[0]);
    },
    autoAddress: async (findingId, workspaceId, reason) => {
      await sql`
        update knowledge_findings
        set status = 'addressed',
            review_note = coalesce(review_note, '') || ${` [auto] ${reason}`},
            updated_at = now()
        where id = ${findingId} and workspace_id = ${workspaceId} and status in ('open', 'acknowledged')
      `;
    },
  };
}

/** Production wiring: bounded workspace reads across S4/S6/S8/S10/S13. */
export async function realHealthDeps(opts: { judge?: boolean } = {}): Promise<HealthDeps> {
  const findings = await realFindingStore();
  const { geminiContradictionJudge } = await import("./knowledge-health-gemini");
  let judge: HealthDeps["judge"] = null;
  try {
    const { isGeminiConfigured } = await import("./env");
    judge = opts.judge === false || !isGeminiConfigured() ? null : geminiContradictionJudge();
  } catch {
    judge = null;
  }
  return {
    findings,
    judge,
    listRecentIncidents: async (workspaceId, limit) => {
      const { listIncidents } = await import("./incidents");
      const rows = await listIncidents(workspaceId, null).catch(() => []);
      return rows.slice(0, limit).map((r) => ({ id: r.id, status: r.status, updated_at: r.updated_at }));
    },
    loadBrief: async (incidentId, workspaceId) => {
      const { getIncidentBrief } = await import("./evidence-brief");
      const b = await getIncidentBrief(incidentId, workspaceId).catch(() => null);
      return b
        ? {
            status: b.status,
            fingerprint: b.fingerprint,
            version: b.version,
            findings: {
              facts: (b.findings.facts ?? []).map((f) => ({ observation: f.observation, identifiers: f.identifiers ?? [], sources: f.sources ?? [] })),
              unknowns: b.findings.unknowns ?? [],
            },
          }
        : null;
    },
    loadMatches: async (incidentId, workspaceId, fingerprint) => {
      const { realMatchStore } = await import("./fix-matches");
      const store = await realMatchStore();
      const rows = await store.loadForBrief(incidentId, workspaceId, fingerprint).catch(() => []);
      return rows.map((r) => ({
        ref_id: r.ref_id,
        tier: r.tier,
        payload: {
          reasons: r.payload.reasons ?? [],
          matchingSymptoms: r.payload.matchingSymptoms ?? [],
          differences: r.payload.differences ?? [],
          unknowns: r.payload.unknowns ?? [],
          applicable: r.payload.applicable,
          warning: r.payload.warning ?? "",
          cardStatus: r.payload.cardStatus ?? "",
          cardResolved: r.payload.cardResolved ?? null,
          cardExcerpt: r.payload.cardExcerpt ?? "",
        },
      }));
    },
    recentMatches: async (workspaceId, limit) => {
      const sql = await requireSql();
      const rows = (await sql`
        select distinct on (incident_id, brief_fingerprint, ref_id)
               incident_id, brief_fingerprint, ref_id
        from incident_fix_matches
        where workspace_id = ${workspaceId}
        order by incident_id, brief_fingerprint, ref_id, generated_at desc
        limit ${limit}
      `) as unknown as { incident_id: string; brief_fingerprint: string; ref_id: string }[];
      return rows;
    },
    listSharedCards: async (workspaceId) => {
      const { realMatchStore } = await import("./fix-matches");
      const store = await realMatchStore();
      const cards = await store.loadCards(workspaceId).catch(() => []);
      const sql = await requireSql();
      const sup = (await sql`
        select id, superseded_by_fix_card_id from fix_cards
        where workspace_id = ${workspaceId} and status = 'superseded'
      `) as unknown as { id: string; superseded_by_fix_card_id: string | null }[];
      const byId = new Map(sup.map((s) => [s.id, s.superseded_by_fix_card_id]));
      return cards.map((c) => ({ ...c, supersededBy: null as string | null })).concat(
        [...byId.entries()].map(([id, sup2]) => ({
          id,
          status: "superseded",
          text: "",
          resolved: null as boolean | null,
          createdAt: "",
          blobId: null as string | null,
          supersededBy: sup2,
        })),
      );
    },
    getCard: async (cardId, workspaceId) => {
      const { getFixCardForWorkspace } = await import("./support-ops");
      const c = await getFixCardForWorkspace(cardId, workspaceId).catch(() => null);
      return c ? { id: c.id, status: c.status, text: (c.reviewed_text ?? c.candidate_text ?? "") } : null;
    },
    listMemoryLinks: async (workspaceId) => {
      const { realMemoryStore } = await import("./operator-memory");
      void realMemoryStore;
      // Workspace-scoped links via direct query (store lists by other keys).
      const sql = await requireSql();
      const rows = (await sql`
        select id, incident_id, workspace_id, postmortem_id, fix_card_id, verified
        from incident_memory_links
        where workspace_id = ${workspaceId}
        order by created_at desc limit 50
      `) as unknown as { id: string; incident_id: string; workspace_id: string; postmortem_id: string; fix_card_id: string; verified: boolean }[];
      return rows.map((r) => ({ id: r.id, incident_id: r.incident_id, postmortem_id: r.postmortem_id, fix_card_id: r.fix_card_id, verified: !!r.verified }));
    },
  };
}

/** Explicit operator repair for stale provenance links (audited, never silent). */
export async function repairProvenanceLink(
  linkId: string,
  workspaceId: string,
  actorUserId: string,
): Promise<{ action: "repaired"; cardId: string } | { action: "deferred"; reason: string }> {
  try {
    const sql = await requireSql();
    const links = (await sql`
      select id, incident_id, postmortem_id, fix_card_id from incident_memory_links
      where id = ${linkId} and workspace_id = ${workspaceId} limit 1
    `) as unknown as { id: string; incident_id: string; postmortem_id: string; fix_card_id: string }[];
    if (!links[0]) return { action: "deferred", reason: "memory link not found" };
    const { getFixCardForWorkspace } = await import("./support-ops");
    const old = await getFixCardForWorkspace(links[0].fix_card_id, workspaceId).catch(() => null);
    if (!old || old.status !== "superseded" || !old.superseded_by_fix_card_id) {
      return { action: "deferred", reason: "link is not stale (card not superseded by a revision)" };
    }
    const next = await getFixCardForWorkspace(old.superseded_by_fix_card_id, workspaceId).catch(() => null);
    if (!next || next.status !== "shared") {
      return { action: "deferred", reason: "successor card is not active shared memory" };
    }
    await sql`
      update incident_memory_links set fix_card_id = ${next.id}
      where id = ${linkId} and workspace_id = ${workspaceId}
    `;
    const { recordEvent } = await import("./incidents");
    await recordEvent({
      incidentId: links[0].incident_id,
      kind: "memory_provenance_repaired",
      actorUserId,
      detail: { postmortemId: links[0].postmortem_id, from: old.id, to: next.id },
    }).catch(() => null);
    return { action: "repaired", cardId: next.id };
  } catch (e) {
    return { action: "deferred", reason: e instanceof Error ? e.message : "repair failed" };
  }
}
