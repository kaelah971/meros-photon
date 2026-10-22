import "server-only";

// S5 durable candidate clusters: reviewable suggestions, never incidents.
// Confirmation stays human via the S4 domain (createIncident /
// addIncidentConversation). Evidence is reference-only: message and
// conversation rows stay canonical in their own tables.

type Sql = <T = Record<string, unknown>[]>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<T>;

async function getSql(): Promise<Sql | null> {
  const { dbAvailable } = await import("./db");
  if (!(await dbAvailable())) return null;
  const { neon } = await import("@neondatabase/serverless");
  const url = process.env.DATABASE_URL!.trim();
  return neon(url) as unknown as Sql;
}

async function requireSql(): Promise<Sql> {
  const sql = await getSql();
  if (!sql) throw Object.assign(new Error("database unavailable"), { status: 503 });
  return sql;
}

export type CandidateStatus = "pending" | "accepted" | "dismissed";
export type CandidateConfidence = "low" | "medium" | "high";

export type CandidateRow = {
  id: string;
  workspace_id: string;
  title: string;
  summary: string;
  status: CandidateStatus;
  confidence: CandidateConfidence;
  rationale: string;
  accepted_incident_id: string | null;
  dismissed_at: string | null;
  dismissed_by_user_id: string | null;
  dismissal_note: string | null;
  first_seen_at: string;
  last_seen_at: string;
  updated_at: string;
  created_at: string;
};

export type CandidateSummary = CandidateRow & {
  conversation_count: number;
  customer_count: number;
  message_count: number;
};

/** Surfaced for review only with >= 2 distinct conversations. */
export const SURFACE_MIN_CONVERSATIONS = 2;

export async function createCandidate(input: {
  workspaceId: string;
  title: string;
  summary: string;
  confidence: CandidateConfidence;
  rationale: string;
}): Promise<CandidateRow> {
  const title = input.title.trim().replace(/\s+/g, " ").slice(0, 160);
  if (!title) throw Object.assign(new Error("candidate title is required"), { status: 400 });
  if (!["low", "medium", "high"].includes(input.confidence)) {
    throw Object.assign(new Error("unknown confidence"), { status: 400 });
  }
  const sql = await requireSql();
  const rows = (await sql`
    insert into issue_candidates (workspace_id, title, summary, confidence, rationale)
    values (${input.workspaceId}, ${title}, ${input.summary.slice(0, 2000)}, ${input.confidence}, ${input.rationale.slice(0, 2000)})
    returning id, workspace_id, title, summary, status, confidence, rationale,
      accepted_incident_id, dismissed_at, dismissed_by_user_id, dismissal_note,
      first_seen_at, last_seen_at, updated_at, created_at
  `) as unknown as CandidateRow[];
  if (!rows[0]) throw new Error("candidate insert failed");
  return rows[0];
}

export async function getCandidateForWorkspace(
  workspaceId: string,
  candidateId: string,
): Promise<CandidateSummary | null> {
  const sql = await requireSql();
  const rows = (await sql`
    select c.id, c.workspace_id, c.title, c.summary, c.status, c.confidence, c.rationale,
           c.accepted_incident_id, c.dismissed_at, c.dismissed_by_user_id, c.dismissal_note,
           c.first_seen_at, c.last_seen_at, c.updated_at, c.created_at,
      (select count(*)::int from issue_candidate_members m where m.candidate_id = c.id) as conversation_count,
      (select count(distinct m.customer_id)::int from issue_candidate_members m where m.candidate_id = c.id) as customer_count,
      (select count(*)::int from issue_candidate_messages g where g.candidate_id = c.id) as message_count
    from issue_candidates c
    where c.id = ${candidateId} and c.workspace_id = ${workspaceId}
    limit 1
  `) as unknown as CandidateSummary[];
  return rows[0] ?? null;
}

export type CandidateListItem = CandidateSummary & { surfaced: boolean };

/**
 * Review queue: surfaced pending candidates first (ready for operator
 * review), then pending singletons (still gathering), then decided ones.
 * Callers filter by status; surfaced-only is the default review view.
 */
export async function listCandidates(
  workspaceId: string,
  opts?: { status?: CandidateStatus | null; surfacedOnly?: boolean },
): Promise<CandidateListItem[]> {
  const sql = await requireSql();
  const status = opts?.status ?? null;
  const rows = (await (
    status
      ? sql`
        select c.id, c.workspace_id, c.title, c.summary, c.status, c.confidence, c.rationale,
               c.accepted_incident_id, c.dismissed_at, c.dismissed_by_user_id, c.dismissal_note,
               c.first_seen_at, c.last_seen_at, c.updated_at, c.created_at,
          (select count(*)::int from issue_candidate_members m where m.candidate_id = c.id) as conversation_count,
          (select count(distinct m.customer_id)::int from issue_candidate_members m where m.candidate_id = c.id) as customer_count,
          (select count(*)::int from issue_candidate_messages g where g.candidate_id = c.id) as message_count
        from issue_candidates c
        where c.workspace_id = ${workspaceId} and c.status = ${status}
        order by c.last_seen_at desc limit 100
      `
      : sql`
        select c.id, workspace_id, c.title, c.summary, c.status, c.confidence, c.rationale,
               c.accepted_incident_id, c.dismissed_at, c.dismissed_by_user_id, c.dismissal_note,
               c.first_seen_at, c.last_seen_at, c.updated_at, c.created_at,
          (select count(*)::int from issue_candidate_members m where m.candidate_id = c.id) as conversation_count,
          (select count(distinct m.customer_id)::int from issue_candidate_members m where m.candidate_id = c.id) as customer_count,
          (select count(*)::int from issue_candidate_messages g where g.candidate_id = c.id) as message_count
        from issue_candidates c
        where c.workspace_id = ${workspaceId}
        order by c.last_seen_at desc limit 100
      `
  ) as unknown as CandidateSummary[]);
  return rows
    .map((r) => ({
      ...r,
      surfaced: r.status === "pending" && r.conversation_count >= SURFACE_MIN_CONVERSATIONS,
    }))
    .filter((r) => (opts?.surfacedOnly ? r.surfaced : true))
    .sort((a, b) => {
      // Surfaced pending first, then by recency — the review queue order.
      const rank = (r: CandidateListItem) => (r.surfaced ? 0 : r.status === "pending" ? 1 : 2);
      return rank(a) - rank(b) || +new Date(b.last_seen_at) - +new Date(a.last_seen_at);
    });
}

/** Has this exact message already been clustered anywhere in the workspace? */
export async function messageAlreadyClustered(
  workspaceId: string,
  messageId: string,
): Promise<{ candidateId: string } | null> {
  const sql = await requireSql();
  const rows = (await sql`
    select g.candidate_id from issue_candidate_messages g
    join issue_candidates c on c.id = g.candidate_id
    where g.message_id = ${messageId} and c.workspace_id = ${workspaceId}
    limit 1
  `) as unknown as { candidate_id: string }[];
  return rows[0] ? { candidateId: rows[0].candidate_id } : null;
}

export type UnclusteredMessage = {
  messageId: string;
  conversationId: string;
  customerId: string;
  text: string;
  createdAt: string;
};

/**
 * Recent persisted customer reports with no incident attribution yet —
 * the recovery set for deferred detection. Oldest first (fairness),
 * strictly bounded, workspace-scoped. Never invents: only persisted
 * messages with verified conversation/customer links are returned.
 */
export async function listUnclusteredRecentMessages(
  workspaceId: string,
  input: { sinceIso: string; excludeMessageIds?: readonly string[]; limit?: number },
): Promise<UnclusteredMessage[]> {
  const sql = await requireSql();
  const limit = Math.min(Math.max(input.limit ?? 3, 1), 10);
  const exclude = [...new Set((input.excludeMessageIds ?? []).filter((id) => typeof id === "string" && id.length > 0))].slice(0, 20);
  const rows = (await (exclude.length > 0
    ? sql`
      select m.id as message_id, m.conversation_id, c.customer_id, m.content as text, m.created_at
      from messages m
      join conversations c on c.id = m.conversation_id
      where c.workspace_id = ${workspaceId} and m.role = 'user' and m.created_at >= ${input.sinceIso}
        and not (m.id = any(${exclude}))
        and not exists (select 1 from issue_candidate_messages g where g.message_id = m.id)
      order by m.created_at asc limit ${limit}
    `
    : sql`
      select m.id as message_id, m.conversation_id, c.customer_id, m.content as text, m.created_at
      from messages m
      join conversations c on c.id = m.conversation_id
      where c.workspace_id = ${workspaceId} and m.role = 'user' and m.created_at >= ${input.sinceIso}
        and not exists (select 1 from issue_candidate_messages g where g.message_id = m.id)
      order by m.created_at asc limit ${limit}
    `)) as unknown as { message_id: string; conversation_id: string; customer_id: string; text: unknown; created_at: unknown }[];
  return rows
    .filter((r) => typeof r.text === "string" && r.text.trim().length > 0)
    .map((r) => ({
      messageId: r.message_id,
      conversationId: r.conversation_id,
      customerId: r.customer_id,
      text: r.text as string,
      createdAt: new Date(r.created_at as string).toISOString(),
    }));
}

/** Pending candidates this conversation already belongs to (stickiness). */
export async function pendingCandidatesForConversation(
  workspaceId: string,
  conversationId: string,
): Promise<CandidateSummary[]> {
  const sql = await requireSql();
  return (await sql`
    select c.id, c.workspace_id, c.title, c.summary, c.status, c.confidence, c.rationale,
           c.accepted_incident_id, c.dismissed_at, c.dismissed_by_user_id, c.dismissal_note,
           c.first_seen_at, c.last_seen_at, c.updated_at, c.created_at,
      (select count(*)::int from issue_candidate_members m where m.candidate_id = c.id) as conversation_count,
      (select count(distinct m.customer_id)::int from issue_candidate_members m where m.candidate_id = c.id) as customer_count,
      (select count(*)::int from issue_candidate_messages g where g.candidate_id = c.id) as message_count
    from issue_candidates c
    join issue_candidate_members m on m.candidate_id = c.id and m.conversation_id = ${conversationId}
    where c.workspace_id = ${workspaceId} and c.status = 'pending'
    order by c.last_seen_at desc
  `) as unknown as CandidateSummary[];
}

/** Recent pending candidates with member excerpts for the judge (bounded). */
export type CandidateContext = {
  id: string;
  title: string;
  summary: string;
  confidence: CandidateConfidence;
  excerpts: string[];
};

export async function pendingCandidateContexts(
  workspaceId: string,
  limit = 10,
): Promise<CandidateContext[]> {
  const sql = await requireSql();
  const cands = (await sql`
    select id, title, summary, confidence from issue_candidates
    where workspace_id = ${workspaceId} and status = 'pending'
    order by last_seen_at desc limit ${limit}
  `) as unknown as { id: string; title: string; summary: string; confidence: CandidateConfidence }[];
  const out: CandidateContext[] = [];
  for (const c of cands) {
    const msgs = (await sql`
      select m.content from issue_candidate_messages g
      join messages m on m.id = g.message_id
      where g.candidate_id = ${c.id}
      order by g.added_at desc limit 3
    `) as unknown as { content: string }[];
    out.push({
      id: c.id,
      title: c.title,
      summary: c.summary,
      confidence: c.confidence,
      excerpts: msgs.map((m) => m.content.slice(0, 300)),
    });
  }
  return out;
}

/** Dismissed candidate titles for the regen guard (no excerpts needed). */
export async function dismissedCandidateTitles(
  workspaceId: string,
  limit = 20,
): Promise<{ id: string; title: string }[]> {
  const sql = await requireSql();
  return (await sql`
    select id, title from issue_candidates
    where workspace_id = ${workspaceId} and status = 'dismissed'
    order by dismissed_at desc nulls last, updated_at desc limit ${limit}
  `) as unknown as { id: string; title: string }[];
}

/**
 * Attribute one message to a candidate. Idempotent on
 * (candidate, message): retries return the existing link. Adding the
 * conversation is implied; customer counts derive from membership rows.
 * The UNIQUE message guard makes attribution exclusive: a concurrent
 * delivery loses here, re-reads the winner via duplicateOf, and must NOT
 * create another candidate — callers clean up any orphan they just made.
 */
export async function addMessageToCandidate(input: {
  candidateId: string;
  workspaceId: string;
  messageId: string;
  conversationId: string;
  customerId: string;
  /**
   * Attribution time override for deferred-report recovery. The ORIGINAL
   * report timestamp keeps Radar eligibility windows honest; absent, the
   * database records attribution time (live path). Must be a valid ISO
   * timestamp when provided — invalid values fall back to now().
   */
  addedAt?: string;
}): Promise<{ memberAdded: boolean; messageAdded: boolean; duplicateOf: string | null }> {
  const sql = await requireSql();
  const cand = (await sql`
    select id, status from issue_candidates
    where id = ${input.candidateId} and workspace_id = ${input.workspaceId} limit 1
  `) as unknown as { id: string; status: string }[];
  if (!cand[0]) throw Object.assign(new Error("candidate not found"), { status: 404 });
  if (cand[0].status !== "pending") {
    throw Object.assign(new Error("candidate is already decided"), { status: 409 });
  }
  // Verify the records exist in this workspace (never invent attribution).
  const msg = (await sql`
    select m.id, m.conversation_id, c.customer_id from messages m
    join conversations c on c.id = m.conversation_id
    where m.id = ${input.messageId} and c.workspace_id = ${input.workspaceId} limit 1
  `) as unknown as { id: string; conversation_id: string; customer_id: string }[];
  if (!msg[0]) throw Object.assign(new Error("message not found in this workspace"), { status: 404 });
  if (msg[0].conversation_id !== input.conversationId || msg[0].customer_id !== input.customerId) {
    throw Object.assign(new Error("message does not belong to that conversation/customer"), { status: 400 });
  }
  // Honest attribution time: recovery replays use the original report
  // timestamp; anything unparseable falls back to now() rather than
  // failing the attribution.
  const parsedAt = input.addedAt ? Date.parse(input.addedAt) : NaN;
  const at = Number.isFinite(parsedAt) ? new Date(parsedAt).toISOString() : new Date().toISOString();
  const mem = (await sql`
    insert into issue_candidate_members (candidate_id, conversation_id, customer_id, added_at)
    values (${input.candidateId}, ${input.conversationId}, ${input.customerId}, ${at})
    on conflict (candidate_id, conversation_id) do nothing
    returning conversation_id
  `) as unknown as { conversation_id: string }[];
  const g = (await sql`
    insert into issue_candidate_messages (candidate_id, message_id, conversation_id, customer_id, added_at)
    values (${input.candidateId}, ${input.messageId}, ${input.conversationId}, ${input.customerId}, ${at})
    on conflict (message_id) do nothing
    returning message_id
  `) as unknown as { message_id: string }[];
  if (g.length > 0) {
    await sql`
      update issue_candidates set last_seen_at = now(), updated_at = now()
      where id = ${input.candidateId}
    `;
    return { memberAdded: mem.length > 0, messageAdded: true, duplicateOf: null };
  }
  // Lost the exclusive-attribution race (or retried): find the winner.
  const winner = await messageAlreadyClustered(input.workspaceId, input.messageId);
  return { memberAdded: false, messageAdded: false, duplicateOf: winner?.candidateId ?? null };
}

/** Remove an empty candidate (orphan cleanup after losing a creation race). */
export async function deleteCandidate(candidateId: string, workspaceId: string): Promise<void> {
  const sql = await requireSql();
  await sql`delete from issue_candidates where id = ${candidateId} and workspace_id = ${workspaceId}`;
}

export async function markCandidateAccepted(input: {
  candidateId: string;
  workspaceId: string;
  incidentId: string;
  actorUserId?: string | null;
}): Promise<void> {
  const sql = await requireSql();
  const inc = (await sql`
    select id from incidents where id = ${input.incidentId} and workspace_id = ${input.workspaceId} limit 1
  `) as unknown as { id: string }[];
  if (!inc[0]) throw Object.assign(new Error("incident not found in this workspace"), { status: 404 });
  const rows = (await sql`
    update issue_candidates
    set status = 'accepted', accepted_incident_id = ${input.incidentId}, updated_at = now()
    where id = ${input.candidateId} and workspace_id = ${input.workspaceId} and status = 'pending'
    returning id
  `) as unknown as { id: string }[];
  if (!rows[0]) throw Object.assign(new Error("candidate is already decided"), { status: 409 });
}

export async function markCandidateDismissed(input: {
  candidateId: string;
  workspaceId: string;
  actorUserId?: string | null;
  note?: string | null;
}): Promise<void> {
  const sql = await requireSql();
  const rows = (await sql`
    update issue_candidates
    set status = 'dismissed', dismissed_at = now(), dismissed_by_user_id = ${input.actorUserId ?? null},
        dismissal_note = ${input.note?.trim().slice(0, 500) ?? null}, updated_at = now()
    where id = ${input.candidateId} and workspace_id = ${input.workspaceId} and status = 'pending'
    returning id
  `) as unknown as { id: string }[];
  if (!rows[0]) throw Object.assign(new Error("candidate is already decided"), { status: 409 });
}

export type CandidateMemberRow = {
  conversation_id: string;
  customer_id: string;
  title: string | null;
  added_at: string;
};

export async function listCandidateMembers(
  candidateId: string,
  workspaceId: string,
): Promise<CandidateMemberRow[]> {
  const sql = await requireSql();
  return (await sql`
    select m.conversation_id, m.customer_id, c.title, m.added_at
    from issue_candidate_members m
    join conversations c on c.id = m.conversation_id
    join issue_candidates k on k.id = m.candidate_id
    where m.candidate_id = ${candidateId} and k.workspace_id = ${workspaceId}
    order by m.added_at
  `) as unknown as CandidateMemberRow[];
}

export type CandidateMessageRow = {
  message_id: string;
  conversation_id: string;
  customer_id: string;
  content: string;
  created_at: string;
};

export async function listCandidateMessages(
  candidateId: string,
  workspaceId: string,
  limit = 20,
): Promise<CandidateMessageRow[]> {
  const sql = await requireSql();
  return (await sql`
    select g.message_id, g.conversation_id, g.customer_id, m.content, m.created_at
    from issue_candidate_messages g
    join messages m on m.id = g.message_id
    join issue_candidates k on k.id = g.candidate_id
    where g.candidate_id = ${candidateId} and k.workspace_id = ${workspaceId}
    order by g.added_at limit ${limit}
  `) as unknown as CandidateMessageRow[];
}
