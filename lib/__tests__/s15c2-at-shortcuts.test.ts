import { describe, expect, it, vi } from "vitest";
import {
  handleOperatorMessage,
  USAGE_TEXT,
  DENIED_TEXT,
  AT_MENU_TEXT,
  parseAtIntent,
  type OperatorBinding,
  type OperatorDeps,
  type OperatorWorkspace,
} from "../photon/operator";
import type { InvestigateReads } from "../photon/investigate";
import { factsText } from "../photon/converse";
import type { ConversePlan, ConverseTurn } from "../photon/converse";

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const WS: OperatorWorkspace = { id: "ws-1", slug: "acme", name: "Acme Support" };
const BINDING: OperatorBinding = { id: "bind-1", workspaceId: WS.id, operatorUserId: "user-1", threadId: "thread-1" };

const CAND = {
  id: "11111111-1111-1111-1111-111111111111",
  title: "Visa checkout returns HTTP 500 on pay",
  summary: "Three customers report 500s on Visa pay at checkout.",
  status: "pending",
  confidence: "high",
  rationale: "Same symptom across three conversations.",
  acceptedIncidentId: null as string | null,
  conversations: 3,
  customers: 3,
  messages: 4,
  updatedAt: "2026-10-18T12:00:00.000Z",
};

const INC = {
  id: "22222222-2222-2222-2222-222222222222",
  title: "Visa outage",
  status: "investigating",
  severity: "high",
  customers: 2,
  conversations: 2,
  evidence: 3,
  updatedAt: "2026-10-18T12:00:00.000Z",
};

function makeReads(over: Partial<InvestigateReads> = {}) {
  const base: InvestigateReads = {
    workspaceSlug: async () => "acme",
    listActiveIncidents: async () => [{ ...INC }],
    listReviewCandidates: async () => [{ ...CAND }],
    getCandidate: async (id: string) => (id === CAND.id ? { ...CAND } : null),
    getIncident: async (id: string) => (id === INC.id ? { ...INC } : null),
    getBrief: async () => ({
      status: "current",
      version: 2,
      fingerprint: "fp-abc123",
      generatedAt: "2026-10-18T12:00:00.000Z",
      facts: [{ observation: "Visa checkout returns HTTP 500", sources: ["m1", "m2"] }],
      unknowns: ["Root cause unknown"],
      contradictions: [],
    }),
    getMatches: async () => ({ current: true, fingerprint: "fp-abc123", rows: [] }),
    listDecisions: async () => [
      { kind: "candidate", label: "Review candidate: Visa checkout 500s", ref: CAND.id },
    ],
    recentRadarAlerts: async () => [],
  };
  return { ...base, ...over } as InvestigateReads;
}

// Production-shaped fakes: BOTH converse and investigate supplied, exactly
// like realDeps() in lib/photon/bot.ts. Model offline → deterministic
// conversational fallback (never USAGE_TEXT).
function makeFakes(overrides: Partial<OperatorDeps> = {}, readsOver: Partial<InvestigateReads> = {}) {
  const inbounds = new Map<string, { id: string; status: string }>();
  const slots = new Map<string, string>();
  let seq = 0;
  const posts: string[] = [];
  const statsCalls: string[] = [];
  const base: OperatorDeps = {
    findBinding: async () => BINDING,
    claimPairing: async () => null,
    noteThread: async () => {},
    checkStaff: async () => {},
    readStats: async (workspaceId: string) => {
      statsCalls.push(workspaceId);
      return { openIssues: 3, customers: 5, conversations: 21, pendingFixCards: 1, sharedFixes: 0 };
    },
    findWorkspaceBySlug: async (slug) => (slug === WS.slug ? WS : null),
    listWorkspaces: async () => [WS],
    recordInbound: async (input) => {
      const key = input.providerMessageId ?? `null-${seq++}`;
      const existing = input.providerMessageId ? inbounds.get(key) : undefined;
      if (existing) return { id: existing.id, status: existing.status, deduped: true };
      const id = `in-${seq++}`;
      inbounds.set(key, { id, status: "received" });
      return { id, status: "received", deduped: false };
    },
    claimReply: async (input) => {
      if (slots.has(input.inboundId)) return null;
      const id = `out-${seq++}`;
      slots.set(input.inboundId, id);
      return { id };
    },
    markSent: async () => {},
    releaseSlot: async () => {},
    markReplied: async (inboundId) => {
      for (const r of inbounds.values()) if (r.id === inboundId) r.status = "replied";
    },
    markRejected: async (inboundId) => {
      for (const r of inbounds.values()) if (r.id === inboundId) r.status = "rejected";
    },
    post: async (text) => {
      posts.push(text);
      return { providerId: `prov-${posts.length}` };
    },
    investigate: makeReads(readsOver),
    converse: {
      loadHistory: async () => [],
      classify: async (text: string) => {
        const { fastClassify: fast, unknownPlan } = await import("../photon/converse");
        return fast(text) ?? unknownPlan();
      },
      phrase: async () => {
        throw new Error("model offline (test fallback)");
      },
    },
  };
  return { deps: { ...base, ...overrides } as OperatorDeps, posts, statsCalls };
}

const IN = (text: string, id = "msg-1") => ({
  providerMessageId: id,
  threadId: "thread-1",
  senderHash: "sender-hash-1",
  text,
  isBot: false,
});

describe("S15C.2 production regression: natural language never gets the legacy menu", () => {
  it("'hey meros, what's happening today?' reaches conversational mode, not USAGE_TEXT", async () => {
    const f = makeFakes();
    const r = await handleOperatorMessage(IN("hey meros, what's happening today?", "live-1"), f.deps);
    expect(r.action).toBe("converse");
    expect(f.posts[0]).not.toBe(USAGE_TEXT);
    expect(f.posts[0]).toContain("Visa outage");
  });

  it.each(["hi", "hey", "hello meros", "good morning", "how are things?", "anything I should worry about?", "what needs my attention?", "are customers reporting problems?", "tell me more", "why?", "what should we do next?"])(
    "'%s' is conversational, never the command menu",
    async (text) => {
      const f = makeFakes();
      const r = await handleOperatorMessage(IN(text, `g-${text.length}`), f.deps);
      expect(r.action).toBe("converse");
      expect(f.posts[0]).not.toBe(USAGE_TEXT);
    },
  );

  it("model classify failure still yields a grounded conversational reply", async () => {
    const f = makeFakes({
      converse: {
        loadHistory: async () => [],
        classify: async (): Promise<ConversePlan> => {
          throw new Error("gemini down");
        },
        phrase: async () => {
          throw new Error("gemini down");
        },
      },
    });
    const r = await handleOperatorMessage(IN("hey meros, what's happening today?", "live-2"), f.deps);
    expect(r.action).toBe("converse");
    expect(f.posts[0]).not.toBe(USAGE_TEXT);
  });

  it("empty workspace stays calm and honest without inventing records", async () => {
    const f = makeFakes(
      {},
      { listActiveIncidents: async () => [], listReviewCandidates: async () => [] },
      );
    const g = makeFakes(
      { readStats: async () => ({ openIssues: 0, customers: 0, conversations: 0, pendingFixCards: 0, sharedFixes: 0 }) },
      { listActiveIncidents: async () => [], listReviewCandidates: async () => [] },
    );
    void f;
    const r = await handleOperatorMessage(IN("hey meros, what's happening today?", "live-3"), g.deps);
    expect(r.action).toBe("converse");
    expect(g.posts[0]).not.toBe(USAGE_TEXT);
    expect(g.posts[0]).toMatch(/quiet|no active incidents/i);
  });

  it("today-questions get time-honest facts (totals never framed as today's activity)", async () => {
    const { gatherContext } = await import("../photon/converse");
    const reads = makeReads();
    const ctx = await gatherContext({
      plan: { kind: "status", refHint: null, topic: null },
      text: "what's happening today?",
      history: [],
      workspaceId: WS.id,
      operatorUserId: "user-1",
      workspaceName: WS.name,
      slug: WS.slug,
      stats: { openIssues: 3, customers: 5, conversations: 21, pendingFixCards: 1, sharedFixes: 0 },
      reads,
    });
    const facts = factsText(ctx, { kind: "status", refHint: null, topic: null }, WS.slug);
    expect(facts).toMatch(/all-time.*not today's activity/i);
  });
});

describe("S15C.2 @ shortcuts", () => {
  it("parses @ intents purely (@ alone, aliases, unknown)", () => {
    expect(parseAtIntent("@")).toEqual({ kind: "menu" });
    expect(parseAtIntent("@help")).toEqual({ kind: "menu" });
    expect(parseAtIntent("  @status  ")).toEqual({ kind: "status" });
    expect(parseAtIntent("@alerts")).toEqual({ kind: "alerts" });
    expect(parseAtIntent("@incidents")).toEqual({ kind: "incidents" });
    expect(parseAtIntent("@reviews")).toEqual({ kind: "reviews" });
    expect(parseAtIntent("@memory")).toEqual({ kind: "memory" });
    expect(parseAtIntent("@frobnicate")).toEqual({ kind: "menu" });
    expect(parseAtIntent("stats")).toBeNull();
    expect(parseAtIntent("hey meros")).toBeNull();
  });

  it("'@' returns the friendly compact menu and notes natural language works", async () => {
    const f = makeFakes();
    const r = await handleOperatorMessage(IN("@", "at-1"), f.deps);
    expect(r.action).toBe("at-menu");
    expect(f.posts[0]).toBe(AT_MENU_TEXT);
    for (const alias of ["@status", "@alerts", "@incidents", "@reviews", "@memory", "@help"]) {
      expect(f.posts[0]).toContain(alias);
    }
    expect(f.posts[0]).toMatch(/plain words/i);
  });

  it("'@help' and unknown '@foo' also show the menu", async () => {
    for (const [text, id] of [["@help", "at-2"], ["@frobnicate", "at-3"]] as const) {
      const f = makeFakes();
      const r = await handleOperatorMessage(IN(text, id), f.deps);
      expect(r.action).toBe("at-menu");
      expect(f.posts[0]).toBe(AT_MENU_TEXT);
    }
  });

  it("@status returns the live workspace overview", async () => {
    const f = makeFakes();
    const r = await handleOperatorMessage(IN("@status", "at-4"), f.deps);
    expect(r.action).toBe("stats");
    expect(f.posts[0]).toContain("Acme Support");
    expect(f.statsCalls).toEqual([WS.id]);
  });

  it("@alerts / @incidents / @reviews reuse the existing read models", async () => {
    const cases = [["@alerts", "alerts"], ["@incidents", "incidents"], ["@reviews", "decisions"]] as const;
    for (const [text, action] of cases) {
      const f = makeFakes();
      const r = await handleOperatorMessage(IN(text, `at-${action}`), f.deps);
      expect(r.action).toBe(action);
      expect(f.posts[0]).not.toBe(USAGE_TEXT);
    }
  });

  it("@memory points at the authenticated Fix Cards library without inventing results", async () => {
    const f = makeFakes();
    const r = await handleOperatorMessage(IN("@memory", "at-5"), f.deps);
    expect(r.action).toBe("at-memory");
    expect(f.posts[0]).toContain("/app/workspaces/acme/fix-cards");
    expect(f.posts[0]).not.toContain("card-9");
  });
});

describe("S15C.2 authorization and delivery safety", () => {
  it("unknown senders get only pairing guidance for @ and natural text", async () => {
    for (const text of ["@", "@status", "hey meros, what's happening today?"]) {
      const f = makeFakes({ findBinding: async () => null });
      const r = await handleOperatorMessage(IN(text, `u-${text.length}`), f.deps);
      expect(r.action).toBe("pairing-required");
    }
  });

  it("revoked operators are denied with zero workspace data", async () => {
    for (const text of ["@", "@status", "hey meros, what's happening today?"]) {
      const f = makeFakes({
        checkStaff: async () => {
          throw new Error("not staff");
        },
      });
      const r = await handleOperatorMessage(IN(text, `v-${text.length}`), f.deps);
      expect(r.action).toBe("denied");
      expect(f.posts[0]).toBe(DENIED_TEXT);
    }
  });

  it("@status stays scoped to the binding workspace (no cross-workspace leak)", async () => {
    const other: OperatorBinding = { id: "bind-9", workspaceId: "ws-foreign", operatorUserId: "user-1", threadId: "t" };
    const f = makeFakes({ findBinding: async () => other });
    const r = await handleOperatorMessage(IN("@status", "x-1"), f.deps);
    expect(r.action).toBe("stats");
    expect(f.statsCalls).toEqual(["ws-foreign"]);
  });

  it("duplicate webhook delivery never sends twice", async () => {
    const f = makeFakes();
    const first = await handleOperatorMessage(IN("@", "dup-1"), f.deps);
    const second = await handleOperatorMessage(IN("@", "dup-1"), f.deps);
    expect(first.action).toBe("at-menu");
    expect(second.action).toBe("deduped");
    expect(f.posts).toHaveLength(1);
  });

  it("old exact commands still bypass converse and @ handling", async () => {
    const f = makeFakes();
    let classifyCalls = 0;
    const deps: OperatorDeps = {
      ...f.deps,
      converse: {
        loadHistory: async () => [] as ConverseTurn[],
        classify: async (text: string, h: ConverseTurn[]) => {
          classifyCalls++;
          const { fastClassify: fast, unknownPlan } = await import("../photon/converse");
          return fast(text) ?? unknownPlan();
        },
        phrase: async () => {
          throw new Error("offline");
        },
      },
    };
    expect((await handleOperatorMessage(IN("stats", "c1"), deps)).action).toBe("stats");
    expect((await handleOperatorMessage(IN("incidents", "c2"), deps)).action).toBe("incidents");
    expect((await handleOperatorMessage(IN("alerts", "c3"), deps)).action).toBe("alerts");
    expect((await handleOperatorMessage(IN("decisions", "c4"), deps)).action).toBe("decisions");
    expect((await handleOperatorMessage(IN("@status", "c5"), deps)).action).toBe("stats");
    expect(classifyCalls).toBe(0);
  });

  it("approval/customer-message requests stay read-only with console guidance", async () => {
    const f = makeFakes();
    const r = await handleOperatorMessage(IN("approve the recovery and message everyone", "safe-1"), f.deps);
    expect(r.action).toBe("converse");
    expect(f.posts[0]).toMatch(/console/i);
    expect(f.posts).toHaveLength(1);
  });
});

vi.mock("chat", () => ({ Chat: class {} }));
vi.mock("@photon-ai/chat-adapter-imessage", () => ({ createiMessageAdapter: () => ({}) }));

describe("S15C.2 production wiring supplies conversational deps", () => {
  it("realDeps() always provides converse + investigate (the missing seam in the stale deploy)", async () => {
    const { realDeps } = await import("../photon/bot");
    const deps = realDeps();
    expect(deps.investigate).toBeDefined();
    expect(typeof deps.converse?.loadHistory).toBe("function");
    expect(typeof deps.converse?.classify).toBe("function");
    expect(typeof deps.converse?.phrase).toBe("function");
  });
});
