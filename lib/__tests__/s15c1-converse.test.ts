import { describe, expect, it, vi } from "vitest";
import {
  handleOperatorMessage,
  USAGE_TEXT,
  DENIED_TEXT,
  type OperatorBinding,
  type OperatorDeps,
  type OperatorWorkspace,
} from "../photon/operator";
import type { InvestigateReads } from "../photon/investigate";
import {
  fastClassify,
  validateConversePlan,
  inferSelectedRef,
  fitConverse,
  capFor,
  fallbackReply,
  factsText,
  type ConversePlan,
  type ConverseTurn,
} from "../photon/converse";

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

const INC2 = {
  ...INC,
  id: "44444444-4444-4444-4444-444444444444",
  title: "Refund delays",
  status: "open",
  severity: "medium",
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
  refId: "card-9",
  tier: "verified_fix",
  reasons: ["Same 500 on Visa checkout with a gateway-timeout cause"],
  symptoms: ["visa checkout http 500"],
  applicable: true,
  warning: "",
  cardStatus: "shared",
  cardResolved: true as boolean | null,
  excerpt: "Symptom: Visa 500. Cause: gateway timeout. Fix: retried idempotently.",
};

function makeReads(over: Partial<InvestigateReads> = {}) {
  const base: InvestigateReads = {
    workspaceSlug: async () => "acme",
    listActiveIncidents: async () => [{ ...INC }],
    listReviewCandidates: async () => [{ ...CAND }],
    getCandidate: async (id: string) => (id === CAND.id ? { ...CAND } : null),
    getIncident: async (id: string) => (id === INC.id ? { ...INC } : id === INC2.id ? { ...INC2 } : null),
    getBrief: async () => ({
      ...BRIEF,
      facts: BRIEF.facts.map((f) => ({ ...f, sources: [...f.sources] })),
      unknowns: [...BRIEF.unknowns],
      contradictions: [...BRIEF.contradictions],
    }),
    getMatches: async () => ({
      current: true,
      fingerprint: "fp-abc123",
      rows: [{ ...MATCH, reasons: [...MATCH.reasons], symptoms: [...MATCH.symptoms] }],
    }),
    listDecisions: async () => [
      { kind: "candidate", label: "Review candidate: Visa checkout 500s", ref: CAND.id },
    ],
    recentRadarAlerts: async () => [],
  };
  return { ...base, ...over } as InvestigateReads;
}

function makeFakes(overrides: Partial<OperatorDeps> = {}, readsOver: Partial<InvestigateReads> = {}) {
  const inbounds = new Map<string, { id: string; status: string }>();
  const slots = new Map<string, string>();
  let seq = 0;
  const posts: string[] = [];
  const historyCalls: { workspaceId: string; bindingId: string }[] = [];
  let history: ConverseTurn[] = [];
  let classifyImpl: (text: string, h: ConverseTurn[]) => Promise<ConversePlan> = async (text) => {
    const { fastClassify: fast, unknownPlan } = await import("../photon/converse");
    return fast(text) ?? unknownPlan();
  };
  let phraseImpl: (input: { text: string; history: ConverseTurn[]; facts: string; kind: string; detailed: boolean }) => Promise<string> = async () => {
    throw new Error("model offline (test fallback)");
  };
  const base: OperatorDeps = {
    findBinding: async () => BINDING,
    claimPairing: async () => null,
    noteThread: async () => {},
    checkStaff: async () => {},
    readStats: async () => ({ openIssues: 3, customers: 5, conversations: 21, pendingFixCards: 1, sharedFixes: 0 }),
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
    investigate: makeReads(readsOver),
    converse: {
      loadHistory: async (workspaceId, bindingId) => {
        historyCalls.push({ workspaceId, bindingId });
        return history;
      },
      classify: async (text, h) => classifyImpl(text, h),
      phrase: async (input) => phraseImpl(input as { text: string; history: ConverseTurn[]; facts: string; kind: string; detailed: boolean }) as unknown as string,
    },
  };
  return {
    deps: { ...base, ...overrides } as OperatorDeps,
    posts,
    historyCalls,
    setHistory: (h: ConverseTurn[]) => {
      history = h;
    },
    setClassify: (fn: typeof classifyImpl) => {
      classifyImpl = fn;
    },
    setPhrase: (fn: typeof phraseImpl) => {
      phraseImpl = fn;
    },
  };
}

const IN = (text: string, id = "msg-1") => ({
  providerMessageId: id,
  threadId: "thread-1",
  senderHash: "sender-hash-1",
  text,
  isBot: false,
});

describe("conversational intent fast paths (pure)", () => {
  const cases: [string, string][] = [
    ["hey meros", "greeting"],
    ["what's happening today?", "status"],
    ["anything I should worry about?", "worry"],
    ["are customers reporting any problems?", "status"],
    ["what needs my attention?", "attention"],
    ["show me the latest incident", "latest"],
    ["why are those reports related?", "why_related"],
    ["what do we know so far?", "sofar"],
    ["have we seen this before?", "seen_before"],
    ["what should we do next?", "next_steps"],
    ["can you explain that?", "explain"],
    ["what about the other incident?", "other"],
    ["tell me more", "sofar"],
    ["why?", "explain"],
    ["approve the recovery", "action_request"],
  ];
  for (const [text, kind] of cases) {
    it(`"${text}" -> ${kind}`, () => {
      expect(fastClassify(text)?.kind).toBe(kind);
    });
  }

  it("leaves exact commands and gibberish to other layers", () => {
    expect(fastClassify("frobnicate the database")).toBeNull();
    expect(fastClassify("what is the airspeed velocity?")).toBeNull();
  });

  it("validates model output against the allowlist", () => {
    expect(validateConversePlan({ kind: "status", refHint: null, topic: null })).toEqual({
      kind: "status",
      refHint: null,
      topic: null,
    });
    expect(validateConversePlan({ kind: "execute_fix", refHint: "abc" })).toBeNull();
    expect(validateConversePlan({ kind: "sofar", refHint: "not an id!!" })?.refHint).toBeNull();
    expect(validateConversePlan({ kind: "sofar", refHint: "22222222" })?.refHint).toBe("22222222");
    expect(validateConversePlan(null)).toBeNull();
  });

  it("infers selected refs only from validated assistant history", () => {
    const cands = [{ kind: "candidate" as const, id: CAND.id, title: CAND.title }];
    const incs = [{ kind: "incident" as const, id: INC.id, title: INC.title }];
    const hist: ConverseTurn[] = [
      { role: "user", text: "what happened?" },
      { role: "assistant", text: `Latest incident: "Visa outage" #22222222 Open: /app/workspaces/acme/incidents/${INC.id}` },
    ];
    expect(inferSelectedRef(hist, cands, incs)).toMatchObject({ kind: "incident", id: INC.id });
    expect(inferSelectedRef([], cands, incs)).toBeNull();
    expect(inferSelectedRef([{ role: "assistant", text: "nothing with a ref here" }], cands, incs)).toBeNull();
    // Unknown tokens never resolve, even when live records exist.
    expect(
      inferSelectedRef([{ role: "assistant", text: "see #deadbeef for detail" }], cands, incs),
    ).toBeNull();
  });
});

describe("natural greetings and status (grounded, no model)", () => {
  it("greets warmly without leaking workspace data", async () => {
    const f = makeFakes();
    const r = await handleOperatorMessage(IN("hey meros", "g1"), f.deps);
    expect(r.action).toBe("converse");
    expect(f.posts).toHaveLength(1);
    expect(f.posts[0].length).toBeLessThanOrEqual(500);
    expect(f.posts[0]).toMatch(/Meros here|Hey/i);
  });

  it("answers what's-happening with exact live numbers", async () => {
    const f = makeFakes();
    const r = await handleOperatorMessage(IN("what's happening today?", "s1"), f.deps);
    expect(r.action).toBe("converse");
    expect(f.posts).toHaveLength(1);
    // Exact stats from the fake read model — never invented.
    expect(f.posts[0]).toContain("21 conversations");
    expect(f.posts[0]).toContain("5 customers");
    expect(f.posts[0]).toContain("Visa outage");
    expect(f.posts[0]).toContain("22222222");
    expect(f.posts[0].length).toBeLessThanOrEqual(500);
  });

  it("worry triage names the top item and why it matters", async () => {
    const f = makeFakes();
    const r = await handleOperatorMessage(IN("anything I should worry about?", "w1"), f.deps);
    expect(r.action).toBe("converse");
    expect(f.posts[0]).toMatch(/Worth a look|Active/);
    expect(f.posts[0]).toContain("Visa outage");
    expect(f.posts[0].length).toBeLessThanOrEqual(500);
  });

  it("attention lists outstanding review work with a console pointer", async () => {
    const f = makeFakes();
    await handleOperatorMessage(IN("what needs my attention?", "a1"), f.deps);
    expect(f.posts[0]).toMatch(/Review candidate|needs you/i);
    expect(f.posts[0]).toContain("/app/workspaces/acme/incidents");
  });
});

describe("contextual follow-ups", () => {
  it("tell me more resolves to the previously discussed incident", async () => {
    const f = makeFakes();
    f.setHistory([
      { role: "user", text: "show me the latest incident" },
      {
        role: "assistant",
        text: `Latest incident: "Visa outage" [investigating, high] — 2 customers, 2 conversations. #22222222 Open: /app/workspaces/acme/incidents/${INC.id}`,
      },
    ]);
    let capturedFacts = "";
    f.setPhrase(async (input) => {
      capturedFacts = input.facts;
      return "Here's the deeper picture, grounded in the brief.";
    });
    const r = await handleOperatorMessage(IN("tell me more", "f1"), f.deps);
    expect(r.action).toBe("converse");
    expect(capturedFacts).toContain("Visa outage");
    expect(capturedFacts).toContain("What we know:");
    expect(capturedFacts).toContain("Visa checkout returns HTTP 500");
    expect(f.posts[0]).toContain(`/app/workspaces/acme/incidents/${INC.id}`);
    expect(f.posts[0].length).toBeLessThanOrEqual(1500);
  });

  it("why-explain rephrases the last reply without new facts", async () => {
    const f = makeFakes();
    f.setHistory([
      { role: "assistant", text: "Active: one incident open. It affects 2 customers. Review it in the console." },
    ]);
    await handleOperatorMessage(IN("why?", "f2"), f.deps);
    expect(f.posts[0]).toMatch(/Short version|unpack/i);
    expect(f.posts[0].length).toBeLessThanOrEqual(500);
  });

  it("the other incident picks the non-selected one when exactly two fit", async () => {
    const f = makeFakes({}, { listActiveIncidents: async () => [{ ...INC }, { ...INC2 }], listReviewCandidates: async () => [] });
    f.setHistory([
      { role: "assistant", text: `Latest incident: "Visa outage" #22222222 Open: /app/workspaces/acme/incidents/${INC.id}` },
    ]);
    await handleOperatorMessage(IN("what about the other incident?", "o1"), f.deps);
    expect(f.posts[0]).toContain("Refund delays");
    expect(f.posts[0]).toContain("44444444");
  });

  it("asks a natural clarification when several incidents fit", async () => {
    const f = makeFakes({}, { listActiveIncidents: async () => [{ ...INC }, { ...INC2 }] });
    const r = await handleOperatorMessage(IN("what about the other incident?", "o2"), f.deps);
    expect(r.action).toBe("converse");
    expect(f.posts[0]).toContain("22222222");
    expect(f.posts[0]).toContain("44444444");
    expect(f.posts[0]).toMatch(/which one/i);
  });

  it("have-we-seen-this-before reports verified tiers honestly", async () => {
    const f = makeFakes();
    f.setHistory([
      { role: "assistant", text: `Incident: Visa outage #22222222` },
    ]);
    await handleOperatorMessage(IN("have we seen this before?", "sb1"), f.deps);
    expect(f.posts[0]).toMatch(/VERIFIED HISTORICAL FIX|card-9/);
    expect(f.posts[0]).toMatch(/does not prove today's cause/i);
  });

  it("labels stale evidence instead of presenting it as current", async () => {
    const f = makeFakes({}, { getBrief: async () => ({ ...BRIEF, status: "stale", facts: [], unknowns: [], contradictions: [] }) });
    f.setHistory([{ role: "assistant", text: `Incident: Visa outage #22222222` }]);
    await handleOperatorMessage(IN("what do we know so far?", "st1"), f.deps);
    expect(f.posts[0]).toMatch(/stale|not current|outdated/i);
    expect(f.posts[0]).not.toMatch(/current v2/);
  });

  it("is honest when no historical matches exist", async () => {
    const f = makeFakes({}, { getMatches: async () => ({ current: true, fingerprint: "fp-x", rows: [] }) });
    f.setHistory([{ role: "assistant", text: `Incident: Visa outage #22222222` }]);
    await handleOperatorMessage(IN("has this happened before?", "nm1"), f.deps);
    expect(f.posts[0]).toMatch(/No historical matches stored/);
  });
});

describe("empty workspace experience", () => {
  const emptyReads = {
    listActiveIncidents: async () => [],
    listReviewCandidates: async () => [],
    listDecisions: async () => [],
    recentRadarAlerts: async () => [],
  };
  const emptyStats = async () => ({ openIssues: 0, customers: 0, conversations: 0, pendingFixCards: 0, sharedFixes: 0 });

  it("status is calm, honest, and never claims analysis ran", async () => {
    const f = makeFakes({ readStats: emptyStats }, emptyReads);
    await handleOperatorMessage(IN("what's happening today?", "e1"), f.deps);
    expect(f.posts[0]).toMatch(/no open issues|no customer reports/i);
    expect(f.posts[0]).toMatch(/no customer reports/i);
    expect(f.posts[0]).not.toMatch(/Radar/i);
    expect(f.posts[0]).not.toMatch(/current v|fp-|VERIFIED/);
    expect(f.posts[0].length).toBeLessThanOrEqual(500);
  });

  it("latest incident is honest when nothing exists", async () => {
    const f = makeFakes({ readStats: emptyStats }, emptyReads);
    await handleOperatorMessage(IN("show me the latest incident", "e2"), f.deps);
    expect(f.posts[0]).toMatch(/No open issues yet/i);
    expect(f.posts[0]).not.toMatch(/Radar/i);
  });

  it("follow-ups do not invent a record", async () => {
    const f = makeFakes({ readStats: emptyStats }, emptyReads);
    await handleOperatorMessage(IN("what do we know so far?", "e3"), f.deps);
    expect(f.posts[0]).toMatch(/Nothing to dig into|no incidents/i);
  });
});

describe("consequential actions stay read-only", () => {
  it("approval requests get console guidance, never execution", async () => {
    const f = makeFakes();
    const r = await handleOperatorMessage(IN("approve the recovery plan", "ar1"), f.deps);
    expect(r.action).toBe("converse");
    expect(f.posts[0]).toMatch(/staff console/i);
    expect(f.posts[0]).toMatch(/can't approve|read-only/i);
    expect(f.posts[0]).toContain("/app/workspaces/acme/incidents");
    expect(f.posts).toHaveLength(1);
  });

  it("publish requests are declined with a console pointer", async () => {
    const f = makeFakes();
    await handleOperatorMessage(IN("please send customers an update", "ar2"), f.deps);
    expect(f.posts[0]).toMatch(/staff console|can't publish/i);
  });
});

describe("model safety and fallback", () => {
  it("model classify failure still yields a helpful grounded reply", async () => {
    const f = makeFakes();
    f.setClassify(async () => {
      throw new Error("gemini down");
    });
    const r = await handleOperatorMessage(IN("blargle wargle photon", "m1"), f.deps);
    expect(r.action).toBe("converse");
    expect(f.posts).toHaveLength(1);
    expect(f.posts[0]).toMatch(/what's happening|needs my attention|with you/i);
  });

  it("garbage model output is validated back to a safe clarification", async () => {
    const f = makeFakes();
    f.setClassify(async () => ({ kind: "execute_fix", refHint: "x", topic: null }) as unknown as ConversePlan);
    await handleOperatorMessage(IN("something odd", "m2"), f.deps);
    expect(f.posts).toHaveLength(1);
    expect(f.posts[0]).not.toMatch(/execut/);
  });

  it("phrase success appends the console link inside the cap", async () => {
    const f = makeFakes();
    f.setPhrase(async () => `${"Warm grounded answer. ".repeat(60)}`);
    await handleOperatorMessage(IN("what's happening today?", "m3"), f.deps);
    expect(f.posts[0].length).toBeLessThanOrEqual(500);
    expect(f.posts[0]).toContain("/app/workspaces/acme/incidents/");
  });

  it("history load failure degrades to no-context instead of failing", async () => {
    const f = makeFakes({
      converse: {
        loadHistory: async () => {
          throw new Error("db blip");
        },
        classify: async (text) => {
          const { fastClassify: fast, unknownPlan } = await import("../photon/converse");
          return fast(text) ?? unknownPlan();
        },
        phrase: async () => {
          throw new Error("model offline");
        },
      },
    });
    const r = await handleOperatorMessage(IN("what's happening today?", "m4"), f.deps);
    expect(r.action).toBe("converse");
    expect(f.posts[0]).toContain("21 conversations");
  });

  it("history is scoped to the binding workspace", async () => {
    const f = makeFakes();
    await handleOperatorMessage(IN("hey meros", "h1"), f.deps);
    expect(f.historyCalls).toHaveLength(1);
    expect(f.historyCalls[0]).toEqual({ workspaceId: WS.id, bindingId: BINDING.id });
  });
});

describe("authorization boundaries", () => {
  it("revoked/non-staff operators are denied with zero data", async () => {
    const f = makeFakes({
      checkStaff: async () => {
        throw Object.assign(new Error("not staff"), { status: 403 });
      },
    });
    const r = await handleOperatorMessage(IN("what's happening today?", "d1"), f.deps);
    expect(r.action).toBe("denied");
    expect(f.posts[0]).toBe(DENIED_TEXT);
    expect(f.posts[0]).not.toMatch(/Visa|21 conversations/);
  });

  it("unknown senders get only pairing guidance", async () => {
    const f = makeFakes({ findBinding: async () => null });
    const r = await handleOperatorMessage(IN("what's happening today?", "d2"), f.deps);
    expect(r.action).toBe("pairing-required");
    expect(f.posts[0]).not.toMatch(/Visa|21 conversations/);
  });

  it("foreign references resolve to clarification, never leak", async () => {
    const f = makeFakes();
    const r = await handleOperatorMessage(
      IN("tell me about 99999999-9999-9999-9999-999999999999", "d3"),
      f.deps,
    );
    expect(r.action).toBe("converse");
    expect(f.posts[0]).toMatch(/Which one|which one/);
    expect(f.posts[0]).not.toContain("99999999");
  });
});

describe("compatibility and delivery safety", () => {
  it("legacy path is preserved exactly without converse configured", async () => {
    const f = makeFakes({ converse: undefined });
    const r = await handleOperatorMessage(IN("frobnicate the database", "c0"), f.deps);
    expect(r.action).toBe("usage");
    expect(f.posts[0]).toBe(USAGE_TEXT);
  });

  it("exact commands never reach the conversational layer", async () => {
    const f = makeFakes();
    let classifyCalls = 0;
    f.setClassify(async (text, h) => {
      classifyCalls++;
      const { fastClassify: fast, unknownPlan } = await import("../photon/converse");
      return fast(text) ?? unknownPlan();
    });
    expect((await handleOperatorMessage(IN("stats", "c1"), f.deps)).action).toBe("stats");
    expect((await handleOperatorMessage(IN("incidents", "c2"), f.deps)).action).toBe("incidents");
    expect((await handleOperatorMessage(IN("show me", "c3"), f.deps)).action).toBe("show");
    expect((await handleOperatorMessage(IN("help", "c4"), f.deps)).action).toBe("help");
    expect(classifyCalls).toBe(0);
  });

  it("duplicate webhook delivery never sends twice", async () => {
    const f = makeFakes();
    const r1 = await handleOperatorMessage(IN("what's happening today?", "dup-1"), f.deps);
    const r2 = await handleOperatorMessage(IN("what's happening today?", "dup-1"), f.deps);
    expect(r1.action).toBe("converse");
    expect(r2.action).toBe("deduped");
    expect(f.posts).toHaveLength(1);
  });

  it("read failure degrades honestly without a fabricated reply", async () => {
    const f = makeFakes({}, { listActiveIncidents: async () => { throw new Error("db down"); } });
    const r = await handleOperatorMessage(IN("what's happening today?", "c5"), f.deps);
    expect(r.action).toBe("unavailable");
    expect(f.posts).toHaveLength(0);
  });

  it("reply length caps hold", () => {
    expect(capFor("status")).toBe(500);
    expect(capFor("sofar")).toBe(1500);
    const long = fitConverse("word ".repeat(500), "/app/workspaces/acme/incidents/x", false);
    expect(long.length).toBeLessThanOrEqual(500);
    expect(long).toContain("/app/workspaces/acme/incidents/x");
  });

  it("facts text never claims Radar without an alert", () => {
    const ctx = {
      workspaceName: "Acme",
      empty: false,
      stats: null,
      incidents: [],
      candidates: [],
      decisions: [],
      radarCandidateId: null,
      selected: null,
      ambiguous: null,
      lastAssistant: null,
    };
    const facts = factsText(ctx, { kind: "latest", refHint: null, topic: null }, "acme");
    expect(facts).toMatch(/Do not claim Radar/);
  });

  it("fallback replies stay short and link-light", () => {
    const ctx = {
      workspaceName: "Acme",
      empty: true,
      stats: null,
      incidents: [],
      candidates: [],
      decisions: [],
      radarCandidateId: null,
      selected: null,
      ambiguous: null,
      lastAssistant: null,
    };
    for (const kind of ["greeting", "status", "worry", "attention", "latest", "unknown"] as const) {
      const fb = fallbackReply(ctx, { kind, refHint: null, topic: null }, "acme");
      const full = fitConverse(fb.body, fb.link, capFor(kind) === 1500);
      expect(full.length).toBeLessThanOrEqual(500);
      expect(full).not.toMatch(/Radar is enabled/i);
    }
  });
});
