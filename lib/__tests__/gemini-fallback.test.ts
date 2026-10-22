import { beforeEach, describe, expect, it, vi } from "vitest";

const genMock = vi.fn();

vi.mock("@google/genai", () => ({
  GoogleGenAI: vi.fn(() => ({ models: { generateContent: (...a: unknown[]) => genMock(...a) } })),
}));

import { generateSupportAnswer } from "../gemini";

const SAVED_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...SAVED_ENV, GEMINI_API_KEY: "test-key", GEMINI_MODEL: "primary-model", GEMINI_FALLBACK_MODEL: "fallback-model" };
  genMock.mockReset();
  vi.resetModules();
});

describe("model failover on provider errors (mocked SDK)", () => {
  it("SDK 503 verdict text triggers fallback and succeeds", async () => {
    const seenModels: unknown[] = [];
    genMock.mockImplementation(async (args: { model: string }) => {
      seenModels.push(args.model);
      if (args.model === "primary-model") throw new Error("Retryable HTTP Error: Service unavailable");
      return { text: "fallback answer" };
    });
    const out = await generateSupportAnswer({ systemInstruction: "sys", history: [], message: "hi there, need help" });
    expect(out).toBe("fallback answer");
    expect(seenModels).toEqual(["primary-model", "fallback-model"]);
  });

  it("non-retryable 400 never fails over (one call, honest throw)", async () => {
    const err = new Error("Non-retryable exception Bad Request");
    err.name = "AbortError";
    genMock.mockRejectedValue(err);
    await expect(
      generateSupportAnswer({ systemInstruction: "sys", history: [], message: "hi there, need help" }),
    ).rejects.toThrow(/Bad Request/);
    expect(genMock).toHaveBeenCalledTimes(1);
  });

  it("abort signal is threaded into generateContent and cleaned up", async () => {
    const signals: unknown[] = [];
    genMock.mockImplementation(async (args: { config?: { abortSignal?: AbortSignal } }) => {
      signals.push(args.config?.abortSignal);
      return { text: "ok" };
    });
    await generateSupportAnswer({ systemInstruction: "sys", history: [], message: "hi there, need help" });
    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    // Cleanup aborts the controller after we stop waiting — no lingering work.
    expect((signals[0] as AbortSignal).aborted).toBe(true);
  });

  it("empty answer is an honest failure, not a success", async () => {
    genMock.mockResolvedValue({ text: "   " });
    await expect(
      generateSupportAnswer({ systemInstruction: "sys", history: [], message: "hi there, need help" }),
    ).rejects.toThrow(/empty answer/);
  });
});
