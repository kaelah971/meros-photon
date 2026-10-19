import "server-only";
import { randomUUID } from "node:crypto";
import type { ChatTurn } from "./gemini";

// P8 persistent support operations. Neon is PRODUCT STATE ONLY:
// conversations, messages, issues, Fix Card metadata. Walrus remains the
// long-term AI memory store; provenance blobs below are references only.

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

export type ConversationRow = {
  id: string;
  workspace_id: string;
  customer_id: string;
  status: "open" | "resolved";
  title: string;
  created_at: string;
  updated_at: string;
  last_message_at: string | null;
  resolved_at: string | null;
};

export type MessageRow = {
  id: string;
  conversation_id: string;
  client_id: string | null;
  role: "user" | "assistant";
  content: string;
  model: string | null;
  /** Who authored an assistant message: model output vs staff operator. */
  author_kind: "ai" | "staff";
  memory_private_used: boolean;
  memory_shared_used: boolean;
  memory_knowledge_used: boolean;
  memory_provenance: ProvenanceItem[] | null;
  attachments?: { filename: string; mimeType: string; kind: string }[] | null;
  created_at: string;
};

export type ProvenanceItem = {
  plane: "private" | "shared" | "knowledge";
  text: string;
  blobId: string;
  distance: number;
};

export type IssueRow = {
  id: string;
  workspace_id: string;
  customer_id: string;
  conversation_id: string;
  status: "open" | "resolved";
  title: string;
  resolution_summary: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
};

export type FixCardStatus = "pending_review" | "shared" | "kept_private" | "failed" | "superseded";

export type FixCardRow = {
  id: string;
  workspace_id: string;
  customer_id: string;
  conversation_id: string | null;
  issue_id: string | null;
  candidate_text: string;
  reviewed_text: string | null;
  superseded_by_fix_card_id: string | null;
  status: FixCardStatus;
  walrus_blob_id: string | null;
  created_at: string;
  reviewed_at: string | null;
  reviewed_by_user_id: string | null;
};

export function titleFromMessage(message: string): string {
  const oneLine = message.replace(/\s+/g, " ").trim();
  return oneLine.length > 80 ? `${oneLine.slice(0, 77)}…` : oneLine || "Support conversation";
}

/** Create conversation + its primary OPEN issue. Zero Walrus writes. */
export async function createConversation(input: {
  workspaceId: string;
  customerId: string;
  title: string;
}): Promise<{ conversation: ConversationRow; issue: IssueRow }> {
  const sql = await requireSql();
  const conv = (await sql`
    insert into conversations (workspace_id, customer_id, title)
    values (${input.workspaceId}, ${input.customerId}, ${input.title})
    returning id, workspace_id, customer_id, status, title, created_at, updated_at, last_message_at, resolved_at
  `) as unknown as ConversationRow[];
  const conversation = conv[0];
  if (!conversation) throw new Error("conversation insert failed");
  const iss = (await sql`
    insert into support_issues (workspace_id, customer_id, conversation_id, title)
    values (${input.workspaceId}, ${input.customerId}, ${conversation.id}, ${input.title})
    returning id, workspace_id, customer_id, conversation_id, status, title, resolution_summary, created_at, updated_at, resolved_at
  `) as unknown as IssueRow[];
  const issue = iss[0];
  if (!issue) throw new Error("issue insert failed");
  return { conversation, issue };
}

/** Load a conversation ONLY if it belongs to this exact workspace+customer. */
export async function getConversationForCustomer(
  conversationId: string,
  workspaceId: string,
  customerId: string,
): Promise<ConversationRow | null> {
  const sql = await requireSql();
  const rows = (await sql`
    select id, workspace_id, customer_id, status, title, created_at, updated_at, last_message_at, resolved_at
    from conversations
    where id = ${conversationId} and workspace_id = ${workspaceId} and customer_id = ${customerId}
    limit 1
  `) as unknown as ConversationRow[];
  return rows[0] ?? null;
}

/**
 * Persist a USER message. Idempotent on (conversation_id, client_id):
 * a retried send returns the existing row instead of duplicating.
 */
export async function addUserMessage(input: {
  conversationId: string;
  content: string;
  clientId?: string | null;
  attachments?: { filename: string; mimeType: string; kind: string }[];
}): Promise<{ id: string; deduped: boolean; clientId: string }> {
  const sql = await requireSql();
  const clientId = input.clientId?.trim() || randomUUID();
  const rows = (await sql`
    insert into messages (conversation_id, client_id, role, content, attachments)
    values (${input.conversationId}, ${clientId}, 'user', ${input.content}, ${JSON.stringify(input.attachments ?? [])})
    on conflict (conversation_id, client_id) do nothing
    returning id
  `) as unknown as { id: string }[];
  if (rows[0]) {
    await sql`update conversations set last_message_at = now(), updated_at = now() where id = ${input.conversationId}`;
    return { id: rows[0].id, deduped: false, clientId };
  }
  const existing = (await sql`
    select id from messages
    where conversation_id = ${input.conversationId} and client_id = ${clientId} limit 1
  `) as unknown as { id: string }[];
  if (!existing[0]) throw new Error("message persist failed");
  return { id: existing[0].id, deduped: true, clientId };
}

/**
 * Find one persisted message by its idempotency key (any role). Lets a
 * retried answer resume an already-stored assistant reply instead of
 * generating (and billing/storing) a duplicate after an ambiguous outcome.
 */
export async function findMessageByClientId(
  conversationId: string,
  clientId: string,
): Promise<{
  id: string;
  role: string;
  content: string;
  provenance: { plane: string; text: string; blobId: string; distance: number }[];
} | null> {
  const sql = await requireSql();
  const rows = (await sql`
    select id, role, content, memory_provenance
    from messages
    where conversation_id = ${conversationId} and client_id = ${clientId}
    limit 1
  `) as unknown as { id: string; role: string; content: string; memory_provenance: unknown }[];
  const row = rows[0];
  if (!row) return null;
  let provenance: { plane: string; text: string; blobId: string; distance: number }[] = [];
  try {
    const raw = typeof row.memory_provenance === "string" ? JSON.parse(row.memory_provenance) : row.memory_provenance;
    if (Array.isArray(raw)) provenance = raw as typeof provenance;
  } catch {
    provenance = [];
  }
  return { id: row.id, role: row.role, content: row.content, provenance };
}

export async function addAssistantMessage(input: {
  conversationId: string;
  content: string;
  model: string | null;
  privateUsed: boolean;
  sharedUsed: boolean;
  knowledgeUsed: boolean;
  provenance: ProvenanceItem[];
  /** Client-supplied idempotency key; retried sends reuse the same row. */
  clientId?: string | null;
  /** Staff-authored replies are marked so customers and audits can tell them apart from model output. */
  authorKind?: "ai" | "staff";
}): Promise<string> {
  const sql = await requireSql();
  const clientId = (input.clientId ?? "").trim() || randomUUID();
  const rows = (await sql`
    insert into messages (conversation_id, client_id, role, content, model, author_kind, memory_private_used, memory_shared_used, memory_knowledge_used, memory_provenance)
    values (${input.conversationId}, ${clientId}, 'assistant', ${input.content}, ${input.model}, ${input.authorKind ?? "ai"}, ${input.privateUsed}, ${input.sharedUsed}, ${input.knowledgeUsed}, ${JSON.stringify(input.provenance)})
    on conflict (conversation_id, client_id) do nothing
    returning id
  `) as unknown as { id: string }[];
  if (rows[0]) {
    await sql`update conversations set last_message_at = now(), updated_at = now() where id = ${input.conversationId}`;
    return rows[0].id;
  }
  const existing = (await sql`
    select id from messages where conversation_id = ${input.conversationId} and client_id = ${clientId} limit 1
  `) as unknown as { id: string }[];
  if (!existing[0]) throw new Error("assistant message persist failed");
  return existing[0].id;
}

/** Bounded recent turns for model context — Neon history, never the browser transcript. */
export async function listRecentTurns(
  conversationId: string,
  limit = 12,
): Promise<ChatTurn[]> {
  const sql = await requireSql();
  const rows = (await sql`
    select role, content from messages
    where conversation_id = ${conversationId}
    order by created_at desc, id desc limit ${limit}
  `) as unknown as { role: string; content: string }[];
  return rows
    .reverse()
    .filter((r) => (r.role === "user" || r.role === "assistant") && r.content.trim())
    .map((r) => ({ role: r.role as "user" | "assistant", text: r.content }));
}

export async function listMessages(conversationId: string): Promise<MessageRow[]> {
  const sql = await requireSql();
  return (await sql`
    select id, conversation_id, client_id, role, content, model, author_kind,
           memory_private_used, memory_shared_used, memory_knowledge_used, memory_provenance, attachments, created_at
    from messages where conversation_id = ${conversationId}
    order by created_at, id
  `) as unknown as MessageRow[];
}

export async function listCustomerConversations(
  workspaceId: string,
  customerId: string,
): Promise<ConversationRow[]> {
  const sql = await requireSql();
  return (await sql`
    select id, workspace_id, customer_id, status, title, created_at, updated_at, last_message_at, resolved_at
    from conversations
    where workspace_id = ${workspaceId} and customer_id = ${customerId}
    order by coalesce(last_message_at, created_at) desc
  `) as unknown as ConversationRow[];
}

/** Explicit resolution only: marks conversation + issue resolved together. */
export async function resolveConversation(
  conversationId: string,
  resolutionSummary: string | null,
): Promise<IssueRow> {
  const sql = await requireSql();
  await sql`
    update conversations set status = 'resolved', resolved_at = coalesce(resolved_at, now()), updated_at = now()
    where id = ${conversationId}
  `;
  const rows = (await sql`
    update support_issues
    set status = 'resolved', resolved_at = coalesce(resolved_at, now()), updated_at = now(),
        resolution_summary = coalesce(${resolutionSummary}, resolution_summary)
    where conversation_id = ${conversationId}
    returning id, workspace_id, customer_id, conversation_id, status, title, resolution_summary, created_at, updated_at, resolved_at
  `) as unknown as IssueRow[];
  const issue = rows[0];
  if (!issue) throw new Error("issue not found for conversation");
  return issue;
}

export async function createPendingFixCard(input: {
  workspaceId: string;
  customerId: string;
  conversationId: string;
  issueId: string | null;
  candidateText: string;
}): Promise<FixCardRow> {
  const sql = await requireSql();
  const rows = (await sql`
    insert into fix_cards (workspace_id, customer_id, conversation_id, issue_id, candidate_text)
    values (${input.workspaceId}, ${input.customerId}, ${input.conversationId}, ${input.issueId}, ${input.candidateText})
    returning id, workspace_id, customer_id, conversation_id, issue_id, candidate_text, reviewed_text, status, walrus_blob_id, created_at, reviewed_at, reviewed_by_user_id, superseded_by_fix_card_id
  `) as unknown as FixCardRow[];
  const row = rows[0];
  if (!row) throw new Error("fix card insert failed");
  return row;
}

/** Load a Fix Card ONLY within its workspace (console scoping). */
export async function getFixCardForWorkspace(
  fixCardId: string,
  workspaceId: string,
): Promise<FixCardRow | null> {
  const sql = await requireSql();
  const rows = (await sql`
    select id, workspace_id, customer_id, conversation_id, issue_id, candidate_text, reviewed_text, status, walrus_blob_id, created_at, reviewed_at, reviewed_by_user_id, superseded_by_fix_card_id
    from fix_cards where id = ${fixCardId} and workspace_id = ${workspaceId} limit 1
  `) as unknown as FixCardRow[];
  return rows[0] ?? null;
}

export async function listFixCards(
  workspaceId: string,
  status?: FixCardStatus,
): Promise<FixCardRow[]> {
  const sql = await requireSql();
  if (status) {
    return (await sql`
      select id, workspace_id, customer_id, conversation_id, issue_id, candidate_text, reviewed_text, status, walrus_blob_id, created_at, reviewed_at, reviewed_by_user_id, superseded_by_fix_card_id
      from fix_cards where workspace_id = ${workspaceId} and status = ${status}
      order by created_at desc
    `) as unknown as FixCardRow[];
  }
  return (await sql`
    select id, workspace_id, customer_id, conversation_id, issue_id, candidate_text, reviewed_text, status, walrus_blob_id, created_at, reviewed_at, reviewed_by_user_id, superseded_by_fix_card_id
    from fix_cards where workspace_id = ${workspaceId}
    order by created_at desc
  `) as unknown as FixCardRow[];
}

export async function markFixCardShared(
  fixCardId: string,
  blobId: string,
  reviewerId: string,
  // The exact staff-reviewed text written to shared memory (undefined when
  // the generated candidate was shared unedited).
  reviewedText?: string,
): Promise<void> {
  const sql = await requireSql();
  await sql`
    update fix_cards set status = 'shared', walrus_blob_id = ${blobId},
      reviewed_text = ${reviewedText ?? null},
      reviewed_at = now(), reviewed_by_user_id = ${reviewerId}
    where id = ${fixCardId}
  `;
}

export async function markFixCardKeptPrivate(
  fixCardId: string,
  reviewerId: string,
): Promise<void> {
  const sql = await requireSql();
  await sql`
    update fix_cards set status = 'kept_private',
      reviewed_at = now(), reviewed_by_user_id = ${reviewerId}
    where id = ${fixCardId}
  `;
}

export async function markFixCardFailed(fixCardId: string): Promise<void> {
  const sql = await requireSql();
  await sql`update fix_cards set status = 'failed' where id = ${fixCardId}`;
}

/**
 * Shared-fix correction: insert the corrected version as a NEW row (status
 * shared, own Walrus blob) and mark the old row superseded. The old blob id
 * stays on the old row for audit; Walrus blobs are never deleted/edited.
 */
export async function createSharedFixCardRevision(input: {
  workspaceId: string;
  customerId: string;
  conversationId: string | null;
  issueId: string | null;
  candidateText: string;
  reviewedText: string;
  blobId: string;
  reviewerId: string;
}): Promise<FixCardRow> {
  const sql = await requireSql();
  const rows = (await sql`
    insert into fix_cards (workspace_id, customer_id, conversation_id, issue_id, candidate_text, reviewed_text, status, walrus_blob_id, reviewed_by_user_id)
    values (${input.workspaceId}, ${input.customerId}, ${input.conversationId}, ${input.issueId}, ${input.candidateText}, ${input.reviewedText}, 'shared', ${input.blobId}, ${input.reviewerId})
    returning id, workspace_id, customer_id, conversation_id, issue_id, candidate_text, reviewed_text, status, walrus_blob_id, created_at, reviewed_at, reviewed_by_user_id, superseded_by_fix_card_id
  `) as unknown as FixCardRow[];
  const row = rows[0];
  if (!row) throw new Error("fix card revision insert failed");
  return row;
}

export async function markFixCardSuperseded(
  fixCardId: string,
  supersededById: string,
  reviewerId: string,
): Promise<void> {
  const sql = await requireSql();
  await sql`
    update fix_cards set status = 'superseded', superseded_by_fix_card_id = ${supersededById},
      reviewed_at = now(), reviewed_by_user_id = ${reviewerId}
    where id = ${fixCardId} and status = 'shared'
  `;
}

/** Blob ids of superseded shared fixes in ONE workspace (deny-list for recall). */
export async function listSupersededSharedBlobs(workspaceId: string): Promise<string[]> {
  const sql = await requireSql();
  const rows = (await sql`
    select walrus_blob_id from fix_cards
    where workspace_id = ${workspaceId} and status = 'superseded' and walrus_blob_id is not null
  `) as unknown as { walrus_blob_id: string | null }[];
  return rows.map((r) => r.walrus_blob_id).filter((b): b is string => !!b);
}

// ---- Staff-scoped console reads (all keyed by workspace; callers must pass
// a membership-checked workspace id — see requireStaff below) ----

export type WorkspaceStats = {
  openIssues: number;
  customers: number;
  conversations: number;
  pendingFixCards: number;
  sharedFixes: number;
};

export async function getWorkspaceStats(workspaceId: string): Promise<WorkspaceStats> {
  const sql = await requireSql();
  const r = (await sql`
    select
      (select count(*)::int from support_issues where workspace_id = ${workspaceId} and status = 'open') as open_issues,
      (select count(*)::int from customers where workspace_id = ${workspaceId}) as customers,
      (select count(*)::int from conversations where workspace_id = ${workspaceId}) as conversations,
      (select count(*)::int from fix_cards where workspace_id = ${workspaceId} and status = 'pending_review') as pending,
      (select count(*)::int from fix_cards where workspace_id = ${workspaceId} and status = 'shared') as shared
  `) as unknown as { open_issues: number; customers: number; conversations: number; pending: number; shared: number }[];
  const s = r[0] ?? { open_issues: 0, customers: 0, conversations: 0, pending: 0, shared: 0 };
  return {
    openIssues: s.open_issues,
    customers: s.customers,
    conversations: s.conversations,
    pendingFixCards: s.pending,
    sharedFixes: s.shared,
  };
}

/** Single conversation scoped to a workspace (staff view, any customer). */
export async function getWorkspaceConversation(
  workspaceId: string,
  conversationId: string,
): Promise<WorkspaceConversationRow | null> {
  const sql = await requireSql();
  const rows = (await sql`
    select c.id, c.workspace_id, c.customer_id, c.status, c.title, c.created_at, c.updated_at,
           c.last_message_at, c.resolved_at,
           coalesce(cu.display_name, left(cu.id, 8)) as customer_display
    from conversations c left join customers cu on cu.id = c.customer_id
    where c.id = ${conversationId} and c.workspace_id = ${workspaceId} limit 1
  `) as unknown as WorkspaceConversationRow[];
  return rows[0] ?? null;
}

export type WorkspaceConversationRow = ConversationRow & {
  customer_display: string | null;
};

export async function listWorkspaceConversations(
  workspaceId: string,
): Promise<WorkspaceConversationRow[]> {
  const sql = await requireSql();
  return (await sql`
    select c.id, c.workspace_id, c.customer_id, c.status, c.title, c.created_at, c.updated_at,
           c.last_message_at, c.resolved_at,
           coalesce(cu.display_name, left(cu.id, 8)) as customer_display
    from conversations c left join customers cu on cu.id = c.customer_id
    where c.workspace_id = ${workspaceId}
    order by coalesce(c.last_message_at, c.created_at) desc limit 100
  `) as unknown as WorkspaceConversationRow[];
}

export type WorkspaceCustomerRow = {
  id: string;
  display_name: string | null;
  conversations: number;
  open_issues: number;
  last_activity: string | null;
};

export async function listWorkspaceCustomers(workspaceId: string): Promise<WorkspaceCustomerRow[]> {
  const sql = await requireSql();
  return (await sql`
    select cu.id, cu.display_name,
      (select count(*)::int from conversations c where c.customer_id = cu.id) as conversations,
      (select count(*)::int from support_issues i where i.customer_id = cu.id and i.status = 'open') as open_issues,
      (select max(coalesce(c.last_message_at, c.created_at)) from conversations c where c.customer_id = cu.id) as last_activity
    from customers cu where cu.workspace_id = ${workspaceId}
    order by last_activity desc nulls last limit 200
  `) as unknown as WorkspaceCustomerRow[];
}

/** Staff-safe customer contact: display name + login email for the console. */
export async function getCustomerContact(customerId: string): Promise<{
  displayName: string | null;
  email: string | null;
}> {
  const sql = await requireSql();
  const rows = (await sql`
    select cu.display_name, u.email
    from customers cu left join "user" u on u.id = cu.auth_user_id
    where cu.id = ${customerId} limit 1
  `) as unknown as { display_name: string | null; email: string | null }[];
  const r = rows[0];
  return { displayName: r?.display_name ?? null, email: r?.email ?? null };
}

const STAFF_ROLES = new Set(["owner", "admin", "support"]);

/**
 * Staff gate: Better Auth user → organization_members → this workspace's org.
 * Throws 403 for non-members; role must be owner/admin/support.
 */
export async function requireStaff(
  userId: string,
  workspaceId: string,
): Promise<{ organizationId: string; role: string }> {
  const { dbAvailable, getMembership, getWorkspaceById } = await import("./db");
  if (!(await dbAvailable())) throw Object.assign(new Error("database unavailable"), { status: 503 });
  // Resolve org via a direct workspace-id lookup (no slug trust involved).
  const ws = await getWorkspaceById(workspaceId);
  if (!ws) throw Object.assign(new Error("workspace not found"), { status: 404 });
  const membership = await getMembership(userId, ws.organization_id);
  if (!membership || !STAFF_ROLES.has(membership.role)) {
    throw Object.assign(new Error("staff access required"), { status: 403 });
  }
  return { organizationId: ws.organization_id, role: membership.role };
}
