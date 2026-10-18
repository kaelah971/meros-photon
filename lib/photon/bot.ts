import "server-only";
import { randomUUID } from "node:crypto";
import { Chat, type Lock, type Message, type QueueEntry, type StateAdapter, type Thread } from "chat";
import { createiMessageAdapter } from "@photon-ai/chat-adapter-imessage";
import {
  PhotonNotConfiguredError,
  getPhotonProjectId,
  getPhotonProjectSecret,
  getPhotonWebhookSecret,
  isPhotonConfigured,
} from "./config";
import { handleOperatorMessage, type OperatorDeps } from "./operator";
import { realInvestigateReads } from "./investigate-reads";

// Photon S1 bot: official Chat SDK + iMessage adapter in Spectrum Cloud mode.
// The adapter verifies Spectrum webhook signatures (IMESSAGE_WEBHOOK_SECRET)
// and rejects unsigned/stale/bad deliveries itself — no home-grown HMAC.
// Lazy singleton: constructing the adapter throws when credentials are
// absent, so NOTHING here runs at import time (`next build` stays green
// without Photon env). The route calls getBot() per webhook delivery.

/**
 * Process-local StateAdapter for the Chat SDK (locks, queues, subscriptions).
 * Correctness never depends on it: Spectrum at-least-once retries are
 * deduped durably in Neon (photon_messages unique constraints), so a cold
 * serverless invocation simply re-derives state. Single-process semantics
 * are kept honest (token-checked locks) rather than no-op'd.
 */
function createLocalState(): StateAdapter {
  const locks = new Map<string, Lock>();
  const kv = new Map<string, { value: unknown; expiresAt: number | null }>();
  const lists = new Map<string, unknown[]>();
  const queues = new Map<string, QueueEntry[]>();
  const subs = new Set<string>();

  const live = (expiresAt: number | null) => expiresAt === null || expiresAt > Date.now();

  return {
    async acquireLock(threadId, ttlMs) {
      const cur = locks.get(threadId);
      if (cur && live(cur.expiresAt)) return null;
      const lock: Lock = { threadId, token: randomUUID(), expiresAt: Date.now() + ttlMs };
      locks.set(threadId, lock);
      return lock;
    },
    async appendToList(key, value, options) {
      const arr = lists.get(key) ?? [];
      arr.push(value);
      const max = options?.maxLength ?? 100;
      lists.set(key, arr.slice(-max));
    },
    async connect() {},
    async delete(key) {
      kv.delete(key);
      lists.delete(key);
    },
    async dequeue(threadId) {
      const q = queues.get(threadId) ?? [];
      const next = q.shift() ?? null;
      queues.set(threadId, q);
      return next;
    },
    async disconnect() {},
    async enqueue(threadId, entry, maxSize) {
      const q = queues.get(threadId) ?? [];
      q.push(entry);
      queues.set(threadId, q.slice(-maxSize));
      return q.length;
    },
    async extendLock(lock, ttlMs) {
      const cur = locks.get(lock.threadId);
      if (!cur || cur.token !== lock.token || !live(cur.expiresAt)) return false;
      locks.set(lock.threadId, { ...cur, expiresAt: Date.now() + ttlMs });
      return true;
    },
    async forceReleaseLock(threadId) {
      locks.delete(threadId);
    },
    async get<T>(key: string): Promise<T | null> {
      const e = kv.get(key);
      if (!e || !live(e.expiresAt)) {
        if (e) kv.delete(key);
        return null;
      }
      return e.value as T;
    },
    async getList<T>(key: string): Promise<T[]> {
      return ((lists.get(key) ?? []) as T[]).slice();
    },
    async isSubscribed(threadId) {
      return subs.has(threadId);
    },
    async queueDepth(threadId) {
      return (queues.get(threadId) ?? []).length;
    },
    async releaseLock(lock) {
      const cur = locks.get(lock.threadId);
      if (cur && cur.token === lock.token) locks.delete(lock.threadId);
    },
    async set(key, value, ttlMs) {
      kv.set(key, { value, expiresAt: ttlMs ? Date.now() + ttlMs : null });
    },
    async setIfNotExists(key, value, ttlMs) {
      const cur = kv.get(key);
      if (cur && live(cur.expiresAt)) return false;
      kv.set(key, { value, expiresAt: ttlMs ? Date.now() + ttlMs : null });
      return true;
    },
    async subscribe(threadId) {
      subs.add(threadId);
    },
    async unsubscribe(threadId) {
      subs.delete(threadId);
    },
  };
}

type PhotonChat = Chat<{ imessage: ReturnType<typeof createiMessageAdapter> }>;
type PhotonAdapter = ReturnType<typeof createiMessageAdapter>;

let cached: PhotonChat | null = null;
let cachedAdapter: PhotonAdapter | null = null;

function realDeps(): OperatorDeps {
  return {
    findBinding: async (senderHash) => {
      const { resolveActiveBinding } = await import("./bindings");
      const b = await resolveActiveBinding(senderHash);
      return b
        ? { id: b.id, workspaceId: b.workspace_id, operatorUserId: b.operator_user_id, threadId: b.thread_id }
        : null;
    },
    noteThread: async (bindingId, threadId) => {
      const { neon } = await import("@neondatabase/serverless");
      const { dbAvailable } = await import("../db");
      if (!(await dbAvailable())) throw new Error("database unavailable");
      const thread = threadId?.trim() || null;
      if (!thread) return;
      const sql = neon(process.env.DATABASE_URL!.trim());
      await sql`update photon_operator_bindings
        set thread_id = coalesce(${thread}, thread_id), last_seen_at = now()
        where id = ${bindingId} and status = 'active'`;
    },
    claimPairing: async (code, senderHash) => {
      const { claimPairingCode } = await import("./bindings");
      // Thread address is recorded separately via noteThread (which carries
      // the inbound thread id); the claim itself stays sender-scoped.
      const b = await claimPairingCode(code, senderHash);
      return b
        ? { id: b.id, workspaceId: b.workspace_id, operatorUserId: b.operator_user_id, threadId: b.thread_id }
        : null;
    },
    checkStaff: async (userId, workspaceId) => {
      const { requireStaff } = await import("../support-ops");
      await requireStaff(userId, workspaceId);
    },
    readStats: async (workspaceId) => {
      const { getWorkspaceStats } = await import("../support-ops");
      return getWorkspaceStats(workspaceId);
    },
    findWorkspaceBySlug: async (slug) => {
      const { getWorkspaceBySlug } = await import("../db");
      const ws = await getWorkspaceBySlug(slug);
      return ws ? { id: ws.id, slug: ws.slug, name: ws.name } : null;
    },
    listWorkspaces: async (userId) => {
      const { getUserMemberships, getOwnedWorkspaces } = await import("../db");
      const memberships = await getUserMemberships(userId);
      const out: { id: string; slug: string; name: string }[] = [];
      for (const m of memberships) {
        const rows = await getOwnedWorkspaces(userId, m.organization_id);
        for (const w of rows ?? []) out.push({ id: w.id, slug: w.slug, name: w.name });
      }
      return out;
    },
    recordInbound: async (input) => {
      const { recordInbound } = await import("./history");
      const { row, deduped } = await recordInbound(input);
      return { id: row.id, status: row.status, deduped };
    },
    claimReply: async (input) => {
      const { claimReplySlot } = await import("./history");
      const slot = await claimReplySlot(input);
      return slot ? { id: slot.id } : null;
    },
    markSent: async (outboundId, providerId) => {
      const { markOutboundSent } = await import("./history");
      await markOutboundSent(outboundId, providerId);
    },
    releaseSlot: async (outboundId) => {
      const { neon } = await import("@neondatabase/serverless");
      const { dbAvailable } = await import("../db");
      if (!(await dbAvailable())) return;
      const sql = neon(process.env.DATABASE_URL!.trim());
      await sql`delete from photon_messages where id = ${outboundId} and status = 'received'`;
    },
    markReplied: async (inboundId, workspaceId, bindingId) => {
      const { markInboundReplied } = await import("./history");
      await markInboundReplied(inboundId, workspaceId, bindingId);
    },
    markRejected: async (inboundId, workspaceId, bindingId) => {
      const { markInboundRejected } = await import("./history");
      await markInboundRejected(inboundId, workspaceId, bindingId);
    },
    // Replaced per-message below (needs the live thread); never called bare.
    post: async () => {
      throw new Error("post is bound per-message");
    },
    investigate: realInvestigateReads(),
    converse: {
      loadHistory: async (workspaceId, bindingId) => {
        const { listOperatorHistory } = await import("./history");
        // Durable Photon history scoped to this operator binding, oldest
        // first, bounded and truncated — the only conversation memory.
        const rows = await listOperatorHistory({ workspaceId, bindingId, limit: 20 }).catch(() => []);
        return rows
          .reverse()
          .slice(-12)
          .map((r) => ({
            role: (r.direction === "outbound" ? "assistant" : "user") as "assistant" | "user",
            text: r.body_text.slice(0, 300),
          }))
          .filter((t) => t.text.trim().length > 0);
      },
      classify: async (text, history) => {
        const { defaultClassify } = await import("./converse");
        return defaultClassify(text, history);
      },
      phrase: async (input) => {
        const { defaultPhrase } = await import("./converse");
        return defaultPhrase(input);
      },
    },
  };
}

/**
 * S1 message handler: every inbound iMessage (DM or group mention) runs the
 * SAME narrow operator flow. thread.post works directly from a webhook
 * delivery — the adapter rebuilds the thread from its chat GUID, so no
 * gateway listener or persistent connection is needed.
 */
async function handleS1Message(thread: Thread, message: Message): Promise<void> {
  const { hashSender } = await import("./bindings");
  const deps = realDeps();
  const boundPost = async (text: string) => {
    const sent = await thread.post(text);
    return { providerId: (sent?.id ?? null) as string | null };
  };
  await handleOperatorMessage(
    {
      providerMessageId: message.id ?? null,
      threadId: message.threadId ?? null,
      senderHash: hashSender(message.author?.userId ?? "unknown"),
      text: message.text ?? "",
      isBot: message.author?.isBot === true,
    },
    { ...deps, post: boundPost },
  );
}

/** Lazily build (once) the Chat + iMessage adapter with the S1 handler. */
export function getBot(): PhotonChat {
  if (cached) return cached;
  if (!isPhotonConfigured()) throw new PhotonNotConfiguredError();
  const adapter = createiMessageAdapter({
    projectId: getPhotonProjectId()!,
    projectSecret: getPhotonProjectSecret()!,
    webhookSecret: getPhotonWebhookSecret()!,
  });
  cachedAdapter = adapter;
  const bot = new Chat({
    userName: "meros",
    adapters: { imessage: adapter },
    state: createLocalState(),
  });
  // iMessage operator chat is 1:1: DMs land here; group/unsubscribed threads
  // fall through to the same narrow handler. Each delivery routes to exactly
  // one of these — never both — and Neon dedupe guards redeliveries.
  bot.onDirectMessage(handleS1Message);
  bot.onNewMessage(handleS1Message);
  cached = bot as unknown as PhotonChat;
  return cached;
}

/**
 * Server-initiated send to a recorded conversation address (S2 proactive
 * notifications). Cold-start safe: the adapter rebuilds the thread from the
 * chat GUID encoded in threadId, so no live Chat state is required beyond
 * this call. Throws PhotonNotConfiguredError when unconfigured.
 */
export async function postToThread(
  threadId: string,
  text: string,
): Promise<{ providerId: string | null }> {
  const bot = getBot();
  const adapter =
    cachedAdapter ??
    (() => {
      const registry = (bot as unknown as { adapters?: unknown }).adapters;
      return (registry instanceof Map ? registry.get("imessage") : null) as PhotonAdapter | null;
    })();
  if (!adapter || typeof adapter.postMessage !== "function") {
    throw new Error("imessage adapter unavailable");
  }
  const sent = await adapter.postMessage(threadId, text);
  return { providerId: (sent?.id ?? null) as string | null };
}
