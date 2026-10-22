// Pure bounded-retry helper (no server-only import so it stays unit-testable).

const RETRYABLE_CODES = new Set([408, 429, 500, 502, 503, 504]);
export const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 800;

/**
 * SDK attempt timeouts surface as abort rejections (e.g. the GenAI SDK's
 * own AbortController: "This operation was aborted"), not HTTP statuses.
 * Without this classification, a slow-but-transient model call fails over
 * to nothing and its raw abort text leaks to the UI. Aborts and transport
 * timeouts are transient by nature: safe to fail over / retry bounded.
 */
export function isAbortLike(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  // The GenAI SDK deliberately raises AbortError for NON-retryable HTTP
  // statuses ("Non-retryable exception ..."): that is a verdict, not a
  // transport abort — it must never be retried or failed over.
  if (/non-retryable/i.test(msg)) return false;
  const name = e instanceof Error ? e.name : "";
  if (name === "AbortError" || /abort/i.test(name)) return true;
  return /abort|timed\s*out|\btimeout\b|ETIMEDOUT|ECONNRESET|EAI_AGAIN|socket hang up/i.test(msg);
}

export function isRetryable(e: unknown): boolean {
  if (isAbortLike(e)) return true;
  const msg = e instanceof Error ? e.message : String(e);
  if (/non-retryable/i.test(msg)) return false;
  // The GenAI SDK surfaces exhausted retries as verdict text WITHOUT a
  // numeric code ("Retryable HTTP Error: Service unavailable") — honor
  // the SDK's own retryable verdict so model failover can still trigger.
  if (/retryable|service unavailable|too many requests|overloaded|rate.?limit|high demand/i.test(msg)) return true;
  const m = msg.match(/"code"\s*:\s*(\d{3})/) || msg.match(/\b(50[0234]|429|408)\b/);
  return m ? RETRYABLE_CODES.has(Number(m[1])) : false;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Settled<T> =
  | { status: "ok"; value: T }
  | { status: "timeout" }
  | { status: "error"; error: unknown };

/**
 * Race a promise against a wall-clock timeout. Never throws: a hang becomes
 * { status: "timeout" }, a rejection becomes { status: "error" }. The
 * underlying promise is branched with handlers, so a late rejection after a
 * timeout can never surface as an unhandled rejection.
 */
export async function settleWithTimeout<T>(promise: Promise<T>, ms: number): Promise<Settled<T>> {
  const wrapped = promise.then(
    (value: T): Settled<T> => ({ status: "ok", value }),
    (error: unknown): Settled<T> => ({ status: "error", error }),
  );
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<Settled<T>>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timeout" }), ms);
  });
  try {
    return await Promise.race([wrapped, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * Bounded retry for transient failures (e.g. Gemini 503 high demand).
 * Max 3 attempts, exponential backoff (~0.8s/1.6s + jitter). Retryable
 * errors only — never infinite, never on client errors.
 */
export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!isRetryable(e) || attempt === MAX_ATTEMPTS) throw e;
      await sleep(BASE_DELAY_MS * 2 ** (attempt - 1) + Math.random() * 250);
    }
  }
  throw last;
}
