import "server-only";
import { MemWal } from "@mysten-incubation/memwal";
import { isAbortLike, settleWithTimeout } from "./retry";
import {
  getMemwalAccountId,
  getMemwalPrivateKey,
  getMemwalServerUrl,
  isWalrusConfigured,
  walrusBlocker,
} from "./env";

export class WalrusNotConfiguredError extends Error {
  needed: string[];
  constructor() {
    const b = walrusBlocker();
    super(b.reason);
    this.name = "WalrusNotConfiguredError";
    this.needed = b.needed;
  }
}

let singleton: MemWal | null = null;

function getClient(): MemWal {
  if (singleton) return singleton;
  if (!isWalrusConfigured()) throw new WalrusNotConfiguredError();
  singleton = MemWal.create({
    key: getMemwalPrivateKey()!,
    accountId: getMemwalAccountId()!,
    serverUrl: getMemwalServerUrl(),
  });
  return singleton;
}

export type RememberDone = {
  blobId: string;
  jobId: string;
  namespace: string;
  owner: string;
};

export type RecallHit = {
  text: string;
  distance: number;
  blobId: string;
  createdAt?: string;
};

/**
 * Write one memory into the caller's private namespace and WAIT for Walrus
 * completion. Never fire-and-forget. Throws honestly on failure.
 */
export async function rememberPrivate(
  namespace: string,
  text: string,
  opts?: { timeoutMs?: number },
): Promise<RememberDone> {
  const client = getClient();
  const clean = text.trim();
  if (!clean) throw new Error("memory text must not be empty");
  if (clean.length > 8000) throw new Error("memory text too long (max 8000 chars)");
  const result = await client.rememberAndWait(clean, namespace, {
    timeoutMs: opts?.timeoutMs ?? 120_000,
    pollIntervalMs: 1_500,
  });
  if (!result.blob_id) throw new Error("Walrus write completed without a blob_id");
  return {
    blobId: result.blob_id,
    jobId: result.job_id ?? result.id,
    namespace: result.namespace || namespace,
    owner: result.owner,
  };
}

/**
 * V1 LEGACY global shared namespace (`meros:shared:fixes`).
 * Used ONLY by the /dev diagnostic + legacy memory/* routes (P0 proof).
 * V2 workspace chat MUST NEVER import this — one org's fix leaking into
 * another's would be a tenant breach. See lib/tenant.ts for v2.
 */
export const SHARED_FIXES_NAMESPACE = "meros:shared:fixes";

/**
 * Semantic recall scoped to the caller's private namespace only.
 * No LLM involved — this proves Walrus itself works.
 */
export async function recallPrivate(
  namespace: string,
  query: string,
  opts?: { topK?: number; maxDistance?: number },
): Promise<{ results: RecallHit[]; total: number }> {
  const client = getClient();
  const clean = query.trim();
  if (!clean) throw new Error("query must not be empty");
  const topK = Math.min(Math.max(opts?.topK ?? 5, 1), 20);
  const result = await client.recall({
    query: clean,
    topK,
    namespace,
    ...(opts?.maxDistance !== undefined ? { maxDistance: opts.maxDistance } : {}),
  });
  return {
    total: result.total,
    results: result.results.map((r) => ({
      text: r.text,
      distance: r.distance,
      blobId: r.blob_id,
      ...(r.created_at ? { createdAt: r.created_at } : {}),
    })),
  };
}

/**
 * V1 LEGACY global shared recall. /dev + legacy memory/* routes only.
 * V2 chat uses recallBounded() with a tenant-derived namespace instead.
 */
export async function recallShared(
  query: string,
  opts?: { topK?: number; maxDistance?: number },
): Promise<{ results: RecallHit[]; total: number }> {
  return recallPrivate(SHARED_FIXES_NAMESPACE, query, opts);
}

/** Per-plane wall-clock budget for chat UX. The P0 write path is untouched. */
export const CHAT_RECALL_TIMEOUT_MS = 10_000;

export type PlaneStatus = "ok" | "timeout" | "error";

/**
 * Privacy-safe failure taxonomy for operators. Never carries key material,
 * raw server bodies, namespaces, or memory text — only the category plus
 * a canned safe message and (when present) the HTTP status number.
 * - ok: recall succeeded with >=1 hit
 * - empty: recall succeeded with zero hits (namespace valid, no match)
 * - not_configured: delegate key/account id missing
 * - auth: 401 / AUTH_REJECTED / clock-drift (key, account, or
 *   staging-vs-mainnet mismatch — fix credentials, do not retry blindly)
 * - incompatible: 426 / MemWalCompatibilityError (SDK/relayer pair)
 * - rate_limited: 429 (back off)
 * - timeout: wall-clock timeout / abort / 408 / 504 (transient)
 * - unavailable: 5xx or unreachable relayer (transient)
 * - error: anything else
 */
export type MemwalFailureKind =
  | "ok"
  | "empty"
  | "not_configured"
  | "auth"
  | "incompatible"
  | "rate_limited"
  | "timeout"
  | "unavailable"
  | "error";

export type BoundedRecall = {
  status: PlaneStatus;
  results: RecallHit[];
  total: number;
  durationMs: number;
  /** Privacy-safe category; "ok"/"empty" on success, cause on failure. */
  errorKind: MemwalFailureKind;
  /** Canned safe message (no secrets, no raw bodies). Present on failure. */
  error?: string;
};

function statusOf(e: unknown): number | undefined {
  const s = (e as { status?: unknown })?.status;
  return typeof s === "number" && Number.isFinite(s) ? s : undefined;
}

function codeOf(e: unknown): string | undefined {
  const c = (e as { serverCode?: unknown })?.serverCode;
  return typeof c === "string" ? c : undefined;
}

/**
 * Classify a MemWal/SDK failure without leaking secrets. Reads only the
 * error name, numeric status, serverCode, and known safe message
 * patterns — never `cause` (which may hold a raw server body) and never
 * any key/account/namespace value.
 */
export function classifyMemwalError(e: unknown): { kind: MemwalFailureKind; message: string } {
  if (e instanceof WalrusNotConfiguredError) {
    return {
      kind: "not_configured",
      message: "Walrus Memory credentials are not configured on the server.",
    };
  }
  const name = e instanceof Error ? e.name : "";
  const msg = e instanceof Error ? e.message : String(e);
  const status = statusOf(e);
  const serverCode = codeOf(e);
  if (
    name === "MemWalCompatibilityError" ||
    status === 426 ||
    serverCode === "COMPATIBILITY" ||
    /compatibility|upgrade required|apiVersion/i.test(msg)
  ) {
    return {
      kind: "incompatible",
      message: "Walrus SDK/relayer versions are incompatible (426). Upgrade the pinned SDK or relayer pair.",
    };
  }
  if (
    status === 401 ||
    serverCode === "AUTH_REJECTED" ||
    serverCode === "ERR_TIMESTAMP_OUT_OF_BOUNDS" ||
    /AUTH_REJECTED|wrong private key|not registered|account ID mismatch|staging\/mainnet|timestamp.*out of bounds/i.test(msg)
  ) {
    return {
      kind: "auth",
      message:
        "Walrus authentication rejected (401): delegate key, account ID, or staging/mainnet endpoint mismatch. Verify credentials; this will not self-heal by retrying.",
    };
  }
  if (status === 429) {
    return { kind: "rate_limited", message: "Walrus relayer rate-limited the request (429). Back off and retry." };
  }
  if (
    status === 408 ||
    status === 504 ||
    name === "MemWalRequestTimeout" ||
    isAbortLike(e) ||
    /timed out|timeout/i.test(msg)
  ) {
    const s = status !== undefined ? ` (${status})` : "";
    return { kind: "timeout", message: `Walrus request timed out${s}. Transient; safe to retry.` };
  }
  if (status !== undefined && (status >= 500 || status === 0)) {
    return {
      kind: "unavailable",
      message: `Walrus relayer unavailable (status ${status}). Transient; safe to retry.`,
    };
  }
  if (/fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket hang up|network/i.test(msg)) {
    return { kind: "unavailable", message: "Walrus relayer unreachable (network). Transient; safe to retry." };
  }
  return { kind: "error", message: "Walrus request failed." };
}

/**
 * Bounded recall for the chat loop: one plane, one deadline. A stalled
 * Walrus/SDK operation (e.g. a hung SEAL session build or Sui RPC inside
 * the SDK) becomes a "timeout" verdict instead of hanging /api/chat.
 * Never throws — callers degrade with whatever planes succeeded.
 */
export async function recallBounded(
  namespace: string,
  query: string,
  opts?: { topK?: number; maxDistance?: number; timeoutMs?: number },
): Promise<BoundedRecall> {
  const started = Date.now();
  const settled = await settleWithTimeout(
    recallPrivate(namespace, query, opts),
    opts?.timeoutMs ?? CHAT_RECALL_TIMEOUT_MS,
  );
  const durationMs = Date.now() - started;
  if (settled.status === "ok") {
    const empty = settled.value.total === 0 || settled.value.results.length === 0;
    return {
      status: "ok",
      results: settled.value.results,
      total: settled.value.total,
      durationMs,
      errorKind: empty ? "empty" : "ok",
    };
  }
  if (settled.status === "timeout") {
    return {
      status: "timeout",
      results: [],
      total: 0,
      durationMs,
      errorKind: "timeout",
      error: "Walrus recall timed out. Transient; safe to retry.",
    };
  }
  const classified = classifyMemwalError(settled.error);
  return {
    status: "error",
    results: [],
    total: 0,
    durationMs,
    errorKind: classified.kind,
    error: classified.message,
  };
}

export type MemwalProbe = {
  operational: boolean;
  errorKind: MemwalFailureKind;
  /** Canned safe message; never contains secrets or raw bodies. */
  message: string;
  latencyMs: number;
  apiVersion?: string;
  relayerVersion?: string;
  /** Raw `writes` flag from /health when reported (e.g. "degraded"). */
  writes?: string;
};

/**
 * Real operational probe: public GET /health + GET /version via the SDK.
 * Performs ZERO Walrus writes and ZERO memory reads. Never throws and
 * never surfaces secrets — safe for /api/health and operator diagnostics.
 * Distinguishes: not_configured, auth-capable client build failure,
 * incompatible (426/version mismatch), timeout, and unavailable.
 */
export async function checkMemwalHealth(opts?: { timeoutMs?: number }): Promise<MemwalProbe> {
  const started = Date.now();
  const timeoutMs = opts?.timeoutMs ?? 8_000;
  if (!isWalrusConfigured()) {
    return {
      operational: false,
      errorKind: "not_configured",
      message: "Walrus Memory credentials are not configured on the server.",
      latencyMs: Date.now() - started,
    };
  }
  let client: MemWal;
  try {
    client = getClient();
  } catch (e) {
    const classified = classifyMemwalError(e);
    return {
      operational: false,
      errorKind: classified.kind,
      message: classified.message,
      latencyMs: Date.now() - started,
    };
  }
  const settled = await settleWithTimeout(
    (async () => {
      const health = (await client.health()) as {
        apiVersion?: string;
        relayerVersion?: string;
        writes?: string;
        write_ready?: boolean;
      };
      // Compatibility fetch validates the SDK/relayer contract (426-safe).
      let compat: { apiVersion?: string; relayerVersion?: string } | null = null;
      try {
        compat = (await client.compatibility()) as { apiVersion?: string; relayerVersion?: string };
      } catch {
        compat = null;
      }
      return { health, compat };
    })(),
    timeoutMs,
  );
  const latencyMs = Date.now() - started;
  if (settled.status === "timeout") {
    return {
      operational: false,
      errorKind: "timeout",
      message: "Walrus relayer health probe timed out. Transient; safe to retry.",
      latencyMs,
    };
  }
  if (settled.status === "error") {
    const classified = classifyMemwalError(settled.error);
    return { operational: false, errorKind: classified.kind, message: classified.message, latencyMs };
  }
  const health = settled.value.health ?? {};
  const compat = settled.value.compat ?? {};
  const writes = typeof health.writes === "string" ? health.writes : undefined;
  return {
    operational: true,
    errorKind: writes === "degraded" ? "unavailable" : "ok",
    message:
      writes === "degraded"
        ? "Walrus relayer reachable; writes degraded upstream. Reads may succeed; writes may fail transiently."
        : "Walrus relayer reachable; SDK contract compatible.",
    latencyMs,
    ...(typeof (health.apiVersion ?? compat.apiVersion) === "string"
      ? { apiVersion: (health.apiVersion ?? compat.apiVersion) as string }
      : {}),
    ...(typeof (health.relayerVersion ?? compat.relayerVersion) === "string"
      ? { relayerVersion: (health.relayerVersion ?? compat.relayerVersion) as string }
      : {}),
    ...(writes !== undefined ? { writes } : {}),
  };
}

/**
 * Write text into an EXPLICIT server-derived namespace and wait for Walrus
 * completion. All v2 tenant writes go through here; callers pass the
 * namespace from resolveAuthenticatedCustomer() — never from the client.
 */
export async function rememberInNamespace(
  namespace: string,
  text: string,
  maxChars = 8000,
): Promise<RememberDone> {
  const client = getClient();
  const clean = text.trim();
  if (!clean) throw new Error("memory text must not be empty");
  if (clean.length > maxChars) throw new Error(`memory text too long (max ${maxChars})`);
  const result = await client.rememberAndWait(clean, namespace, {
    timeoutMs: 120_000,
    pollIntervalMs: 1_500,
  });
  if (!result.blob_id) throw new Error("Walrus write completed without a blob_id");
  return {
    blobId: result.blob_id,
    jobId: result.job_id ?? result.id,
    namespace: result.namespace || namespace,
    owner: result.owner,
  };
}

/**
 * V1 LEGACY global shared write. Legacy promote path only — v2 promotion
 * calls rememberInNamespace() with the CURRENT workspace's shared namespace.
 */
export async function rememberShared(text: string): Promise<RememberDone> {
  if (!text.trim()) throw new Error("shared fix text must not be empty");
  return rememberInNamespace(SHARED_FIXES_NAMESPACE, text, 2000);
}
