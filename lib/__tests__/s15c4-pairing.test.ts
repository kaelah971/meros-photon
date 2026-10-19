import { describe, expect, it, vi } from "vitest";
import {
  handleOperatorMessage,
  PAIR_CONFLICT_TEXT,
  PAIR_FAILED_TEXT,
  type OperatorBinding,
  type OperatorDeps,
} from "../photon/operator";
import {
  composeLink,
  formatCountdown,
  pairingMessage,
  pairingSecondsLeft,
  qrPayloadForPairing,
  sanitizePairingContact,
} from "../photon/pairing-link";

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("chat", () => ({ Chat: class {} }));
vi.mock("@photon-ai/chat-adapter-imessage", () => ({ createiMessageAdapter: () => ({}) }));

const BINDING: OperatorBinding = { id: "bind-1", workspaceId: "ws-novacart", operatorUserId: "user-1", threadId: null };

function makeFakes(overrides: Partial<OperatorDeps> = {}) {
  const inbounds = new Map<string, { id: string; status: string }>();
  const slots = new Map<string, string>();
  let seq = 0;
  const posts: string[] = [];
  let claims = 0;
  const base: OperatorDeps = {
    findBinding: async () => null,
    claimPairing: async () => {
      claims++;
      return BINDING;
    },
    pendingCodeWorkspace: async () => ({ workspaceId: "ws-novacart" }),
    senderOtherWorkspaces: async () => [],
    noteThread: async () => {},
    checkStaff: async () => {},
    readStats: async () => ({ openIssues: 0, customers: 0, conversations: 0, pendingFixCards: 0, sharedFixes: 0 }),
    findWorkspaceBySlug: async () => null,
    listWorkspaces: async () => [{ id: "ws-novacart", slug: "novacart", name: "NovaCart Support" }],
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
  };
  return { deps: { ...base, ...overrides } as OperatorDeps, posts, claims: () => claims };
}

const IN = (text: string, id = "p4-1") => ({
  providerMessageId: id,
  threadId: "thread-1",
  senderHash: "sender-hash-9",
  text,
  isBot: false,
});

describe("S15C.4 pairing links (pure)", () => {
  it("builds an honest compose link, never auto-sending", () => {
    expect(pairingMessage("abcd-1234-efgh")).toBe("pair ABCD-1234-EFGH");
    expect(composeLink("ABCD-1234-EFGH", null)).toBe("sms:&body=pair%20ABCD-1234-EFGH");
    expect(composeLink("ABCD-1234-EFGH", "+15551234567")).toBe(
      "sms:+15551234567&body=pair%20ABCD-1234-EFGH",
    );
    expect(qrPayloadForPairing("ABCD-1234-EFGH", null)).toBe(composeLink("ABCD-1234-EFGH", null));
  });

  it("counts down expiry honestly", () => {
    expect(pairingSecondsLeft(new Date(Date.now() + 90_000).toISOString(), Date.now())).toBeLessThanOrEqual(90);
    expect(pairingSecondsLeft(new Date(Date.now() - 1000).toISOString())).toBe(0);
    expect(pairingSecondsLeft("not-a-date")).toBe(0);
    expect(formatCountdown(899)).toBe("14:59");
    expect(formatCountdown(0)).toBe("0:00");
  });

  it("sanitizes the configured contact, never trusting arbitrary input", () => {
    expect(sanitizePairingContact("+15551234567")).toBe("+15551234567");
    expect(sanitizePairingContact("  (555) 123-4567 ")).toBe("(555) 123-4567");
    expect(sanitizePairingContact("https://evil.example/x")).toBeNull();
    expect(sanitizePairingContact("ABC123")).toBeNull();
    expect(sanitizePairingContact(undefined)).toBeNull();
  });
});

describe("S15C.4 multi-workspace pairing safety", () => {
  it("blocks a silent workspace switch and keeps the code valid", async () => {
    const f = makeFakes({ senderOtherWorkspaces: async () => ["ws-northstar"] });
    const r = await handleOperatorMessage(IN("pair ABCD-1234-EFGH", "c-1"), f.deps);
    expect(r.action).toBe("pair-conflict");
    expect(f.posts[0]).toBe(PAIR_CONFLICT_TEXT);
    expect(f.claims()).toBe(0);
    // No workspace ids or hashes leak into the reply.
    expect(f.posts[0]).not.toContain("ws-");
    expect(f.posts[0]).toMatch(/code still works/i);
  });

  it("pairs normally when the sender has no other workspace", async () => {
    const f = makeFakes();
    const r = await handleOperatorMessage(IN("pair ABCD-1234-EFGH", "c-2"), f.deps);
    expect(r.action).toBe("paired");
    expect(f.claims()).toBe(1);
  });

  it("unknown/expired codes still fail closed", async () => {
    const f = makeFakes({ pendingCodeWorkspace: async () => null, claimPairing: async () => null });
    const r = await handleOperatorMessage(IN("pair ZZZZ-9999-XXXX", "c-3"), f.deps);
    expect(r.action).toBe("pair-failed");
    expect(f.posts[0]).toBe(PAIR_FAILED_TEXT);
  });

  it("legacy deps without conflict checks keep working", async () => {
    const f = makeFakes({ pendingCodeWorkspace: undefined, senderOtherWorkspaces: undefined });
    const r = await handleOperatorMessage(IN("pair ABCD-1234-EFGH", "c-4"), f.deps);
    expect(r.action).toBe("paired");
  });
});

describe("S15C.4 bindings route (auth-gated)", () => {
  vi.mock("@/lib/auth", () => ({
    requireUser: async () => {
      throw Object.assign(new Error("not signed in"), { status: 401 });
    },
  }));

  it("rejects unauthenticated code issuance", async () => {
    const { POST } = await import("@/app/api/photon/bindings/route");
    const res = await POST(
      new Request("http://x/api", { method: "POST", body: JSON.stringify({ workspaceSlug: "acme" }) }),
    );
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.ok).toBe(false);
  });
});

describe("S15C.4 production wiring carries the conflict checks", () => {
  it("realDeps() supplies pendingCodeWorkspace + senderOtherWorkspaces", async () => {
    const { realDeps } = await import("../photon/bot");
    const deps = realDeps();
    expect(typeof deps.pendingCodeWorkspace).toBe("function");
    expect(typeof deps.senderOtherWorkspaces).toBe("function");
  });
});
