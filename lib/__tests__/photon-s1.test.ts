import { describe, expect, it, vi } from "vitest";
import {
  DENIED_TEXT,
  DEGRADED_TEXT,
  PAIRING_REQUIRED_TEXT,
  USAGE_TEXT,
  formatStatsReply,
  handleOperatorMessage,
  parsePairIntent,
  parseStatsIntent,
  type OperatorBinding,
  type OperatorDeps,
  type OperatorWorkspace,
} from "../photon/operator";
import { hashSender, mintPairingCode } from "../photon/bindings";
import { truncateBody } from "../photon/history";
import { PhotonNotConfiguredError, isPhotonConfigured } from "../photon/config";

// S1 Photon tests: zero Neon, zero network. The orchestrator is exercised
// through in-memory fakes that replicate the Neon unique semantics
// ((direction, provider_message_id) dedupe + single reply slot), so the
// dedupe/authorization decisions tested here are the ones that run in prod.

// ---- Intent parsing (pure) ----

describe("stats intent", () => {
  it("matches bare stats in any case", () => {
    expect(parseStatsIntent("stats")).toEqual({ slug: null });
    expect(parseStatsIntent("  STATS  ")).toEqual({ slug: null });
  });
  it("captures an explicit slug lowercased", () => {
    expect(parseStatsIntent("stats Acme")).toEqual({ slug: "acme" });
    expect(parseStatsIntent("stats northstar-support")).toEqual({ slug: "northstar-support" });
  });
  it("rejects non-commands", () => {
    expect(parseStatsIntent("")).toBeNull();
    expect(parseStatsIntent("statistics")).toBeNull();
    expect(parseStatsIntent("stats!")).toBeNull();
    expect(parseStatsIntent("stats a")).toBeNull();
    expect(parseStatsIntent("stats acme extra")).toBeNull();
    expect(parseStatsIntent("pair ABCD-1234-EFGH")).toBeNull();
  });
});

describe("pair intent", () => {
  it("captures codes uppercased", () => {
    expect(parsePairIntent("pair abcd-1234-efgh")).toEqual({ code: "ABCD-1234-EFGH" });
    expect(parsePairIntent("  PAIR xxxx-yyyy-zzzz  ")).toEqual({ code: "XXXX-YYYY-ZZZZ" });
  });
  it("rejects malformed pairing", () => {
    expect(parsePairIntent("pair")).toBeNull();
    expect(parsePairIntent("pair x")).toBeNull();
    expect(parsePairIntent("stats")).toBeNull();
  });
});

// ---- Reply formatting (pure, live numbers in — never demo numbers) ----

describe("stats reply", () => {
  it("renders live values with correct pluralization", () => {
    const text = formatStatsReply("Acme Support", {
      openIssues: 3,
      customers: 1,
      conversations: 12,
      pendingFixCards: 0,
      sharedFixes: 4,
    });
    expect(text).toContain("Acme Support");
    expect(text).toContain("12 conversations");
    expect(text).toContain("1 customer");
    expect(text).toContain("3 open issues");
    expect(text).toContain("0 Fix Cards waiting for review");
    expect(text).toContain("4 shared fixes");
  });
  it("singularizes every line at one", () => {
    const text = formatStatsReply("W", {
      openIssues: 1,
      customers: 1,
      conversations: 1,
      pendingFixCards: 1,
      sharedFixes: 1,
    });
    expect(text).toContain("1 conversation\n");
    expect(text).toContain("1 open issue\n");
    expect(text).toContain("1 Fix Card waiting for review");
    expect(text).toContain("1 shared fix\n");
  });
});

// ---- Sender hashing + pairing codes ----

describe("sender identity", () => {
  it("hashes deterministically and never embeds the raw handle", () => {
    const a = hashSender("+15551234567", "test-salt");
    expect(hashSender("+15551234567", "test-salt")).toBe(a);
    expect(a).not.toContain("15551234567");
    expect(hashSender("+15557654321", "test-salt")).not.toBe(a);
    expect(hashSender("+15551234567", "other-salt")).not.toBe(a);
  });
  it("mints unique XXXX-XXXX-XXXX codes", () => {
    const codes = new Set(Array.from({ length: 50 }, () => mintPairingCode()));
    expect(codes.size).toBe(50);
    for (const c of codes) expect(c).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
  });
  it("truncates stored text", () => {
    expect(truncateBody("  hi  ")).toBe("hi");
    expect(truncateBody("x".repeat(600)).length).toBeLessThanOrEqual(500);
  });
});

// ---- Orchestrator with fakes replicating Neon semantics ----

const WS: OperatorWorkspace = { id: "ws-1", slug: "acme", name: "Acme Support" };
const BINDING: OperatorBinding = { id: "bind-1", workspaceId: WS.id, operatorUserId: "user-1" };

function makeFakes(overrides: Partial<OperatorDeps> = {}) {
  const inbounds = new Map<string, { id: string; status: string }>();
  const slots = new Map<string, string>(); // inboundId -> outboundId
  let seq = 0;
  const posts: string[] = [];
  const base: OperatorDeps = {
    findBinding: async () => BINDING,
    claimPairing: async () => null,
    checkStaff: async () => {},
    readStats: async () => ({
      openIssues: 3,
      customers: 5,
      conversations: 12,
      pendingFixCards: 2,
      sharedFixes: 4,
    }),
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
      const rec = [...inbounds.values()].find((r) => r.id === input.inboundId);
      void rec;
      return { id };
    },
    markSent: async () => {},
    releaseSlot: async (outboundId) => {
      for (const [k, v] of slots) if (v === outboundId) slots.delete(k);
    },
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
  };
  return { deps: { ...base, ...overrides } as OperatorDeps, posts, inbounds, slots };
}

const IN = {
  providerMessageId: "msg-1",
  threadId: "thread-1",
  senderHash: "sender-hash-1",
  text: "stats",
  isBot: false,
};

describe("operator authorization", () => {
  it("unknown sender gets pairing guidance only — zero workspace data", async () => {
    const { deps, posts } = makeFakes({ findBinding: async () => null });
    const res = await handleOperatorMessage(IN, deps);
    expect(res.action).toBe("pairing-required");
    expect(posts).toHaveLength(1);
    expect(posts[0]).toBe(PAIRING_REQUIRED_TEXT);
    for (const p of posts) {
      expect(p).not.toContain("Acme");
      expect(p).not.toMatch(/\d+ conversations/);
    }
  });

  it("membership failure blocks stats with a safe denial", async () => {
    const { deps, posts } = makeFakes({
      checkStaff: async () => {
        throw Object.assign(new Error("staff access required"), { status: 403 });
      },
    });
    const res = await handleOperatorMessage(IN, deps);
    expect(res.action).toBe("denied");
    expect(posts).toHaveLength(1);
    expect(posts[0]).toBe(DENIED_TEXT);
    expect(posts[0]).not.toMatch(/\d+ conversations/);
  });

  it("active binding resolves to live stats (not hardcoded)", async () => {
    const { deps, posts } = makeFakes({
      readStats: async () => ({
        openIssues: 7,
        customers: 9,
        conversations: 21,
        pendingFixCards: 1,
        sharedFixes: 0,
      }),
    });
    const res = await handleOperatorMessage(IN, deps);
    expect(res.action).toBe("stats");
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("Acme Support");
    expect(posts[0]).toContain("21 conversations");
    expect(posts[0]).toContain("7 open issues");
  });

  it("explicit foreign slug is denied without stats", async () => {
    const { deps, posts } = makeFakes({
      findWorkspaceBySlug: async () => ({ id: "ws-evil", slug: "evil", name: "Evil Corp" }),
      checkStaff: async (userId, workspaceId) => {
        if (workspaceId !== WS.id) throw Object.assign(new Error("staff access required"), { status: 403 });
      },
    });
    const res = await handleOperatorMessage({ ...IN, text: "stats evil" }, deps);
    expect(res.action).toBe("denied");
    expect(posts[0]).not.toContain("Evil Corp");
  });

  it("non-command text from a paired operator gets usage, not data", async () => {
    const { deps, posts } = makeFakes();
    const res = await handleOperatorMessage({ ...IN, text: "hello?" }, deps);
    expect(res.action).toBe("usage");
    expect(posts[0]).toBe(USAGE_TEXT);
  });
});

describe("pairing flow", () => {
  it("valid code pairs the sender", async () => {
    const { deps, posts } = makeFakes({ claimPairing: async () => BINDING });
    const res = await handleOperatorMessage({ ...IN, text: "pair ABCD-1234-EFGH" }, deps);
    expect(res.action).toBe("paired");
    expect(posts[0]).toContain("paired");
    expect(posts[0]).toContain("Acme Support");
  });
  it("bad code fails closed without workspace data", async () => {
    const { deps, posts } = makeFakes({ findBinding: async () => null });
    const res = await handleOperatorMessage({ ...IN, text: "pair NOPE-0000-XXXX" }, deps);
    expect(res.action).toBe("pair-failed");
    expect(posts[0]).not.toMatch(/\d+ conversations/);
  });
});

describe("at-least-once dedupe", () => {
  it("redelivery of a replied message is a no-op (no second reply)", async () => {
    const { deps, posts } = makeFakes();
    const first = await handleOperatorMessage(IN, deps);
    expect(first.action).toBe("stats");
    expect(posts).toHaveLength(1);
    const second = await handleOperatorMessage(IN, deps);
    expect(second).toEqual({ action: "deduped" });
    expect(posts).toHaveLength(1);
  });

  it("two racers on one unreplied inbound produce one reply", async () => {
    const shared = { id: "in-race", status: "received" };
    const f = makeFakes({
      recordInbound: async () => ({ ...shared, deduped: true }),
    });
    const [a, b] = await Promise.all([
      handleOperatorMessage(IN, f.deps),
      handleOperatorMessage({ ...IN }, f.deps),
    ]);
    expect(f.posts).toHaveLength(1);
    expect([a.action, b.action]).toContain("stats");
  });

  it("bot's own messages are ignored without persistence", async () => {
    const { deps, posts } = makeFakes({ recordInbound: vi.fn() });
    const res = await handleOperatorMessage({ ...IN, isBot: true }, deps);
    expect(res).toEqual({ action: "ignored" });
    expect(deps.recordInbound).not.toHaveBeenCalled();
    expect(posts).toHaveLength(0);
  });
});

describe("failure honesty", () => {
  it("database outage degrades without fake success", async () => {
    const { deps, posts } = makeFakes({
      recordInbound: async () => {
        throw Object.assign(new Error("database unavailable"), { status: 503 });
      },
    });
    const res = await handleOperatorMessage(IN, deps);
    expect(res.action).toBe("degraded");
    expect(posts[0]).toBe(DEGRADED_TEXT);
  });

  it("photon-unconfigured path fails honestly", async () => {
    expect(isPhotonConfigured()).toBe(false);
    const { getBot } = await import("../photon/bot");
    expect(() => getBot()).toThrowError(PhotonNotConfiguredError);
    try {
      getBot();
    } catch (e) {
      expect((e as PhotonNotConfiguredError).needed).toEqual([
        "IMESSAGE_PROJECT_ID",
        "IMESSAGE_PROJECT_SECRET",
        "IMESSAGE_WEBHOOK_SECRET",
      ]);
    }
  }, 120_000);
});
