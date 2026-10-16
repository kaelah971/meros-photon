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
              status, reply_to_id, created_at
  `) as unknown as PhotonMessageRow[];
  if (rows[0]) return { row: rows[0], deduped: false };
  // Conflict path: NULL provider ids never conflict (each delivery is new);
  // a real id conflict means redelivery — return the existing row.
  const existing = providerId
    ? ((await sql`
        select id, workspace_id, binding_id, direction, webhook_id,
               provider_message_id, thread_id, sender_hash, body_text,
               status, reply_to_id, created_at
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
              status, reply_to_id, created_at
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

/** The inbound row is replied exactly when its outbound slot is claimed+sent. */
export async function markInboundReplied(
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
