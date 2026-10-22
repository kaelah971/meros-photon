import { describe, expect, it } from "vitest";
import { isAbortLike, isRetryable, withRetry as withGeminiRetry } from "../retry";

describe("provider error classification", () => {
  it("SDK 503 verdict text (no numeric code) is retryable", () => {
    expect(isRetryable(new Error("Retryable HTTP Error: Service unavailable"))).toBe(true);
    expect(isRetryable(new Error("Retryable HTTP Error: Too Many Requests"))).toBe(true);
  });
  it("SDK non-retryable verdict is never retryable, even as AbortError", () => {
    const err = new Error("Non-retryable exception Bad Request");
    err.name = "AbortError";
    expect(isAbortLike(err)).toBe(false);
    expect(isRetryable(err)).toBe(false);
  });
  it("transport aborts and timeouts stay retryable", () => {
    const abort = new Error("This operation was aborted");
    abort.name = "AbortError";
    expect(isRetryable(abort)).toBe(true);
    expect(isRetryable(new Error('{"error":{"code":429}}'))).toBe(true);
  });
  it("400 business errors are not retryable", () => {
    expect(isRetryable(new Error('{"error":{"code":400}}'))).toBe(false);
    expect(isRetryable(new Error("candidate must be [SHARED_FIX] with lines"))).toBe(false);
  });
});

const transient = () => {
  throw new Error('{"error":{"code":503,"message":"high demand","status":"UNAVAILABLE"}}');
};

describe("withGeminiRetry", () => {
  it("retries transient 503s then returns success", async () => {
    let calls = 0;
    const out = await withGeminiRetry(async () => {
      calls++;
      if (calls < 3) transient();
      return "ok";
    });
    expect(out).toBe("ok");
    expect(calls).toBe(3);
  });
  it("throws non-retryable errors immediately without looping", async () => {
    let calls = 0;
    await expect(
      withGeminiRetry(async () => {
        calls++;
        throw new Error("candidate must be [SHARED_FIX] with Symptom/Cause/Resolution lines");
      }),
    ).rejects.toThrow(/SHARED_FIX/);
    expect(calls).toBe(1);
  });
  it("gives up after a bounded number of attempts", async () => {
    let calls = 0;
    await expect(
      withGeminiRetry(async () => {
        calls++;
        transient();
        return "never";
      }),
    ).rejects.toThrow(/503/);
    expect(calls).toBe(3);
  });
});
