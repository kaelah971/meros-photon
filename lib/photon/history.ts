import "server-only";

// Photon S1 message history + at-least-once dedupe log.
// Spectrum retries a delivery with the SAME platform message id: the unique
// (direction, provider_message_id) constraint turns a redelivery into the
// existing row, and the unique reply_to_id slot turns a second reply attempt
// into a no-op. History rows never gate on Walrus — Neon only.

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

/** Operator-authored text is audit history — truncate, never store unbounded. */
export const MAX_STORED_TEXT_CHARS = 500;

export function truncateBody(text: string): string {
  const clean = text.trim();
  return clean.length > MAX_STORED_TEXT_CHARS
    ? clean.slice(0, MAX_STORED_TEXT_CHARS)
    : clean;
}

export type PhotonMessageRow = {
  id: string;
  workspace_id: string | null;
  binding_id: string | null;
  direction: "inbound" | "outbound";
  webhook_id: string | null;
  provider_message_id: string | null;
  thread_id: string | null;
  sender_hash: string | null;
  body_text: string;
  status: "received" | "replied" | "rejected" | "sent" | "failed";
  reply_to_id: string | null;
  idempotency_key: string | null;
  created_at: string;
};

/**
 * Persist an inbound delivery. Idempotent on (inbound, provider_message_id):
 * a retried webhook returns the existing row with deduped=true and MUST NOT
 * trigger a second reply when that row is already marked replied.
 */
export async function recordInbound(input: {
  providerMessageId: string | null;
  webhookId?: string | null;
  threadId: string | null;
  senderHash: string;
  text: string;
}): Promise<{ row: PhotonMessageRow; deduped: boolean }> {
  const sql = await requireSql();
  const providerId = input.providerMessageId?.trim() || null;
  const rows = (await sql`
    insert into photon_messages
      (direction, webhook_id, provider_message_id, thread_id, sender_hash, body_text, status)
    values ('inbound', ${input.webhookId ?? null}, ${providerId},
            ${input.threadId}, ${input.senderHash}, ${truncateBody(input.text)}, 'received')
    on conflict (direction, provider_message_id) do nothing
    returning id, workspace_id, binding_id, direction, webhook_id,
              provider_message_id, thread_id, sender_hash, body_text,
              status, reply_to_id, idempotency_key, created_at
  `) as unknown as PhotonMessageRow[];
  if (rows[0]) return { row: rows[0], deduped: false };
  // Conflict path: NULL provider ids never conflict (each delivery is new);
  // a real id conflict means redelivery — return the existing row.
  const existing = providerId
    ? ((await sql`
        select id, workspace_id, binding_id, direction, webhook_id,
               provider_message_id, thread_id, sender_hash, body_text,
               status, reply_to_id, idempotency_key, created_at
        from photon_messages
        where direction = 'inbound' and provider_message_id = ${providerId}
        limit 1
      `) as unknown as PhotonMessageRow[])
    : [];
  if (!existing[0]) throw new Error("photon inbound persist failed");
  return { row: existing[0], deduped: true };
}

/**
 * Claim the single outbound-reply slot for an inbound row. First claimant
 * wins; losers get null and MUST NOT send (prevents duplicate replies when
 * two deliveries race past the inbound dedupe, e.g. after a crash between
 * receive and reply).
 */
export async function claimReplySlot(input: {
  inboundId: string;
  workspaceId: string | null;
  bindingId: string | null;
  threadId: string | null;
  replyText: string;
}): Promise<PhotonMessageRow | null> {
  const sql = await requireSql();
  const rows = (await sql`
    insert into photon_messages
      (workspace_id, binding_id, direction, thread_id, body_text, status, reply_to_id)
    values (${input.workspaceId}, ${input.bindingId}, 'outbound',
            ${input.threadId}, ${truncateBody(input.replyText)}, 'received', ${input.inboundId})
    on conflict (reply_to_id) do nothing
    returning id, workspace_id, binding_id, direction, webhook_id,
              provider_message_id, thread_id, sender_hash, body_text,
              status, reply_to_id, idempotency_key, created_at
  `) as unknown as PhotonMessageRow[];
  return rows[0] ?? null;
}

export async function markOutboundSent(
  outboundId: string,
  providerMessageId?: string | null,
): Promise<void> {
  const sql = await requireSql();
  await sql`
    update photon_messages
    set status = 'sent', provider_message_id = coalesce(${providerMessageId ?? null}, provider_message_id)
    where id = ${outboundId}
  `;
}

export async function markOutboundFailed(outboundId: string): Promise<void> {
  const sql = await requireSql();
  await sql`update photon_messages set status = 'failed' where id = ${outboundId}`;
}

/** The inbound row is replied exactly when its outbound slot is claimed+sent. */export async function markInboundReplied(
  inboundId: string,
  workspaceId: string | null,
  bindingId: string | null,
): Promise<void> {
  const sql = await requireSql();
  await sql`
    update photon_messages
    set status = 'replied',
        workspace_id = coalesce(${workspaceId}, workspace_id),
        binding_id = coalesce(${bindingId}, binding_id)
    where id = ${inboundId}
  `;
}

/** Safe rejections (unknown sender, denied access) are terminal history too. */
export async function markInboundRejected(
  inboundId: string,
  workspaceId: string | null,
  bindingId: string | null,
): Promise<void> {
  const sql = await requireSql();
  await sql`
    update photon_messages
    set status = 'rejected',
        workspace_id = coalesce(${workspaceId}, workspace_id),
        binding_id = coalesce(${bindingId}, binding_id)
    where id = ${inboundId}
  `;
}

/**
 * Claim the idempotent proactive-send slot for one idempotency key.
 * First claimant wins and MUST send; a redelivery with the same key
 * returns the existing attempt ({deduped: true}) and must NOT resend.
 * NULL keys never conflict (each unkeyed insert is a new attempt).
 */
export async function claimProactiveSlot(input: {
  workspaceId: string;
  bindingId: string;
  threadId: string;
  bodyText: string;
  idempotencyKey: string | null;
}): Promise<{ row: PhotonMessageRow; deduped: boolean }> {
  const sql = await requireSql();
  const key = input.idempotencyKey?.trim() || null;
  const rows = (await sql`
    insert into photon_messages
      (workspace_id, binding_id, direction, thread_id, body_text, status, idempotency_key)
    values (${input.workspaceId}, ${input.bindingId}, 'outbound',
            ${input.threadId}, ${truncateBody(input.bodyText)}, 'received', ${key})
    on conflict (idempotency_key) do nothing
    returning id, workspace_id, binding_id, direction, webhook_id,
              provider_message_id, thread_id, sender_hash, body_text,
              status, reply_to_id, idempotency_key, created_at
  `) as unknown as PhotonMessageRow[];
  if (rows[0]) return { row: rows[0], deduped: false };
  const existing = key
    ? ((await sql`
        select id, workspace_id, binding_id, direction, webhook_id,
               provider_message_id, thread_id, sender_hash, body_text,
               status, reply_to_id, idempotency_key, created_at
        from photon_messages
        where direction = 'outbound' and idempotency_key = ${key}
        limit 1
      `) as unknown as PhotonMessageRow[])
    : [];
  if (!existing[0]) throw new Error("photon proactive persist failed");
  return { row: existing[0], deduped: true };
}

/**
 * Durable operator history: inbound commands, bot replies, and proactive
 * notifications for one workspace (optionally one binding), newest first.
 * Powers console history views + Resolution Watch style follow-ups.
 */
export async function listOperatorHistory(input: {
  workspaceId: string;
  bindingId?: string | null;
  limit?: number;
}): Promise<PhotonMessageRow[]> {
  const sql = await requireSql();
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  if (input.bindingId) {
    return (await sql`
      select id, workspace_id, binding_id, direction, webhook_id,
             provider_message_id, thread_id, sender_hash, body_text,
             status, reply_to_id, idempotency_key, created_at
      from photon_messages
      where workspace_id = ${input.workspaceId} and binding_id = ${input.bindingId}
      order by created_at desc, id desc limit ${limit}
    `) as unknown as PhotonMessageRow[];
  }
  return (await sql`
    select id, workspace_id, binding_id, direction, webhook_id,
           provider_message_id, thread_id, sender_hash, body_text,
           status, reply_to_id, idempotency_key, created_at
    from photon_messages
    where workspace_id = ${input.workspaceId}
    order by created_at desc, id desc limit ${limit}
  `) as unknown as PhotonMessageRow[];
}

export type RadarAlertRecord = {
  outboundId: string;
  candidateId: string;
  operatorUserId: string;
  threadId: string | null;
  createdAt: string;
};

const RADAR_KEY_RE = /^radar:([0-9a-f-]{36}):(.+)$/i;

/**
 * S15C "show me" context: recent ACCEPTED Radar alerts for one operator in
 * one workspace, newest first. The candidate id is parsed from the
 * idempotency key (`radar:{candidateId}:{operatorUserId}`) recorded at
 * send time — never inferred from message text. Only `sent` rows count;
 * failed or suppressed sends are not valid alert context. Bounded.
 */
export async function listRecentRadarAlerts(input: {
  workspaceId: string;
  operatorUserId: string;
  sinceHours?: number;
  limit?: number;
}): Promise<RadarAlertRecord[]> {
  const sql = await requireSql();
  const hours = Math.min(Math.max(input.sinceHours ?? 24, 1), 168);
  const limit = Math.min(Math.max(input.limit ?? 5, 1), 20);
  const rows = (await sql`
    select id, thread_id, idempotency_key, created_at
    from photon_messages
    where workspace_id = ${input.workspaceId}
      and direction = 'outbound'
      and status = 'sent'
      and idempotency_key like 'radar:%'
      and created_at > now() - (${hours} || ' hours')::interval
    order by created_at desc, id desc limit ${limit * 5}
  `) as unknown as { id: string; thread_id: string | null; idempotency_key: string | null; created_at: string }[];
  const out: RadarAlertRecord[] = [];
  for (const r of rows) {
    const m = r.idempotency_key ? RADAR_KEY_RE.exec(r.idempotency_key) : null;
    if (!m) continue; // malformed key: never guess, skip honestly
    if (m[2] !== input.operatorUserId) continue; // per-operator keys never cross
    out.push({
      outboundId: r.id,
      candidateId: m[1],
      operatorUserId: m[2],
      threadId: r.thread_id,
      createdAt: r.created_at,
    });
    if (out.length >= limit) break;
  }
  return out;
}
