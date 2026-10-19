import "server-only";
import { isNeonConfigured } from "./env";

// Neon is operational metadata only (users, sessions, pending jobs, blob refs).
// It is NEVER the durable memory store — Walrus is.

type NeonClient = <T = Record<string, unknown>[]>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<T>;

let cached: NeonClient | null | undefined;

async function getSql(): Promise<NeonClient | null> {
  if (cached !== undefined) return cached;
  if (!isNeonConfigured()) {
    cached = null;
    return null;
  }
  const { neon } = await import("@neondatabase/serverless");
  cached = neon(process.env.DATABASE_URL!.trim()) as unknown as NeonClient;
  return cached;
}

export async function dbAvailable(): Promise<boolean> {
  return (await getSql()) !== null;
}

// NOTE: legacy custom-auth tables platform_users / owner_sessions are RETAINED
// in the database but are NOT runtime auth sources. Owner authentication is
// Better Auth (user/session/account tables); the functions below that read
// the legacy tables were removed with that migration.

export type MemberRow = { organization_id: string; user_id: string; role: string };

export async function addOrganizationMember(input: {
  organizationId: string;
  userId: string;
  role?: string;
}): Promise<void> {
  const sql = await getSql();
  if (!sql) throw new Error("database unavailable");
  await sql`
    insert into organization_members (organization_id, user_id, role)
    values (${input.organizationId}, ${input.userId}, ${input.role ?? "owner"})
    on conflict (organization_id, user_id) do nothing
  `;
}

export async function getUserMemberships(userId: string): Promise<
  { organization_id: string; slug: string; name: string; role: string }[]
> {
  const sql = await getSql();
  if (!sql) return [];
  return (await sql`
    select m.organization_id, o.slug, o.name, m.role
    from organization_members m join organizations o on o.id = m.organization_id
    where m.user_id = ${userId} order by o.created_at
  `) as unknown as { organization_id: string; slug: string; name: string; role: string }[];
}

export async function getMembership(
  userId: string,
  organizationId: string,
): Promise<MemberRow | null> {
  const sql = await getSql();
  if (!sql) return null;
  const rows = (await sql`
    select organization_id, user_id, role from organization_members
    where user_id = ${userId} and organization_id = ${organizationId} limit 1
  `) as unknown as MemberRow[];
  return rows[0] ?? null;
}

export type OwnedWorkspaceRow = WorkspaceRow & { role: string; organization_name: string };

/** Workspaces of an org, ONLY when userId is a member (ownership enforced in SQL). */
export async function getOwnedWorkspaces(
  userId: string,
  organizationId: string,
): Promise<OwnedWorkspaceRow[] | null> {
  const sql = await getSql();
  if (!sql) return null;
  const rows = (await sql`
    select w.id, w.organization_id, w.slug, w.name, w.product_name,
           w.product_description, w.support_context, m.role, o.name as organization_name
    from workspaces w
    join organization_members m on m.organization_id = w.organization_id
    join organizations o on o.id = w.organization_id
    where m.user_id = ${userId} and w.organization_id = ${organizationId}
    order by w.created_at
  `) as unknown as OwnedWorkspaceRow[];
  return rows.length > 0 ? rows : null; // null = no membership (not "empty org")
}

export async function getOwnedWorkspace(
  userId: string,
  slug: string,
): Promise<OwnedWorkspaceRow | null> {
  const sql = await getSql();
  if (!sql) return null;
  const rows = (await sql`
    select w.id, w.organization_id, w.slug, w.name, w.product_name,
           w.product_description, w.support_context, m.role, o.name as organization_name
    from workspaces w
    join organization_members m on m.organization_id = w.organization_id
    join organizations o on o.id = w.organization_id
    where m.user_id = ${userId} and w.slug = ${slug} limit 1
  `) as unknown as OwnedWorkspaceRow[];
  return rows[0] ?? null;
}

export async function createOrganizationWithOwner(input: {
  orgId: string;
  orgSlug: string;
  orgName: string;
  userId: string;
  description?: string | null;
}): Promise<void> {
  const sql = await getSql();
  if (!sql) throw new Error("database unavailable");
  // Best-effort sequential (neon-http has no multi-statement transactions);
  // every step is idempotent so a retry after a partial failure is safe.
  await sql`
    insert into organizations (id, slug, name, description)
    values (${input.orgId}, ${input.orgSlug}, ${input.orgName}, ${input.description ?? null})
    on conflict (id) do update set description = coalesce(excluded.description, organizations.description)
  `;
  await sql`
    insert into organization_members (organization_id, user_id, role)
    values (${input.orgId}, ${input.userId}, 'owner')
    on conflict (organization_id, user_id) do nothing
  `;
}

export async function createWorkspaceRecord(input: {
  id: string;
  organizationId: string;
  slug: string;
  name: string;
  productName: string | null;
  productDescription: string | null;
  supportContext: string | null;
}): Promise<void> {
  const sql = await getSql();
  if (!sql) throw new Error("database unavailable");
  await sql`
    insert into workspaces (id, organization_id, slug, name, product_name, product_description, support_context)
    values (${input.id}, ${input.organizationId}, ${input.slug}, ${input.name},
            ${input.productName}, ${input.productDescription}, ${input.supportContext})
    on conflict (id) do nothing
  `;
}

export type MemoryJobStatus = "pending" | "saving" | "stored" | "failed";

export async function recordMemoryJob(input: {
  userId: string;
  namespace: string;
  type: string;
  text: string;
  status: MemoryJobStatus;
}): Promise<string | null> {
  const sql = await getSql();
  if (!sql) return null;
  const rows = (await sql`
    insert into memory_jobs (user_id, namespace, type, text, status)
    values (${input.userId}, ${input.namespace}, ${input.type}, ${input.text}, ${input.status})
    returning id
  `) as unknown as { id: string }[];
  return rows[0]?.id ?? null;
}

export async function updateMemoryJob(
  id: string,
  patch: { status: MemoryJobStatus; blobId?: string | null; error?: string | null },
): Promise<void> {
  const sql = await getSql();
  if (!sql) return;
  await sql`
    update memory_jobs
    set status = ${patch.status},
        blob_id = coalesce(${patch.blobId ?? null}, blob_id),
        error = ${patch.error ?? null}
    where id = ${id}
  `;
}

export async function ensureUser(input: {
  userId: string;
  accessCodeHash: string;
  namespace: string;
}): Promise<void> {
  const sql = await getSql();
  if (!sql) return;
  await sql`
    insert into users (id, access_code_hash, namespace)
    values (${input.userId}, ${input.accessCodeHash}, ${input.namespace})
    on conflict (id) do update set namespace = excluded.namespace
  `;
}

export type WorkspaceRow = {
  id: string;
  organization_id: string;
  slug: string;
  name: string;
  product_name: string | null;
  product_description: string | null;
  support_context: string | null;
};

export async function getWorkspaceById(id: string): Promise<WorkspaceRow | null> {
  const sql = await getSql();
  if (!sql) return null;
  const rows = (await sql`
    select id, organization_id, slug, name, product_name, product_description, support_context
    from workspaces where id = ${id} limit 1
  `) as unknown as WorkspaceRow[];
  return rows[0] ?? null;
}

export async function getWorkspaceBySlug(slug: string): Promise<WorkspaceRow | null> {
  const sql = await getSql();
  if (!sql) return null;
  const rows = (await sql`
    select id, organization_id, slug, name, product_name, product_description, support_context
    from workspaces where slug = ${slug} limit 1
  `) as unknown as WorkspaceRow[];
  return rows[0] ?? null;
}

export async function ensureOrganization(input: {
  id: string;
  slug: string;
  name: string;
}): Promise<void> {
  const sql = await getSql();
  if (!sql) return;
  await sql`
    insert into organizations (id, slug, name)
    values (${input.id}, ${input.slug}, ${input.name})
    on conflict (id) do nothing
  `;
}

export async function ensureWorkspace(input: {
  id: string;
  organizationId: string;
  slug: string;
  name: string;
}): Promise<void> {
  const sql = await getSql();
  if (!sql) return;
  await sql`
    insert into workspaces (id, organization_id, slug, name)
    values (${input.id}, ${input.organizationId}, ${input.slug}, ${input.name})
    on conflict (id) do nothing
  `;
}

export async function ensureCustomer(input: {
  id: string;
  workspaceId: string;
  bootstrapHash: string;
}): Promise<void> {
  const sql = await getSql();
  if (!sql) return;
  await sql`
    insert into customers (id, workspace_id, bootstrap_identity_hash)
    values (${input.id}, ${input.workspaceId}, ${input.bootstrapHash})
    on conflict (id) do update set updated_at = now()
  `;
}

export type CustomerRow = {
  id: string;
  workspace_id: string;
  display_name: string | null;
  bootstrap_identity_hash: string | null;
  auth_user_id: string | null;
};

export async function getCustomerByWorkspaceAndAuth(
  workspaceId: string,
  authUserId: string,
): Promise<CustomerRow | null> {
  const sql = await getSql();
  if (!sql) return null;
  const rows = (await sql`
    select id, workspace_id, display_name, bootstrap_identity_hash, auth_user_id
    from customers where workspace_id = ${workspaceId} and auth_user_id = ${authUserId} limit 1
  `) as unknown as CustomerRow[];
  return rows[0] ?? null;
}

/**
 * Idempotent find-or-create for an auth-backed workspace customer.
 * The row id is the deterministic customerIdForAuth value, so concurrent
 * creates converge. Performs ZERO Walrus writes.
 */
export async function ensureAuthCustomer(input: {
  id: string;
  workspaceId: string;
  authUserId: string;
  displayName: string | null;
}): Promise<CustomerRow> {
  const sql = await getSql();
  if (!sql) throw new Error("database unavailable");
  const rows = (await sql`
    insert into customers (id, workspace_id, auth_user_id, display_name)
    values (${input.id}, ${input.workspaceId}, ${input.authUserId}, ${input.displayName})
    on conflict (id) do update set updated_at = now(),
      display_name = coalesce(excluded.display_name, customers.display_name)
    returning id, workspace_id, display_name, bootstrap_identity_hash, auth_user_id
  `) as unknown as CustomerRow[];
  const row = rows[0];
  if (!row) throw new Error("customer upsert failed");
  // Defensive: a colliding deterministic id must belong to this auth user.
  if (row.auth_user_id !== input.authUserId) {
    throw new Error("customer identity conflict — refusing to proceed");
  }
  return row;
}

export type KnowledgeRow = {
  id: string;
  workspace_id: string;
  type: string;
  title: string;
  source_url: string | null;
  canonical_content: string;
  status: string;
  created_at: string;
  updated_at: string;
};

export type KnowledgeChunkRow = {
  id: string;
  knowledge_id: string;
  workspace_id: string;
  content: string;
  position: number;
  walrus_blob_id: string | null;
  created_at: string;
};

export async function createKnowledgeSource(input: {
  workspaceId: string;
  type: string;
  title: string;
  sourceUrl: string | null;
  canonicalContent: string;
}): Promise<KnowledgeRow> {
  const sql = await getSql();
  if (!sql) throw new Error("database unavailable");
  const rows = (await sql`
    insert into workspace_knowledge (workspace_id, type, title, source_url, canonical_content, status)
    values (${input.workspaceId}, ${input.type}, ${input.title}, ${input.sourceUrl}, ${input.canonicalContent}, 'pending')
    returning id, workspace_id, type, title, source_url, canonical_content, status, created_at, updated_at
  `) as unknown as KnowledgeRow[];
  const row = rows[0];
  if (!row) throw new Error("knowledge insert failed");
  return row;
}

export async function listKnowledgeSources(workspaceId: string): Promise<KnowledgeRow[]> {
  const sql = await getSql();
  if (!sql) return [];
  return (await sql`
    select id, workspace_id, type, title, source_url, canonical_content, status, created_at, updated_at
    from workspace_knowledge where workspace_id = ${workspaceId} order by created_at desc
  `) as unknown as KnowledgeRow[];
}

export async function getKnowledgeSource(id: string, workspaceId: string): Promise<KnowledgeRow | null> {
  const sql = await getSql();
  if (!sql) return null;
  const rows = (await sql`
    select id, workspace_id, type, title, source_url, canonical_content, status, created_at, updated_at
    from workspace_knowledge where id = ${id} and workspace_id = ${workspaceId} limit 1
  `) as unknown as KnowledgeRow[];
  return rows[0] ?? null;
}

export async function updateKnowledgeSource(
  id: string,
  workspaceId: string,
  patch: { title?: string; canonicalContent?: string; status?: string },
): Promise<KnowledgeRow | null> {
  const sql = await getSql();
  if (!sql) throw new Error("database unavailable");
  const rows = (await sql`
    update workspace_knowledge
    set title = coalesce(${patch.title ?? null}, title),
        canonical_content = coalesce(${patch.canonicalContent ?? null}, canonical_content),
        status = coalesce(${patch.status ?? null}, status),
        updated_at = now()
    where id = ${id} and workspace_id = ${workspaceId}
    returning id, workspace_id, type, title, source_url, canonical_content, status, created_at, updated_at
  `) as unknown as KnowledgeRow[];
  return rows[0] ?? null;
}

export async function deleteKnowledgeSource(id: string, workspaceId: string): Promise<boolean> {
  const sql = await getSql();
  if (!sql) throw new Error("database unavailable");
  // Chunk rows cascade; Walrus blobs are content-addressed and simply
  // become unreferenced (no global enumeration to clean them).
  const rows = (await sql`
    delete from workspace_knowledge where id = ${id} and workspace_id = ${workspaceId} returning id
  `) as unknown as { id: string }[];
  return rows.length > 0;
}

export async function replaceKnowledgeChunks(input: {
  knowledgeId: string;
  workspaceId: string;
  chunks: { content: string; position: number; blobId: string | null }[];
}): Promise<void> {
  const sql = await getSql();
  if (!sql) throw new Error("database unavailable");
  await sql`delete from workspace_knowledge_chunks where knowledge_id = ${input.knowledgeId}`;
  for (const c of input.chunks) {
    await sql`
      insert into workspace_knowledge_chunks (knowledge_id, workspace_id, content, position, walrus_blob_id)
      values (${input.knowledgeId}, ${input.workspaceId}, ${c.content}, ${c.position}, ${c.blobId})
    `;
  }
}

export async function listKnowledgeChunks(knowledgeId: string, workspaceId: string): Promise<KnowledgeChunkRow[]> {
  const sql = await getSql();
  if (!sql) return [];
  return (await sql`
    select id, knowledge_id, workspace_id, content, position, walrus_blob_id, created_at
    from workspace_knowledge_chunks where knowledge_id = ${knowledgeId} and workspace_id = ${workspaceId} order by position asc
  `) as unknown as KnowledgeChunkRow[];
}

/** Persist one indexed chunk (position-scoped upsert — resume-safe, single-writer). */
export async function saveKnowledgeChunk(input: {
  knowledgeId: string;
  workspaceId: string;
  content: string;
  position: number;
  blobId: string | null;
}): Promise<void> {
  const sql = await getSql();
  if (!sql) throw new Error("database unavailable");
  await sql`delete from workspace_knowledge_chunks where knowledge_id = ${input.knowledgeId} and position = ${input.position}`;
  await sql`
    insert into workspace_knowledge_chunks (knowledge_id, workspace_id, content, position, walrus_blob_id)
    values (${input.knowledgeId}, ${input.workspaceId}, ${input.content}, ${input.position}, ${input.blobId})
  `;
}

export function hashAccessCodeForDb(normalizedCode: string, salt: string): string {
  // Separate DB-level hash; the raw code is never stored.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  return createHash("sha256").update(`db:${salt}:${normalizedCode}`, "utf8").digest("hex");
}
