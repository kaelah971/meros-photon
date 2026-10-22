import { beforeEach, describe, expect, it, vi } from "vitest";

// Runs the chat route's background (after) work inline and deterministically.
const afterCalls: Array<() => unknown> = [];
async function runBackground() {
  const q = afterCalls.splice(0, afterCalls.length);
  for (const cb of q) await cb();
}

vi.mock("next/server", async (importOriginal) => {
  const orig = await importOriginal<typeof import("next/server")>();
  return {
    ...orig,
    after: (cb: () => unknown) => {
      afterCalls.push(cb);
    },
  };
});

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

// ---- In-memory support-ops (idempotent message + conversation lifecycle) ----
const mem = {
  convos: [] as { id: string; workspaceId: string; customerId: string; status: string }[],
  msgs: [] as { id: string; conversationId: string; clientId: string; role: string; content: string }[],
  seq: 0,
};

let currentUser = "user-A";
const userOf = (u: string) => ({
  id: u,
  email: `${u}@x.test`,
  customerId: `cust-${u}`,
});

vi.mock("@/lib/product-identity", () => ({
  resolveProductIdentity: async (body: { workspaceSlug?: unknown; asUser?: unknown }) => {
    const slug = body.workspaceSlug === "other" ? "other" : "acme";
    const u = typeof body.asUser === "string" ? body.asUser : currentUser;
    return {
      workspaceId: `ws-${slug}`,
      customerId: `cust-${slug}-${u}`,
      authUserId: u,
      privateNamespace: `p-${slug}-${u}`,
      sharedNamespace: `s-${slug}`,
      workspace: { slug, name: slug },
    };
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
      mem.msgs.push({ id, conversationId: input.conversationId, clientId, role: "user", content: input.content });
      return { id, deduped: false, clientId };
    },
    addAssistantMessage: async (input: { conversationId: string; content: string; clientId?: string | null }) => {
      const clientId = (input.clientId ?? "").trim() || `gen-${++mem.seq}`;
      const hit = mem.msgs.find((m) => m.conversationId === input.conversationId && m.clientId === clientId);
      if (hit) return hit.id;
      const id = `msg-${++mem.seq}`;
      mem.msgs.push({ id, conversationId: input.conversationId, clientId, role: "assistant", content: input.content });
      return id;
    },
    findMessageByClientId: async (conversationId: string, clientId: string) => {
      const hit = mem.msgs.find((m) => m.conversationId === conversationId && m.clientId === clientId);
      return hit ? { id: hit.id, role: hit.role, content: hit.content, provenance: [] } : null;
    },
    listRecentTurns: async (conversationId: string) =>
      mem.msgs.filter((m) => m.conversationId === conversationId).map((m) => ({ role: m.role, text: m.content })),
    resolveConversation: async (conversationId: string) => {
      const c = mem.convos.find((x) => x.id === conversationId);
      if (c) c.status = "resolved";
      return { id: `iss-${conversationId}`, status: "resolved" as const };
    },
    createPendingFixCard: async () => ({ id: "card-1", status: "pending" as const }),
    listSupersededSharedBlobs: async () => [],
  };
});

const genMock = vi.fn();
vi.mock("@/lib/gemini", () => ({
  GeminiNotConfiguredError: class extends Error {},
  generateSupportAnswer: (...a: unknown[]) => genMock(...(a as [])),
  getPrimaryModel: () => "test-model",
}));

vi.mock("@/lib/walrus", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    // Walrus diagnostic shape must stay intact (errorKind on every plane).
    recallBounded: async () => ({ status: "ok", results: [], total: 0, durationMs: 1, errorKind: "empty" }),
  };
});

vi.mock("@/lib/chat-memory", () => ({
  MAX_DISTANCE: 1,
  RECALL_TOP_K: 4,
  buildSystemInstruction: () => "sys",
  dropSupersededSharedHits: (h: unknown) => h,
  normalizeMemories: () => [],
}));

vi.mock("@/lib/env", () => ({
  isWalrusConfigured: () => true,
  isGeminiConfigured: () => true,
  walrusBlocker: () => ({ reason: "x", needed: [] }),
  getIdSalt: () => "test-salt",
}));

vi.mock("@/lib/identity", () => ({ previewUserId: () => "preview" }));
vi.mock("@/lib/tenant", () => ({ deriveKnowledgeNamespaceV2: (ws: string) => `kns-${ws}` }));
vi.mock("@/lib/fix-candidate", () => ({ generateFixCandidate: async () => ({ status: "skipped" as const }) }));
vi.mock("@/lib/support-memory", () => ({
  buildRecallQuery: () => "checkout fails",
  // Resolution confirmations close issues; they are never new incident reports.
  detectResolution: (m: string) => m.toLowerCase().includes("resolved, thanks"),
  dropKnownFacts: (f: unknown) => f,
  validateExtractedFacts: (f: unknown) => f ?? [],
}));

// ---- Fake judge: deterministic, plus a throwing mode for Gemini outage ----
let judgeMode: "issue" | "throw" = "issue";
vi.mock("@/lib/detection-gemini", () => ({
  geminiJudge: () => async (input: { message: string; candidates: { id: string }[] }) => {
    if (judgeMode === "throw") throw new Error("GenerateContent failed: overloaded");
    return {
      isIssue: true,
      title: "Checkout fails",
      summary: "checkout fails",
      matchCandidateId: input.candidates.length > 0 ? input.candidates[0].id : null,
      dismissedMatchId: null,
      quality: "high",
      rationale: "same symptom",
    };
  },
}));

// ---- In-memory issue-candidates store with real uniqueness semantics ----
type FakeCand = {
  id: string;
  workspaceId: string;
  status: "pending";
  members: Map<string, string>;
  messages: { messageId: string; conversationId: string; customerId: string }[];
};
const candStore = { cands: new Map<string, FakeCand>(), seq: 0 };
vi.mock("@/lib/issue-candidates", () => ({
  SURFACE_MIN_CONVERSATIONS: 2,
  messageAlreadyClustered: async (workspaceId: string, messageId: string) => {
    for (const c of candStore.cands.values()) {
      if (c.workspaceId === workspaceId && c.messages.some((m) => m.messageId === messageId)) {
        return { candidateId: c.id };
      }
    }
    return null;
  },
  pendingCandidatesForConversation: async () => [],
  pendingCandidateContexts: async (workspaceId: string) => {
    const out = [];
    for (const c of candStore.cands.values()) {
      if (c.workspaceId === workspaceId && c.status === "pending") {
        out.push({ id: c.id, title: "Checkout fails", summary: "s", confidence: "high", excerpts: [] });
      }
    }
    return out;
  },
  dismissedCandidateTitles: async () => [],
  createCandidate: async (input: { workspaceId: string }) => {
    const id = `cand-${++candStore.seq}`;
    candStore.cands.set(id, { id, workspaceId: input.workspaceId, status: "pending", members: new Map(), messages: [] });
    return { id };
  },
  addMessageToCandidate: async (input: { candidateId: string; workspaceId: string; messageId: string; conversationId: string; customerId: string }) => {
    for (const other of candStore.cands.values()) {
      if (other.workspaceId === input.workspaceId && other.messages.some((m) => m.messageId === input.messageId)) {
        return { memberAdded: false, messageAdded: false, duplicateOf: other.id };
      }
    }
    const c = candStore.cands.get(input.candidateId);
    if (!c) return null;
    const memberAdded = !c.members.has(input.conversationId);
    c.members.set(input.conversationId, input.customerId);
    c.messages.push({ messageId: input.messageId, conversationId: input.conversationId, customerId: input.customerId });
    return { memberAdded, messageAdded: true, duplicateOf: null };
  },
  deleteCandidate: async (candidateId: string) => {
    candStore.cands.delete(candidateId);
  },
}));

// Real timing gate, fake sender with its own idempotency ledger.
const radarCalls: { workspaceId: string; candidateId: string }[] = [];
const radarSentKeys = new Set<string>();
vi.mock("@/lib/radar", async (importOriginal) => {
  const orig = (await importOriginal<typeof import("@/lib/radar")>()) as typeof import("@/lib/radar");
  return {
    ...orig,
    realRadarDeps: async () => ({}),
    maybeSendRadarAlert: async (workspaceId: string, candidateId: string) => {
      radarCalls.push({ workspaceId, candidateId });
      const key = `${workspaceId}:${candidateId}`;
      if (radarSentKeys.has(key)) return { action: "deduped", reason: "already alerted" };
      radarSentKeys.add(key);
      return { action: "alerted", sent: 1, deduped: 0, suppressed: 0 };
    },
  };
});

const decisions: unknown[] = [];
vi.mock("@/lib/radar-decision", async (importOriginal) => {
  const orig = (await importOriginal<typeof import("@/lib/radar-decision")>()) as typeof import("@/lib/radar-decision");
  return {
    ...orig,
    logRadarDecision: (e: unknown) => {
      decisions.push(e);
      return orig.logRadarDecision(e as Parameters<typeof orig.logRadarDecision>[0]);
    },
  };
});

vi.mock("@/lib/detection", async (importOriginal) => {
  const orig = (await importOriginal<typeof import("@/lib/detection")>()) as typeof import("@/lib/detection");
  return { ...orig, recentConversationExcerpts: async () => [] };
});

vi.mock("@/lib/incidents", () => ({ listOpenIncidentIdsForConversation: async () => [] }));

const post = async (body: unknown) => {
  const { POST } = await import("@/app/api/chat/route");
  return POST(new Request("http://x/api/chat", { method: "POST", body: JSON.stringify(body) }));
};
const ask = (over: Record<string, unknown> = {}) => ({
  workspaceSlug: "acme",
  message: "Checkout fails every time I pay with a card in this workspace, please help.",
  clientMessageId: `c-${Math.random().toString(36).slice(2)}`,
  answerClientId: `a-${Math.random().toString(36).slice(2)}`,
  ...over,
});
const msgCount = (role: string) => mem.msgs.filter((m) => m.role === role).length;

beforeEach(() => {
  mem.convos = [];
  mem.msgs = [];
  mem.seq = 0;
  candStore.cands.clear();
  candStore.seq = 0;
  radarCalls.length = 0;
  radarSentKeys.clear();
  decisions.length = 0;
  afterCalls.length = 0;
  genMock.mockReset();
  genMock.mockResolvedValue("Try a different card.");
  judgeMode = "issue";
  currentUser = "user-A";
});

describe("detection decoupled from answer success", () => {
  it("successful answer invokes detection and creates a candidate", async () => {
    const res = await post(ask({ clientMessageId: "c-1", answerClientId: "a-1" }));
    expect(res.status).toBe(200);
    await runBackground();
    expect(candStore.cands.size).toBe(1);
    expect(decisions.some((d) => (d as { outcome: string }).outcome === "detection_created")).toBe(true);
  });

  it("failed Gemini answer still invokes detection (502 keeps the report detectable)", async () => {
    genMock.mockRejectedValueOnce(new Error("GenerateContent failed: overloaded"));
    const res = await post(ask({ clientMessageId: "c-2", answerClientId: "a-2" }));
    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data.code).toBe("answer_failed");
    expect(data.retryable).toBe(true);
    // The persisted complaint reaches detection anyway.
    await runBackground();
    expect(msgCount("user")).toBe(1);
    expect(candStore.cands.size).toBe(1);
    expect(decisions.some((d) => (d as { outcome: string }).outcome === "detection_created")).toBe(true);
  });

  it("fallback abort retains the message and still schedules detection", async () => {
    genMock.mockRejectedValueOnce(new Error("This operation was aborted"));
    const res = await post(ask({ clientMessageId: "c-3", answerClientId: "a-3" }));
    expect(res.status).toBe(502);
    await runBackground();
    expect(msgCount("user")).toBe(1);
    expect(candStore.cands.size).toBe(1);
  });

  it("answer retry creates no duplicate candidate membership", async () => {
    genMock.mockRejectedValueOnce(new Error("socket hang up"));
    const first = await (await post(ask({ clientMessageId: "c-4", answerClientId: "a-4" }))).json();
    await runBackground();
    expect(candStore.cands.size).toBe(1);
    genMock.mockResolvedValueOnce("Try a different card.");
    const second = await (
      await post(ask({ clientMessageId: "c-4", answerClientId: "a-4", conversationId: first.conversationId }))
    ).json();
    expect(second.ok).toBe(true);
    await runBackground();
    expect(candStore.cands.size).toBe(1);
    const cand = [...candStore.cands.values()][0];
    expect(cand.messages).toHaveLength(1);
    expect(msgCount("user")).toBe(1);
    expect(msgCount("assistant")).toBe(1);
  });

  it("three distinct conversations join one candidate and evaluate Radar once per member", async () => {
    for (const [u, c, a] of [["user-A", "c-a", "a-a"], ["user-B", "c-b", "a-b"], ["user-C", "c-c", "a-c"]] as const) {
      currentUser = u;
      const res = await post(ask({ clientMessageId: c, answerClientId: a }));
      expect(res.status).toBe(200);
      await runBackground();
    }
    expect(candStore.cands.size).toBe(1);
    const cand = [...candStore.cands.values()][0];
    expect(cand.members.size).toBe(3);
    // created (no eval) + two joins with newConversation (eval each).
    expect(radarCalls).toHaveLength(2);
    expect(new Set(radarCalls.map((r) => r.candidateId)).size).toBe(1);
  });

  it("same-conversation follow-up never re-evaluates Radar", async () => {
    currentUser = "user-A";
    const first = await (await post(ask({ clientMessageId: "c-f1", answerClientId: "a-f1" }))).json();
    await runBackground();
    const retry = await (
      await post(
        ask({ clientMessageId: "c-f2", answerClientId: "a-f2", conversationId: first.conversation.id }),
      )
    ).json();
    expect(retry.ok).toBe(true);
    await runBackground();
    expect(radarCalls).toHaveLength(0);
    expect(candStore.cands.size).toBe(1);
  });

  it("resolution confirmations do not create incidents", async () => {
    const res = await post(
      ask({ message: "Resolved, thanks — the fix worked.", clientMessageId: "c-r", answerClientId: "a-r" }),
    );
    expect(res.status).toBe(200);
    await runBackground();
    expect(candStore.cands.size).toBe(0);
    expect(afterCalls).toHaveLength(0);
  });

  it("judge outage defers honestly without inventing a candidate", async () => {
    judgeMode = "throw";
    const res = await post(ask({ clientMessageId: "c-j", answerClientId: "a-j" }));
    expect(res.status).toBe(200);
    await runBackground();
    expect(candStore.cands.size).toBe(0);
    expect(
      decisions.some(
        (d) => (d as { outcome: string; reason?: string }).outcome === "detection_skipped",
      ),
    ).toBe(true);
  });

  it("workspaces stay isolated", async () => {
    const r1 = await post(ask({ clientMessageId: "c-w1", answerClientId: "a-w1" }));
    expect(r1.status).toBe(200);
    await runBackground();
    const r2 = await post(ask({ workspaceSlug: "other", asUser: "user-A", clientMessageId: "c-w2", answerClientId: "a-w2" }));
    expect(r2.status).toBe(200);
    await runBackground();
    expect(candStore.cands.size).toBe(2);
  });

  it("Walrus diagnostic fields remain intact on the success path", async () => {
    const data = await (await post(ask({ clientMessageId: "c-m", answerClientId: "a-m" }))).json();
    expect(data.memoryStatus).toEqual({ private: "ok", shared: "ok", knowledge: "ok" });
    expect(data.memoryErrorKinds).toEqual({ private: "empty", shared: "empty", knowledge: "empty" });
  });
});
