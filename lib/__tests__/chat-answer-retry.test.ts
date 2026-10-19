import { beforeEach, describe, expect, it, vi } from "vitest";
import { isAbortLike, isRetryable, withRetry } from "../retry";

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const genMock = vi.fn();
const mem = { convos: [] as { id: string; workspaceId: string; customerId: string; status: string }[], msgs: [] as { id: string; conversationId: string; clientId: string; role: string; content: string; provenance: unknown[] }[], seq: 0 };

describe("abort/timeout classification", () => {
  it("treats SDK aborts and transport timeouts as retryable", () => {
    expect(isAbortLike(new Error("This operation was aborted"))).toBe(true);
    expect(isAbortLike(Object.assign(new Error("timeout"), { name: "AbortError" }))).toBe(true);
    expect(isAbortLike(new Error("GenerateContent timed out after 12000ms"))).toBe(true);
    expect(isAbortLike(new Error("socket hang up"))).toBe(true);
    expect(isAbortLike(new Error("validation failed: bad request"))).toBe(false);
    expect(isRetryable(new Error("This operation was aborted"))).toBe(true);
    expect(isRetryable(new Error("request ETIMEDOUT"))).toBe(true);
  });

  it("keeps status-code behavior: 503 yes, business errors no", () => {
    expect(isRetryable(new Error('{"error":{"code":503}}'))).toBe(true);
    expect(isRetryable(new Error("candidate must be [SHARED_FIX]"))).toBe(false);
    expect(isRetryable(new Error('{"error":{"code":400}}'))).toBe(false);
  });

  it("withRetry now retries an abort then succeeds (bounded)", async () => {
    let calls = 0;
    const out = await withRetry(async () => {
      calls++;
      if (calls === 1) throw new Error("This operation was aborted");
      return "ok";
    });
    expect(out).toBe("ok");
    expect(calls).toBe(2);
  });
});

describe("chat answer retry (route)", () => {

  vi.mock("@/lib/product-identity", () => ({
    resolveProductIdentity: async (body: { workspaceSlug?: unknown }) => {
      if ((body as { workspaceSlug?: unknown }).workspaceSlug === "other") {
        return { workspaceId: "ws-2", customerId: "cust-9", workspace: { name: "Other" }, privateNamespace: "p2", sharedNamespace: "s2" };
      }
      return { workspaceId: "ws-1", customerId: "cust-1", workspace: { name: "Acme" }, privateNamespace: "p1", sharedNamespace: "s1" };
    },
    identityError: (e: unknown) => ({ message: e instanceof Error ? e.message : "x", status: 401 }),
  }));
  vi.mock("@/lib/support-ops", async (importOriginal) => {
    const orig = (await importOriginal()) as Record<string, unknown>;
    return {
      ...orig,
      createConversation: async (input: { workspaceId: string; customerId: string; title: string }) => {
        const id = `conv-${++mem.seq}`;
        mem.convos.push({ id, workspaceId: input.workspaceId, customerId: input.customerId, status: "open" });
        return { conversation: { id, status: "open" }, issue: { id: `iss-${mem.seq}`, status: "open" } };
      },
      getConversationForCustomer: async (id: string, ws: string, cust: string) =>
        mem.convos.find((c) => c.id === id && c.workspaceId === ws && c.customerId === cust) ?? null,
      addUserMessage: async (input: { conversationId: string; content: string; clientId?: string | null }) => {
        const clientId = (input.clientId ?? "").trim() || `gen-${++mem.seq}`;
        const hit = mem.msgs.find((m) => m.conversationId === input.conversationId && m.clientId === clientId);
        if (hit) return { id: hit.id, deduped: true, clientId };
        const id = `msg-${++mem.seq}`;
        mem.msgs.push({ id, conversationId: input.conversationId, clientId, role: "user", content: input.content, provenance: [] });
        return { id, deduped: false, clientId };
      },
      addAssistantMessage: async (input: { conversationId: string; content: string; clientId?: string | null; provenance?: unknown[] }) => {
        const clientId = (input.clientId ?? "").trim() || `gen-${++mem.seq}`;
        const hit = mem.msgs.find((m) => m.conversationId === input.conversationId && m.clientId === clientId);
        if (hit) return hit.id;
        const id = `msg-${++mem.seq}`;
        mem.msgs.push({ id, conversationId: input.conversationId, clientId, role: "assistant", content: input.content, provenance: (input.provenance as unknown[]) ?? [] });
        return id;
      },
      findMessageByClientId: async (conversationId: string, clientId: string) => {
        const hit = mem.msgs.find((m) => m.conversationId === conversationId && m.clientId === clientId);
        return hit ? { id: hit.id, role: hit.role, content: hit.content, provenance: hit.provenance } : null;
      },
      listRecentTurns: async (conversationId: string) =>
        mem.msgs.filter((m) => m.conversationId === conversationId).map((m) => ({ role: m.role, text: m.content })),
      titleFromMessage: (t: string) => t.slice(0, 40),
    };
  });
  vi.mock("@/lib/gemini", () => ({
    GeminiNotConfiguredError: class extends Error {},
    generateSupportAnswer: (...a: unknown[]) => genMock(...(a as [])),
    getPrimaryModel: () => "test-model",
  }));
  vi.mock("@/lib/walrus", async (importOriginal) => {
    const orig = (await importOriginal()) as Record<string, unknown>;
    return {
      ...orig,
      recallBounded: async () => ({ status: "ok", results: [], total: 0, durationMs: 1 }),
    };
  });
  vi.mock("@/lib/chat-memory", () => ({
    MAX_DISTANCE: 1,
    RECALL_TOP_K: 4,
    buildSystemInstruction: () => "sys",
    dropSupersededSharedHits: (h: unknown) => h,
    normalizeMemories: () => [],
  }));
  vi.mock("@/lib/env", () => ({ isWalrusConfigured: () => true }));
  vi.mock("@/lib/identity", () => ({ previewUserId: () => "preview" }));
  vi.mock("@/lib/support-memory", () => ({
    buildRecallQuery: () => "return policy",
    detectResolution: () => false,
  }));
  vi.mock("@/lib/tenant", () => ({ deriveKnowledgeNamespaceV2: () => "kns" }));

  beforeEach(() => {
    mem.convos = [];
    mem.msgs = [];
    mem.seq = 0;
    genMock.mockReset();
  });

  const post = async (body: unknown) => {
    const { POST } = await import("@/app/api/chat/route");
    return POST(new Request("http://x/api/chat", { method: "POST", body: JSON.stringify(body) }));
  };
  const ask = (over: Record<string, unknown> = {}) => ({
    workspaceSlug: "acme",
    message: "What is your return policy?",
    clientMessageId: "client-1",
    answerClientId: "client-1:answer",
    ...over,
  });

  it("abort failure is friendly, retryable, and preserves the saved question", async () => {
    genMock.mockRejectedValueOnce(new Error("This operation was aborted"));
    const res = await post(ask());
    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.error).toContain("Your message is saved");
    expect(data.code).toBe("answer_failed");
    expect(data.retryable).toBe(true);
    expect(data.error).not.toMatch(/abort/i);
    expect(typeof data.conversationId).toBe("string");
    // Question persisted exactly once despite the failed generation.
    expect(mem.msgs.filter((m) => m.role === "user")).toHaveLength(1);
  });

  it("retry with original keys answers without duplicating anything", async () => {
    genMock.mockRejectedValueOnce(new Error("This operation was aborted"));
    const first = await (await post(ask())).json();
    genMock.mockResolvedValueOnce("Returns are accepted within 30 days with a receipt.");
    const second = await (await post(ask({ conversationId: first.conversationId }))).json();
    expect(second.ok).toBe(true);
    expect(second.answer).toContain("30 days");
    expect(mem.msgs.filter((m) => m.role === "user")).toHaveLength(1);
    expect(mem.msgs.filter((m) => m.role === "assistant")).toHaveLength(1);
    // One failed attempt + one retry generation — never a duplicate.
    expect(genMock).toHaveBeenCalledTimes(2);
  });

  it("ambiguous outcome resumes the stored reply without regenerating", async () => {
    genMock.mockRejectedValueOnce(new Error("socket hang up"));
    const first = await (await post(ask())).json();
    // First attempt actually wrote the answer; only the response was lost.
    mem.msgs.push({
      id: "msg-amb",
      conversationId: first.conversationId,
      clientId: "client-1:answer",
      role: "assistant",
      content: "Returns are accepted within 30 days.",
      provenance: [],
    });
    genMock.mockReset();
    const retry = await (await post(ask({ conversationId: first.conversationId }))).json();
    expect(retry.ok).toBe(true);
    expect(retry.resumed).toBe(true);
    expect(retry.answer).toContain("30 days");
    expect(genMock).not.toHaveBeenCalled();
    expect(mem.msgs.filter((m) => m.role === "assistant")).toHaveLength(1);
  });

  it("knowledge-grounded return-policy answer flows through on retry", async () => {
    genMock.mockRejectedValueOnce(new Error("GenerateContent timeout"));
    const first = await (await post(ask())).json();
    genMock.mockImplementationOnce(async (input: { message: string }) => {
      expect(input.message).toContain("return policy");
      return "Our return policy: 30 days with receipt.";
    });
    const second = await (await post(ask({ conversationId: first.conversationId }))).json();
    expect(second.answer).toContain("return policy");
  });

  it("foreign conversation ids are rejected (isolation)", async () => {
    const res = await post(ask({ conversationId: "conv-foreign", workspaceSlug: "other" }));
    expect(res.status).toBe(404);
  });
});
