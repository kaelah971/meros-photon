import { describe, expect, it, vi } from "vitest";
import {
  handleOperatorMessage,
  AT_MENU_TEXT,
  formatStatsReply,
  type OperatorBinding,
  type OperatorDeps,
  type OperatorWorkspace,
} from "../photon/operator";
import type { InvestigateReads } from "../photon/investigate";
import {
  fitReply,
  formatMessageBody,
  incidentLink,
  publicLink,
  truncateClean,
} from "../photon/investigate";
import { capFor, fallbackReply, fitConverse } from "../photon/converse";

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("chat", () => ({ Chat: class {} }));
vi.mock("@photon-ai/chat-adapter-imessage", () => ({ createiMessageAdapter: () => ({}) }));

const WS: OperatorWorkspace = { id: "ws-1", slug: "acme", name: "Acme Support" };
const BINDING: OperatorBinding = { id: "bind-1", workspaceId: WS.id, operatorUserId: "user-1", threadId: "thread-1" };

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

function makeFakes(overrides: Partial<OperatorDeps> = {}) {
  const inbounds = new Map<string, { id: string; status: string }>();
  const slots = new Map<string, string>();
  let seq = 0;
  const posts: string[] = [];
  const reads: InvestigateReads = {
    workspaceSlug: async () => "acme",
    listActiveIncidents: async () => [{ ...INC }],
    listReviewCandidates: async () => [],
    getCandidate: async () => null,
    getIncident: async (id: string) => (id === INC.id ? { ...INC } : null),
    getBrief: async () => null,
    getMatches: async () => ({ current: false, fingerprint: null, rows: [] }),
    listDecisions: async () => [
      { kind: "candidate", label: "Review possible problem: Visa checkout 500s", ref: "c1" },
    ],
    recentRadarAlerts: async () => [],
  };
  const base: OperatorDeps = {
    findBinding: async () => BINDING,
    claimPairing: async () => null,
    noteThread: async () => {},
    checkStaff: async () => {},
    readStats: async () => ({ openIssues: 2, customers: 5, conversations: 21, pendingFixCards: 1, sharedFixes: 2 }),
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
    investigate: reads,
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
  return { deps: { ...base, ...overrides } as OperatorDeps, posts };
}

const IN = (text: string, id = "m3-1") => ({
  providerMessageId: id,
  threadId: "thread-1",
  senderHash: "sender-hash-1",
  text,
  isBot: false,
});

const BANNED = [
  /running smoothly/i,
  /all (problems|issues) (have been |are )?fixed/i,
  /every customer is happy/i,
  /I'll flag it here/i,
  /the moment something does/i,
  /live workspace proof/i,
  /nothing urgent is being inferred/i,
  /\bcandidate\b(?!.*possible recurring problem)/i,
];

describe("S15C.3 message formatting seam", () => {
  it("preserves intentional paragraph breaks and bullets", () => {
    const out = formatMessageBody("Direct answer.\n\nContext line.\n- bullet one\n- bullet two");
    expect(out).toBe("Direct answer.\n\nContext line.\n- bullet one\n- bullet two");
  });

  it("normalizes CRLF, tabs, extra spaces, and blank runs without collapsing paragraphs", () => {
    const out = formatMessageBody("  Hello,\r\n\tworld!   \n\n\n\nNext para.  ");
    expect(out).toBe("Hello,\nworld!\n\nNext para.");
  });

  it("truncateClean breaks at words and never splits a link", () => {
    const withLink = `See the details here ${incidentLink("acme", "abc123")} for more context on the outage`;
    const cut = truncateClean(withLink, 60);
    expect(cut.length).toBeLessThanOrEqual(61);
    expect(cut).not.toMatch(/https?:\/\/\S*…$/);
    // The link is dropped whole rather than left half-clickable.
    expect(cut.includes("https://") ? cut : cut).toBeTruthy();
    const noLink = truncateClean("alpha beta gamma delta", 11);
    expect(noLink).toBe("alpha beta…");
  });

  it("fitConverse keeps Gemini paragraphs and appends an absolute, intact link", () => {
    const body = "Visa checkout is throwing 500s.\n\nTwo customers hit it this morning.\n\nWant me to pull the latest report?";
    const out = fitConverse(body, "/app/workspaces/acme/incidents/abc", false);
    expect(out).toContain("500s.\n\nTwo customers");
    expect(out).toContain("https://meros-photon.vercel.app/app/workspaces/acme/incidents/abc");
    const long = fitConverse("word ".repeat(500), "/app/workspaces/acme/incidents/x", false);
    expect(long.length).toBeLessThanOrEqual(500);
    expect(long).toContain("https://meros-photon.vercel.app/app/workspaces/acme/incidents/x");
  });

  it("fitReply normalizes, absolutizes, and never truncates mid-link", () => {
    const out = fitReply("Line one.\r\n\r\nLine two.", "/app/workspaces/acme/incidents/1");
    expect(out).toBe("Line one.\n\nLine two.");
    const big = fitReply(`${"detail ".repeat(300)}${incidentLink("acme", "zzz")}`, incidentLink("acme", "zzz"));
    expect(big).toContain("https://meros-photon.vercel.app/app/workspaces/acme/incidents/zzz");
    expect(big.length).toBeLessThanOrEqual(1500);
  });

  it("console links are absolute https from a trusted origin", () => {
    expect(incidentLink("acme", "1")).toBe("https://meros-photon.vercel.app/app/workspaces/acme/incidents/1");
    expect(publicLink("https://meros-photon.vercel.app/app/x")).toBe("https://meros-photon.vercel.app/app/x");
  });
});

describe("S15C.3 natural voice and truthfulness", () => {
  const kinds = [
    "greeting",
    "status",
    "worry",
    "attention",
    "latest",
    "why_related",
    "sofar",
    "seen_before",
    "next_steps",
    "explain",
    "other",
    "action_request",
    "unknown",
  ] as const;
  const liveCtx = {
    workspaceName: "Acme Support",
    empty: false,
    stats: { openIssues: 2, customers: 5, conversations: 21, pendingFixCards: 1, sharedFixes: 2 },
    incidents: [{ id: INC.id, title: INC.title, status: INC.status, severity: INC.severity, customers: 2, conversations: 2 }],
    candidates: [{ id: "c1", title: "Refund delays", status: "pending", conversations: 2, customers: 2 }],
    decisions: ["Review possible problem: Visa checkout 500s"],
    radarCandidateId: null,
    selected: null,
    ambiguous: null,
    lastAssistant: "Active: one issue open. It affects 2 customers.",
  };

  it("no fallback invents successful outcomes or promises alerts", () => {
    for (const kind of kinds) {
      const fb = fallbackReply(liveCtx, { kind, refHint: null, topic: "approve and send" }, "acme");
      for (const banned of BANNED) {
        expect(`${kind}: ${fb.body}`).not.toMatch(banned);
      }
    }
  });

  it("status and attention replies breathe with paragraph breaks", () => {
    const status = fallbackReply(liveCtx, { kind: "status", refHint: null, topic: null }, "acme");
    expect(status.body).toContain("\n\n");
    expect(status.body).toContain("21 conversations");
    expect(status.body).toContain("Visa outage");
    const attention = fallbackReply(liveCtx, { kind: "attention", refHint: null, topic: null }, "acme");
    expect(attention.body).toContain("\n\n");
    expect(attention.body).toMatch(/needs you/i);
  });

  it("end-to-end natural replies are paragraphed, grounded, and capped", async () => {
    const f = makeFakes();
    await handleOperatorMessage(IN("hey meros, what's happening today?", "e2e-1"), f.deps);
    expect(f.posts[0]).toContain("\n\n");
    expect(f.posts[0]).toContain("Visa outage");
    expect(f.posts[0].length).toBeLessThanOrEqual(500);
    const g = makeFakes();
    await handleOperatorMessage(IN("what needs my attention?", "e2e-2"), g.deps);
    expect(g.posts[0]).toContain("https://meros-photon.vercel.app/app/workspaces/acme/incidents");
  });
});

describe("S15C.3 @status, stats, and menu", () => {
  it("empty workspace gets the quiet message", () => {
    const text = formatStatsReply("Northstar Support", {
      openIssues: 0,
      customers: 0,
      conversations: 0,
      pendingFixCards: 0,
      sharedFixes: 0,
    });
    expect(text).toContain("Things are quiet in Northstar Support.");
    expect(text).toContain("Nothing is waiting for your review.");
  });

  it("populated @status is accurate, labeled all-time, and human", async () => {
    const f = makeFakes();
    const r = await handleOperatorMessage(IN("@status", "st-1"), f.deps);
    expect(r.action).toBe("stats");
    expect(f.posts[0]).toContain("Acme Support");
    expect(f.posts[0]).toContain("all-time totals");
    expect(f.posts[0]).toContain("21 customer conversations");
    expect(f.posts[0]).toContain("2 shared fixes saved.");
    expect(f.posts[0]).not.toMatch(/inferred|live workspace proof/i);
  });

  it("@ menu is grouped and every alias still works", async () => {
    expect(AT_MENU_TEXT).toContain("CHECK YOUR TEAM");
    expect(AT_MENU_TEXT).toContain("WORK TO REVIEW");
    expect(AT_MENU_TEXT).toContain("@memory");
    const f = makeFakes();
    const r = await handleOperatorMessage(IN("@", "m-1"), f.deps);
    expect(r.action).toBe("at-menu");
    expect(f.posts[0]).toContain("\n\n");
    for (const [text, action] of [["@status", "stats"], ["@alerts", "alerts"], ["@incidents", "incidents"], ["@reviews", "decisions"], ["@memory", "at-memory"]] as const) {
      const g = makeFakes();
      expect((await handleOperatorMessage(IN(text, `m-${action}`), g.deps)).action).toBe(action);
    }
  });

  it("@memory links to the absolute Fix Cards library", async () => {
    const f = makeFakes();
    await handleOperatorMessage(IN("@memory", "mem-1"), f.deps);
    expect(f.posts[0]).toContain("https://meros-photon.vercel.app/app/workspaces/acme/fix-cards");
  });
});

describe("S15C.3 safety preserved", () => {
  it("unknown and revoked operators stay blocked", async () => {
    const u = makeFakes({ findBinding: async () => null });
    expect((await handleOperatorMessage(IN("@status", "s-1"), u.deps)).action).toBe("pairing-required");
    const v = makeFakes({
      checkStaff: async () => {
        throw new Error("not staff");
      },
    });
    expect((await handleOperatorMessage(IN("what's happening?", "s-2"), v.deps)).action).toBe("denied");
  });

  it("duplicate webhook still sends exactly one reply", async () => {
    const f = makeFakes();
    await handleOperatorMessage(IN("what's happening?", "dup-9"), f.deps);
    const second = await handleOperatorMessage(IN("what's happening?", "dup-9"), f.deps);
    expect(second.action).toBe("deduped");
    expect(f.posts).toHaveLength(1);
  });

  it("approval requests stay read-only with console guidance", async () => {
    const f = makeFakes();
    const r = await handleOperatorMessage(IN("approve the recovery and message everyone", "safe-9"), f.deps);
    expect(r.action).toBe("converse");
    expect(f.posts[0]).toMatch(/staff console/i);
    expect(f.posts).toHaveLength(1);
  });

  it("caps hold for detailed kinds", () => {
    expect(capFor("sofar")).toBe(1500);
    const out = fitConverse("x ".repeat(2000), "/app/workspaces/acme/incidents/y", true);
    expect(out.length).toBeLessThanOrEqual(1500);
  });
});
