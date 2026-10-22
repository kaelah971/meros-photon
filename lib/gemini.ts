import "server-only";
import { GoogleGenAI } from "@google/genai";
import { isGeminiConfigured } from "./env";
import { isRetryable, settleWithTimeout, withRetry, type Settled } from "./retry";
import { buildAttachmentParts, type AttachmentPayload } from "./attachments";

export { withRetry as withGeminiRetry };

// Gemini remains the primary (and only) LLM provider. Model IDs are
// configurable via env; defaults are live-verified IDs — never guessed.
export const DEFAULT_PRIMARY_MODEL = "gemini-3.5-flash-lite";
export const DEFAULT_FALLBACK_MODEL = "gemini-3.7-flash";
/** Deprecated alias; prefer getPrimaryModel(). */
export const GEMINI_MODEL = DEFAULT_PRIMARY_MODEL;

export function getPrimaryModel(): string {
  return process.env.GEMINI_MODEL?.trim() || DEFAULT_PRIMARY_MODEL;
}

export function getFallbackModel(): string | null {
  return process.env.GEMINI_FALLBACK_MODEL?.trim() || DEFAULT_FALLBACK_MODEL;
}

// Per-model wall-clock ceiling (~20s). The SDK already retries once
// internally, so model calls are NOT wrapped in outer withRetry — that
// stacking previously produced 90–240s waits. One ceiling per model,
// then fail over or fail honestly. The ceiling CANCELS in-flight work via
// AbortSignal (config.abortSignal): without this, an abandoned attempt
// keeps its socket + SDK retry alive in the background, burning quota
// and amplifying the very overload that caused the timeout.
const PER_MODEL_TIMEOUT_MS = 20_000;

async function generateWithFallback<T>(
  run: (model: string, signal: AbortSignal) => Promise<T>,
  parent?: AbortSignal,
): Promise<T> {
  const attempt = (model: string): Promise<Settled<T>> => {
    const ctrl = new AbortController();
    const onParentAbort = () => ctrl.abort();
    if (parent?.aborted) ctrl.abort();
    else parent?.addEventListener("abort", onParentAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), PER_MODEL_TIMEOUT_MS);
    const settled = settleWithTimeout(run(model, ctrl.signal), PER_MODEL_TIMEOUT_MS);
    return settled.finally(() => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
      // Stop burning quota/sockets on work nobody is waiting for anymore.
      ctrl.abort();
    });
  };
  const primaryModel = getPrimaryModel();
  const primary = await attempt(primaryModel);
  if (primary.status === "ok") {
    console.log("[gemini] ok via primary");
    return primary.value;
  }
  const primaryError =
    primary.status === "error"
      ? primary.error
      : new Error("primary model timed out");
  // Fail over ONLY on retryable/model-availability failures (incl. timeout).
  // Auth, bad-request, and other non-retryable errors throw immediately.
  const canFailOver =
    primary.status === "timeout" ||
    (primary.status === "error" && isRetryable(primary.error));
  const fallback = getFallbackModel();
  if (!canFailOver || !fallback || fallback === primaryModel) throw primaryError;
  // Caller already gave up: never start a second model attempt for
  // nobody. Without this, an explicit cancel still spends a fallback call.
  if (parent?.aborted) throw primaryError;
  console.log("[gemini] primary failed over, trying fallback model");
  const second = await attempt(fallback);
  if (second.status === "ok") {
    console.log("[gemini] ok via fallback");
    return second.value;
  }
  if (second.status === "timeout") {
    throw new Error("primary and fallback models both timed out (models overloaded)");
  }
  throw second.error;
}

export class GeminiNotConfiguredError extends Error {
  constructor() {
    super(
      "GEMINI_API_KEY is not configured on the server. Add it to .env.local to enable chat.",
    );
    this.name = "GeminiNotConfiguredError";
  }
}

export function geminiStatus(): { configured: boolean; model: string } {
  return { configured: isGeminiConfigured(), model: getPrimaryModel() };
}

export type ChatTurn = { role: "user" | "assistant"; text: string };

function getKey(): string {
  const key =
    process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim();
  if (!key) throw new GeminiNotConfiguredError();
  return key;
}

/**
 * SDK bounding (keys/auth unchanged). The GenAI SDK defaults to 5 internal
 * attempts with backoff — previously stacked with outer retries into
 * 90–240s waits. Now: 1 initial attempt + 1 SDK retry, 12s per attempt,
 * and the per-model 20s ceiling above is the real bound. Worst case per
 * model ≈ 20s; whole model phase can never approach previous behaviour.
 */
const SDK_ATTEMPT_TIMEOUT_MS = 12_000;
const SDK_MAX_ATTEMPTS = 2;
export const GEMINI_PHASE_TIMEOUT_MS = 45_000;

function getClient(): GoogleGenAI {
  return new GoogleGenAI({
    apiKey: getKey(),
    httpOptions: {
      timeout: SDK_ATTEMPT_TIMEOUT_MS,
      retryOptions: { attempts: SDK_MAX_ATTEMPTS },
    },
  });
}

/** Server-side model call. Throws honestly on missing key or empty answer.
 *  Attachments (request-scoped raw bytes) ride as native multimodal parts
 *  on the CURRENT user turn only — labeled user data, never instructions,
 *  never persisted. */
export async function generateSupportAnswer(input: {
  systemInstruction: string;
  history: ChatTurn[];
  message: string;
  attachments?: AttachmentPayload[];
  /** Optional caller ceiling: aborting it cancels the whole model chain. */
  signal?: AbortSignal;
}): Promise<string> {
  const ai = getClient();
  const currentParts: { text?: string; inlineData?: { mimeType: string; data: string } }[] = [
    { text: input.message },
    ...buildAttachmentParts(input.attachments ?? []),
  ];
  const contents = [
    ...input.history.map((h) => ({
      role: h.role === "assistant" ? ("model" as const) : ("user" as const),
      parts: [{ text: h.text }],
    })),
    { role: "user" as const, parts: currentParts },
  ];
  // Phase controller: the 45s ceiling cancels the whole fallback chain
  // instead of abandoning it to burn quota in the background. A caller
  // ceiling (e.g. the iMessage phrasing bound) links in the same way.
  const phaseCtrl = new AbortController();
  const onCallerAbort = () => phaseCtrl.abort();
  if (input.signal?.aborted) phaseCtrl.abort();
  else input.signal?.addEventListener("abort", onCallerAbort, { once: true });
  const phaseTimer = setTimeout(() => phaseCtrl.abort(), GEMINI_PHASE_TIMEOUT_MS);
  let settled: Settled<Awaited<ReturnType<typeof ai.models.generateContent>>>;
  try {
    settled = await settleWithTimeout(
      generateWithFallback(
        (model, signal) =>
          ai.models.generateContent({
            model,
            contents,
            config: { systemInstruction: input.systemInstruction, abortSignal: signal },
          }),
        phaseCtrl.signal,
      ),
      GEMINI_PHASE_TIMEOUT_MS,
    );
  } finally {
    clearTimeout(phaseTimer);
    input.signal?.removeEventListener("abort", onCallerAbort);
    phaseCtrl.abort();
  }
  if (settled.status !== "ok") {
    throw new Error(
      settled.status === "timeout"
        ? "Gemini answer timed out after 45s (models overloaded). Try again."
        : `Gemini answer failed: ${settled.error instanceof Error ? settled.error.message : String(settled.error)}`,
    );
  }
  const text = settled.value.text?.trim();
  if (!text) throw new Error("Gemini returned an empty answer");
  return text;
}

/** Structured JSON generation for extraction/sanitization steps. */
export async function generateJson(input: {
  systemInstruction: string;
  userText: string;
  /** Optional caller ceiling: aborting it cancels the whole model chain. */
  signal?: AbortSignal;
}): Promise<unknown> {
  const ai = getClient();
  const phaseCtrl = new AbortController();
  const onCallerAbort = () => phaseCtrl.abort();
  if (input.signal?.aborted) phaseCtrl.abort();
  else input.signal?.addEventListener("abort", onCallerAbort, { once: true });
  const phaseTimer = setTimeout(() => phaseCtrl.abort(), GEMINI_PHASE_TIMEOUT_MS);
  let settled: Settled<Awaited<ReturnType<typeof ai.models.generateContent>>>;
  try {
    settled = await settleWithTimeout(
      generateWithFallback(
        (model, signal) =>
          ai.models.generateContent({
            model,
            contents: [{ role: "user", parts: [{ text: input.userText }] }],
            config: {
              systemInstruction: input.systemInstruction,
              responseMimeType: "application/json",
              abortSignal: signal,
            },
          }),
        phaseCtrl.signal,
      ),
      GEMINI_PHASE_TIMEOUT_MS,
    );
  } finally {
    clearTimeout(phaseTimer);
    input.signal?.removeEventListener("abort", onCallerAbort);
    phaseCtrl.abort();
  }
  if (settled.status !== "ok") {
    throw new Error(
      settled.status === "timeout"
        ? "Gemini request timed out after 45s (models overloaded). Try again."
        : `Gemini request failed: ${settled.error instanceof Error ? settled.error.message : String(settled.error)}`,
    );
  }
  const text = settled.value.text?.trim();
  if (!text) throw new Error("Gemini returned empty JSON");
  return JSON.parse(text);
}
