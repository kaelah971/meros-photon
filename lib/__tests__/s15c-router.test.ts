import { describe, expect, it, vi } from "vitest";
import {
  handleOperatorMessage,
  USAGE_TEXT,
  type OperatorBinding,
  type OperatorDeps,
  type OperatorWorkspace,
} from "../photon/operator";
import {
  parseRouterIntent,
  resolveReference,
  fitReply,
  helpText,
  type InvestigateReads,
} from "../photon/investigate";

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

const BRIEF = {
  status: "current",
  version: 2,
  fingerprint: "fp-abc123",
  generatedAt: "2026-10-18T12:00:00.000Z",
  facts: [{ observation: "Visa checkout returns HTTP 500", sources: ["m1", "m2"] }],
  unknowns: ["Root cause unknown"],
  contradictions: ["One reporter sees 402 instead of 500"],
};

const MATCH = {
  refId: "card-1",
  tier: "verified_fix",
  reasons: ["Same 500 on Visa checkout with a gateway-timeout cause"],
  symptoms: ["visa checkout http 500"],
  applicable: true,
  warning: "",
  cardStatus: "shared",
  cardResolved: true as boolean | null,
  excerpt: "Symptom: Visa 500. Cause: gateway timeout. Fix: retried idempotently.",
};

function makeReads(over: Partial<InvestigateReads> = {}, calls: string[] = []): InvestigateReads {
  return {
    workspaceSlug: async () => "acme",
    listActiveIncidents: async () => {
      calls.push("listActiveIncidents");
      return [INC];
    },
    listReviewCandidates: async () => {
      calls.push("listReviewCandidates");
      return [CAND];
    },
    getCandidate: async (id) => {
      calls.push(`getCandidate:${id}`);
      return id === CAND.id ? { ...CAND } : null;
    },
    getIncident: async (id) => {
      calls.push(`getIncident:${id}`);
      return id === INC.id ? { ...INC } : null;
    },
    getBrief: async () => {
      calls.push("getBrief");
      return { ...BRIEF, facts: BRIEF.facts.map((f) => ({ ...f, sources: [...f.sources] })), unknowns: [...BRIEF.unknowns], contradictions: [...BRIEF.contradictions] };
    },
    getMatches: async () => {
      calls.push("getMatches");
      return { current: true, fingerprint: "fp-abc123", rows: [{ ...MATCH, reasons: [...MATCH.reasons], symptoms: [...MATCH.symptoms] }] };
    },
    listDecisions: async () => {
      calls.push("listDecisions");
      return [{ kind: "candidate", label: "Review candidate: Visa checkout 500s", ref: CAND.id }];
    },
    recentRadarAlerts: async () => {
      calls.push("recentRadarAlerts");
      return [{ candidateId: CAND.id, createdAt: "2026-10-18T12:30:00.000Z" }];
    },
    ...over,
  };
}

function makeFakes(overrides: Partial<OperatorDeps> = {}, readsOver: Partial<InvestigateReads> = {}) {
  const inbounds = new Map<string, { id: string; status: string }>();
  const slots = new Map<string, string>();
  let seq = 0;
  const calls: string[] = [];
  const posts: string[] = [];
  const base: OperatorDeps = {
    findBinding: async () => BINDING,
    claimPairing: async () => null,
    noteThread: async () => {},
    checkStaff: async () => {},
    readStats: async () => ({ openIssues: 0, customers: 0, conversations: 0, pendingFixCards: 0, sharedFixes: 0 }),
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
    investigate: makeReads(readsOver, calls),
  };
  return { deps: { ...base, ...overrides } as OperatorDeps, posts, calls };
}

const IN = (text: string, id = "msg-1") => ({
  providerMessageId: id,
  threadId: "thread-1",
  senderHash: "sender-hash-1",
  text,
  isBot: false,
});

describe("intent parsing (pure)", () => {
  it("parses every supported command and common aliases", () => {
    expect(parseRouterIntent("help")).toEqual({ kind: "help" });
    expect(parseRouterIntent("  ?  ")).toEqual({ kind: "help" });
    expect(parseRouterIntent("incidents")).toEqual({ kind: "incidents" });
    expect(parseRouterIntent("/incidents")).toEqual({ kind: "incidents" });
    expect(parseRouterIntent("alerts")).toEqual({ kind: "alerts" });
    expect(parseRouterIntent("show me")).toEqual({ kind: "show" });
    expect(parseRouterIntent("SHOW")).toEqual({ kind: "show" });
    expect(parseRouterIntent("decisions")).toEqual({ kind: "decisions" });
    expect(parseRouterIntent("todo")).toEqual({ kind: "decisions" });
    expect(parseRouterIntent("investigate abc12345")).toEqual({ kind: "investigate", ref: "abc12345" });
    expect(parseRouterIntent("evidence abc12345")).toEqual({ kind: "evidence", ref: "abc12345" });
    expect(parseRouterIntent("brief abc12345")).toEqual({ kind: "evidence", ref: "abc12345" });
    expect(parseRouterIntent("matches abc12345")).toEqual({ kind: "matches", ref: "abc12345" });
    expect(parseRouterIntent("history abc12345")).toEqual({ kind: "matches", ref: "abc12345" });
  });

  it("rejects empty, overlong, and non-command text", () => {
    expect(parseRouterIntent("stats")).toBeNull();
    expect(parseRouterIntent("pair ABCD-1234")).toBeNull();
    expect(parseRouterIntent("")).toBeNull();
    expect(parseRouterIntent("   ")).toBeNull();
    expect(parseRouterIntent("investigate")).toBeNull();
    expect(parseRouterIntent("evidence " + "x".repeat(100))).toBeNull();
    expect(parseRouterIntent("please fix it now")).toBeNull();
    expect(parseRouterIntent("show me everything!!!")).toBeNull();
  });

  it("help text lists every supported command", () => {
    const h = helpText();
    for (const cmd of ["help", "incidents", "alerts", "show me", "investigate", "evidence", "matches", "decisions", "stats"]) {
      expect(h).toContain(cmd);
    }
    expect(h).not.toMatch(/approve|execute|close|resolve the incident/i);
  });

  it("resolves exact UUIDs, unique prefixes, and flags ambiguity", () => {
    const cands = [{ id: "aaaaaaaa-0000-0000-0000-000000000001", title: "A" }];
    const incs = [{ id: "bbbbbbbb-0000-0000-0000-000000000002", title: "B" }];
    expect(resolveReference(cands[0].id, cands, incs)).toMatchObject({ kind: "candidate" });
    expect(resolveReference("aaaaaaaa", cands, incs)).toMatchObject({ kind: "candidate" });
    expect(resolveReference("zzzz", cands, incs)).toEqual({ kind: "unknown" });
    expect(resolveReference("!!!", cands, incs)).toEqual({ kind: "unknown" });
    const both = resolveReference("abcd", [{ id: "abcd1111-0000-0000-0000-000000000001", title: "A" }], [{ id: "abcd2222-0000-0000-0000-000000000002", title: "B" }]);
    expect(both.kind).toBe("ambiguous");
  });

  it("caps replies at 1500 chars with a pointer", () => {
    const long = "x".repeat(2000);
    const out = fitReply(long, "/app/link");
    expect(out.length).toBeLessThanOrEqual(1500);
    expect(out).toContain("/app/link");
  });
});

describe("read-only investigation over Photon", () => {
  it("help lists commands without touching reads", async () => {
    const { deps, posts, calls } = makeFakes();
    const r = await handleOperatorMessage(IN("help"), deps);
    expect(r.action).toBe("help");
    expect(posts[0]).toContain("investigate");
    expect(calls).toEqual([]);
  });

  it("incidents lists active work with short refs", async () => {
    const { deps, posts } = makeFakes();
    const r = await handleOperatorMessage(IN("incidents", "m2"), deps);
    expect(r.action).toBe("incidents");
    expect(posts[0]).toMatch(/Visa outage/);
    expect(posts[0]).toMatch(/22222222/);
    expect(posts[0].length).toBeLessThanOrEqual(1500);
  });

  it("alerts lists pending candidates as unconfirmed", async () => {
    const { deps, posts } = makeFakes();
    const r = await handleOperatorMessage(IN("alerts", "m3"), deps);
    expect(r.action).toBe("alerts");
    expect(posts[0]).toMatch(/UNCONFIRMED/);
    expect(posts[0]).toMatch(/3 convos/);
  });

  it("show me resolves the operator's recent radar alert", async () => {
    const { deps, posts } = makeFakes();
    const r = await handleOperatorMessage(IN("show me", "m4"), deps);
    expect(r.action).toBe("show");
    expect(posts[0]).toMatch(/UNCONFIRMED/);
    expect(posts[0]).toMatch(/11111111/);
    expect(posts[0]).not.toMatch(/confirmed incident/i);
  });

  it("show me with no alert offers alerts instead of guessing", async () => {
    const { deps, posts } = makeFakes({}, { recentRadarAlerts: async () => [] });
    const r = await handleOperatorMessage(IN("show me", "m5"), deps);
    expect(r.action).toBe("show");
    expect(posts[0]).toMatch(/No Radar alert/);
    expect(posts[0]).toMatch(/alerts/);
  });

  it("show me with several alerts lists instead of picking", async () => {
    const other = { ...CAND, id: "33333333-3333-3333-3333-333333333333", title: "Refund delays" };
    const { deps, posts } = makeFakes({}, {
      recentRadarAlerts: async () => [
        { candidateId: CAND.id, createdAt: "2026-10-18T12:30:00.000Z" },
        { candidateId: other.id, createdAt: "2026-10-18T12:31:00.000Z" },
      ],
      getCandidate: async (id: string) => (id === CAND.id ? { ...CAND } : id === other.id ? { ...other } : null),
    });
    const r = await handleOperatorMessage(IN("show me", "m6"), deps);
    expect(r.action).toBe("clarify");
    expect(posts[0]).toMatch(/11111111/);
    expect(posts[0]).toMatch(/33333333/);
  });

  it("show me reports accepted and dismissed alerts honestly", async () => {
    const accepted = { ...CAND, status: "accepted", acceptedIncidentId: "22222222-2222-2222-2222-222222222222" };
    const d1 = makeFakes({}, { getCandidate: async () => ({ ...accepted }) });
    const r1 = await handleOperatorMessage(IN("show me", "m7"), d1.deps);
    expect(r1.action).toBe("show");
    expect(d1.posts[0]).toMatch(/now incident/);
    expect(d1.posts[0]).toMatch(/22222222/);
    const d2 = makeFakes({}, { getCandidate: async () => ({ ...CAND, status: "dismissed" }) });
    const r2 = await handleOperatorMessage(IN("show me", "m8"), d2.deps);
    expect(r2.action).toBe("show");
    expect(d2.posts[0]).toMatch(/dismissed/);
  });

  it("investigate covers pending candidates and confirmed incidents", async () => {
    const { deps, posts } = makeFakes();
    const r1 = await handleOperatorMessage(IN("investigate 11111111", "m9"), deps);
    expect(r1.action).toBe("investigate");
    expect(posts[0]).toMatch(/UNCONFIRMED/);
    expect(posts[0]).toMatch(/No recovery has been performed/);
    const r2 = await handleOperatorMessage(IN("investigate 22222222", "m10"), deps);
    expect(r2.action).toBe("investigate");
    expect(posts[1]).toMatch(/Visa outage/);
    expect(posts[1]).toMatch(/current v2/);
  });

  it("unknown and ambiguous references never guess", async () => {
    const { deps, posts } = makeFakes();
    const r1 = await handleOperatorMessage(IN("investigate deadbeef", "m11"), deps);
    expect(r1.action).toBe("clarify");
    expect(posts[0]).toMatch(/No candidate or incident matches/);
    const d2 = makeFakes({}, {
      listReviewCandidates: async () => [
        { ...CAND, id: "abcd1111-0000-0000-0000-000000000001", title: "Alpha" },
        { ...CAND, id: "abcd2222-0000-0000-0000-000000000002", title: "Beta" },
      ],
    });
    const r2 = await handleOperatorMessage(IN("investigate abcd", "m12"), d2.deps);
    expect(r2.action).toBe("clarify");
    expect(d2.posts[0]).toMatch(/full reference|Multiple records/);
  });

  it("evidence honors current/stale/missing states", async () => {
    const { deps, posts } = makeFakes();
    const r1 = await handleOperatorMessage(IN("evidence 22222222", "m13"), deps);
    expect(r1.action).toBe("evidence");
    expect(posts[0]).toMatch(/current v2/);
    expect(posts[0]).toMatch(/m1, m2/);
    const d2 = makeFakes({}, { getBrief: async () => ({ ...BRIEF, status: "stale" }) });
    const r2 = await handleOperatorMessage(IN("evidence 22222222", "m14"), d2.deps);
    expect(r2.action).toBe("evidence");
    expect(d2.posts[0]).toMatch(/stale/i);
    expect(d2.posts[0]).toMatch(/NOT current/);
    const d3 = makeFakes({}, { getBrief: async () => null });
    const r3 = await handleOperatorMessage(IN("evidence 22222222", "m15"), d3.deps);
    expect(d3.posts[0]).toMatch(/No evidence brief/);
    const d4 = makeFakes();
    const r4 = await handleOperatorMessage(IN("evidence 11111111", "m16"), d4.deps);
    expect(r4.action).toBe("clarify");
    expect(d4.posts[0]).toMatch(/UNCONFIRMED/);
  });

  it("matches show tiers honestly with uncertainty caveats", async () => {
    const { deps, posts } = makeFakes();
    const r = await handleOperatorMessage(IN("matches 22222222", "m17"), deps);
    expect(r.action).toBe("matches");
    expect(posts[0]).toMatch(/VERIFIED HISTORICAL FIX/);
    expect(posts[0]).toMatch(/card-1/);
    const d2 = makeFakes({}, {
      getMatches: async () => ({ current: false, fingerprint: "fp-old", rows: [{ ...MATCH, tier: "possible_match", applicable: false, warning: "only for app v1" }] }),
    });
    const r2 = await handleOperatorMessage(IN("matches 22222222", "m18"), d2.deps);
    expect(d2.posts[0]).toMatch(/STALE/);
    expect(d2.posts[0]).toMatch(/not directly applicable/);
    const d3 = makeFakes({}, { getMatches: async () => ({ current: true, fingerprint: "fp-x", rows: [] }) });
    const r3 = await handleOperatorMessage(IN("matches 22222222", "m19"), d3.deps);
    expect(d3.posts[0]).toMatch(/No historical matches stored/);
    expect(d3.posts[0]).not.toMatch(/novel.*guaranteed|definitely/i);
  });

  it("decisions summarizes outstanding work without acting", async () => {
    const { deps, posts, calls } = makeFakes();
    const r = await handleOperatorMessage(IN("decisions", "m20"), deps);
    expect(r.action).toBe("decisions");
    expect(posts[0]).toMatch(/Outstanding/);
    expect(posts[0]).toMatch(/never|web console/i);
  });

  it("pairing, stats, and unknown-command behavior are unchanged", async () => {
    const { deps, posts } = makeFakes();
    const r = await handleOperatorMessage(IN("frobnicate the database", "m21"), deps);
    expect(r.action).toBe("usage");
    expect(posts[0]).toBe(USAGE_TEXT);
    expect(USAGE_TEXT).toMatch(/investigate/);
  });
});

describe("security boundaries", () => {
  it("unknown senders get only pairing guidance", async () => {
    const { deps, posts } = makeFakes({ findBinding: async () => null });
    const r = await handleOperatorMessage(IN("matches 22222222", "m22"), deps);
    expect(r.action).toBe("pairing-required");
    expect(posts[0]).not.toMatch(/Visa|card-1|fp-/);
  });

  it("revoked/non-staff operators are denied without data", async () => {
    const { deps, posts } = makeFakes({
      checkStaff: async () => {
        throw Object.assign(new Error("not staff"), { status: 403 });
      },
    });
    const r = await handleOperatorMessage(IN("incidents", "m23"), deps);
    expect(r.action).toBe("denied");
    expect(posts[0]).not.toMatch(/Visa/);
  });

  it("foreign references resolve to unknown, never leak", async () => {
    const { deps, posts } = makeFakes();
    const r = await handleOperatorMessage(IN("investigate 99999999-9999-9999-9999-999999999999", "m24"), deps);
    expect(r.action).toBe("clarify");
    expect(posts[0]).toMatch(/No candidate or incident matches/);
  });
});

describe("delivery safety", () => {
  it("duplicate webhook delivery never sends twice", async () => {
    const { deps, posts } = makeFakes();
    const r1 = await handleOperatorMessage(IN("incidents", "dup-1"), deps);
    const r2 = await handleOperatorMessage(IN("incidents", "dup-1"), deps);
    expect(r1.action).toBe("incidents");
    expect(r2.action).toBe("deduped");
    expect(posts).toHaveLength(1);
  });

  it("read failure degrades honestly without leaking", async () => {
    const { deps, posts } = makeFakes({
      investigate: makeReads({ listActiveIncidents: async () => { throw new Error("db down"); } }),
    });
    const r = await handleOperatorMessage(IN("incidents", "m25"), deps);
    expect(r.action).toBe("unavailable");
    expect(posts).toHaveLength(0);
  });

  it("investigate stack performs reads only, single reply", async () => {
    const { deps, posts } = makeFakes();
    const r = await handleOperatorMessage(IN("evidence 22222222", "mx"), deps);
    expect(r.action).toBe("evidence");
    expect(posts).toHaveLength(1);
    expect(posts[0].length).toBeLessThanOrEqual(1500);
  });

  it("no investigate path without reads configured", async () => {
    const { deps, posts } = makeFakes({ investigate: undefined });
    const r = await handleOperatorMessage(IN("incidents", "m26"), deps);
    expect(r.action).toBe("unavailable");
    expect(posts).toHaveLength(0);
  });
});
