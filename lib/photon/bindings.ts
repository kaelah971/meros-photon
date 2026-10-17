import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { getIdSalt } from "../env";

// Photon S1 operator bindings: iMessage sender <-> staff user + workspace.
// Raw sender handles and pairing codes are NEVER persisted — only hashes.
// Zero Walrus writes. All identity stays server-derived.

type Sql = <T = Record<string, unknown>[]>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<T>;

async function getSql(): Promise<Sql | null> {
  const { dbAvailable } = await import("../db");
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

export type BindingStatus = "pending" | "active" | "revoked";

export type PhotonBindingRow = {
  id: string;
  workspace_id: string;
  operator_user_id: string;
  sender_hash: string | null;
  status: BindingStatus;
  pairing_code_hash: string | null;
  pairing_expires_at: string | null;
  thread_id: string | null;
  created_at: string;
  last_seen_at: string | null;
};

/** Hash an inbound iMessage sender id. Raw handles never touch Neon. */
export function hashSender(senderUserId: string, salt?: string): string {
  const s = salt ?? getIdSalt();
  return createHash("sha256")
    .update(`meros:v1:photon-sender:${s}:${senderUserId}`, "utf8")
    .digest("hex");
}

function hashPairingCode(code: string, salt?: string): string {
  const s = salt ?? getIdSalt();
  return createHash("sha256")
    .update(`meros:v1:photon-pair:${s}:${code}`, "utf8")
    .digest("hex");
}

/** Short human-typable code for the `pair XXXX-XXXX-XXXX` iMessage step. */
export function mintPairingCode(): string {
  const raw = randomBytes(6).toString("hex").toUpperCase();
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
}

export const PAIRING_TTL_MS = 15 * 60 * 1000;

/**
 * Staff-minted pending binding. Called ONLY from a staff-session API
 * (requireStaff enforced by the caller) — minting never weakens auth.
 * Returns the ONE-TIME plaintext code; only its hash is persisted.
 */
export async function issuePairingCode(input: {
  workspaceId: string;
  operatorUserId: string;
}): Promise<{ bindingId: string; code: string; expiresAt: string }> {
  const sql = await requireSql();
  const code = mintPairingCode();
  const rows = (await sql`
    insert into photon_operator_bindings
      (workspace_id, operator_user_id, status, pairing_code_hash, pairing_expires_at)
    values (${input.workspaceId}, ${input.operatorUserId}, 'pending',
            ${hashPairingCode(code)}, ${new Date(Date.now() + PAIRING_TTL_MS).toISOString()})
    returning id, pairing_expires_at
  `) as unknown as { id: string; pairing_expires_at: string }[];
  const row = rows[0];
  if (!row) throw new Error("pairing issue failed");
  return { bindingId: row.id, code, expiresAt: row.pairing_expires_at };
}

/**
 * Resolve an inbound sender to its ACTIVE binding. When the inbound thread
 * is supplied, it is recorded as the binding's durable conversation address
 * (used for server-initiated outbound after cold starts) alongside last_seen.
 */
export async function resolveActiveBinding(
  senderHash: string,
  threadId?: string | null,
): Promise<PhotonBindingRow | null> {
  const sql = await requireSql();
  const rows = (await sql`
    select id, workspace_id, operator_user_id, sender_hash, status,
           pairing_code_hash, pairing_expires_at, thread_id, created_at, last_seen_at
    from photon_operator_bindings
    where sender_hash = ${senderHash} and status = 'active'
    order by created_at desc limit 1
  `) as unknown as PhotonBindingRow[];
  const row = rows[0] ?? null;
  if (row) {
    const thread = threadId?.trim() || null;
    await sql`update photon_operator_bindings
      set thread_id = coalesce(${thread}, thread_id), last_seen_at = now()
      where id = ${row.id}`;
    if (thread) row.thread_id = thread;
  }
  return row;
}

/**
 * Resolve the ACTIVE binding for one staff user inside one workspace.
 * Proactive sends use this (never a raw sender); revoked/pending rows
 * never resolve here, so revocation immediately stops outbound.
 */
export async function resolveActiveBindingForOperator(
  workspaceId: string,
  operatorUserId: string,
): Promise<PhotonBindingRow | null> {
  const sql = await requireSql();
  const rows = (await sql`
    select id, workspace_id, operator_user_id, sender_hash, status,
           pairing_code_hash, pairing_expires_at, thread_id, created_at, last_seen_at
    from photon_operator_bindings
    where workspace_id = ${workspaceId}
      and operator_user_id = ${operatorUserId}
      and status = 'active'
    order by created_at desc limit 1
  `) as unknown as PhotonBindingRow[];
  return rows[0] ?? null;
}

/**
 * Claim a pending binding with `pair <CODE>`: single-use, expiry-checked.
 * Binds this sender hash to the staff user + workspace that minted the code.
 * Records the claiming thread as the first conversation address when known.
 */
export async function claimPairingCode(
  code: string,
  senderHash: string,
  threadId?: string | null,
): Promise<PhotonBindingRow | null> {
  const sql = await requireSql();
  const clean = code.trim().toUpperCase();
  if (!clean) return null;
  const rows = (await sql`
    update photon_operator_bindings
    set status = 'active', sender_hash = ${senderHash},
        pairing_code_hash = null, pairing_expires_at = null,
        thread_id = coalesce(${threadId?.trim() || null}, thread_id),
        last_seen_at = now()
    where pairing_code_hash = ${hashPairingCode(clean)}
      and status = 'pending'
      and pairing_expires_at is not null
      and pairing_expires_at > now()
    returning id, workspace_id, operator_user_id, sender_hash, status,
              pairing_code_hash, pairing_expires_at, thread_id, created_at, last_seen_at
  `) as unknown as PhotonBindingRow[];
  return rows[0] ?? null;
}

/** Staff revocation (caller enforces requireStaff for the workspace).
 * Clears the conversation address so a revoked binding can never send. */
export async function revokeBinding(bindingId: string, workspaceId: string): Promise<boolean> {
  const sql = await requireSql();
  const rows = (await sql`
    update photon_operator_bindings set status = 'revoked', thread_id = null
    where id = ${bindingId} and workspace_id = ${workspaceId} and status != 'revoked'
    returning id
  `) as unknown as { id: string }[];
  return rows.length > 0;
}

/** Staff-visible binding roster (hashes only — never raw senders). */
export async function listBindings(workspaceId: string): Promise<
  {
    id: string;
    status: BindingStatus;
    senderPresent: boolean;
    createdAt: string;
    lastSeenAt: string | null;
  }[]
> {
  const sql = await requireSql();
  const rows = (await sql`
    select id, status, sender_hash, created_at, last_seen_at
    from photon_operator_bindings
    where workspace_id = ${workspaceId}
    order by created_at desc limit 50
  `) as unknown as {
    id: string;
    status: BindingStatus;
    sender_hash: string | null;
    created_at: string;
    last_seen_at: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    senderPresent: Boolean(r.sender_hash),
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
  }));
}
