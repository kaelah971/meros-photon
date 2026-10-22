import { describe, expect, it, vi } from "vitest";
import {
  buildRadarMessage,
  evaluateRadarEligibility,
  maybeSendRadarAlert,
  radarIdempotencyKey,
  safeRadarTitle,
  shouldEvaluateRadar,
  type RadarDeps,
} from "../radar";
import {
  formatRadarDecision,
  logRadarDecision,
  mapRadarResultToOutcome,
  safeIdPrefix,
  safeSlug,
  sanitizeReason,
} from "../radar-decision";
import { sendOperatorNotification } from "../photon/notify";

// Deterministic clock + members. Mirrors s15b-radar.test.ts but exercises
// the post-fix wiring (correct arg order) and the new observable outcome
// categories. No Neon, no Photon sends — all deps are fakes.
const T0 = new Date("2026-10-20T21:00:00.000Z");
const min = (n: number) => new Date(T0.getTime() + n * 60_000).toISOString();
const mem = (conv: string, cust: string, at: string) => ({ conversation_id: conv, customer_id: cust, added_at: at });
const cand = (over: Record<string, unknown> = {}) => ({
  id: "ck-422-uuid-0000-0000-000000000001",
  status: "pending",
  title: "Checkout validation rejects Visa pay with 500",
  summary: "Multiple customers report Visa pay failing validation at checkout.",
  updated_at: min(0),
  ...over,
});

function depsWith(cfg: {
  candidate?: ReturnType<typeof cand> | null;
  members?: ReturnType<typeof mem>[];
  messages?: number;
  optedIn?: string[];
  recipients?: Record<string, { bindingId: string; threadId: string } | null>;
  notify?: RadarDeps["notify"];
  slug?: string | null;
  throwOn?: "load" | "members" | "optin" | null;
  calls?: { notify: unknown[]; resolve: string[] };
}): { deps: RadarDeps; calls: { notify: unknown[]; resolve: string[] } } {
  const calls = cfg.calls ?? { notify: [] as unknown[], resolve: [] as string[] };
  const claimed = new Map<string, boolean>();
  const deps: RadarDeps = {
    loadCandidate: async (_id, _ws) => {
      if (cfg.throwOn === "load") throw new Error("db down");
      if (_ws !== "ws-novacart") return null;
      return cfg.candidate === undefined ? cand() : cfg.candidate;
    },
    listMembers: async () => {
      if (cfg.throwOn === "members") throw new Error("db down");
      return cfg.members ?? [];
    },
    countMessages: async () => {
      if (cfg.throwOn === "members") throw new Error("db down");
      return cfg.messages ?? 0;
    },
    listOptedIn: async (ws) => {
      if (cfg.throwOn === "optin") throw new Error("db down");
      return ws === "ws-novacart" ? (cfg.optedIn ?? []) : [];
    },
    resolveRecipient: async (_ws, op) => {
      calls.resolve.push(op);
      const r = cfg.recipients?.[op];
      if (r === undefined) return op === "op-1" ? { operatorUserId: op, bindingId: "b-1", threadId: "t-1" } : null;
      return r ? { operatorUserId: op, ...r } : null;
    },
    workspaceSlug: async (ws) => {
      if (ws !== "ws-novacart") return null;
      return cfg.slug === undefined ? "novacart-support" : cfg.slug;
    },
    notify: async (input) => {
      calls.notify.push(input);
      if (cfg.notify) return cfg.notify(input);
      if (claimed.has(input.idempotencyKey)) return { sent: false, deduped: true, reason: "already attempted for this key" };
      claimed.set(input.idempotencyKey, true);
      return { sent: true, deduped: false, reason: "accepted by provider" };
    },
  };
  return { deps, calls };
}

const THREE = [mem("c1", "u1", min(0)), mem("c2", "u2", min(10)), mem("c3", "u3", min(20))];

describe("production wiring regression (swapped-arg root cause)", () => {
  it("radar loads candidates as (workspaceId, candidateId)", async () => {
    const fs = await import("node:fs");
    const lib = fs.readFileSync("lib/radar.ts", "utf8");
    expect(lib).toMatch(/getCandidateForWorkspace\(workspaceId, candidateId\)/);
    expect(lib).not.toMatch(/getCandidateForWorkspace\(candidateId, workspaceId\)/);
  });

  it("investigate reads load candidates as (workspaceId, id)", async () => {
    const fs = await import("node:fs");
    const lib = fs.readFileSync("lib/photon/investigate-reads.ts", "utf8");
    expect(lib).toMatch(/getCandidateForWorkspace\(workspaceId, id\)/);
    expect(lib).not.toMatch(/getCandidateForWorkspace\(id, workspaceId\)/);
  });
});

describe("detection-to-radar timing gate", () => {
  it("evaluates ONLY on joined + newConversation", () => {
    expect(shouldEvaluateRadar({ action: "joined", newConversation: true })).toBe(true);
    expect(shouldEvaluateRadar({ action: "joined", newConversation: false })).toBe(false);
    expect(shouldEvaluateRadar({ action: "created" })).toBe(false);
    expect(shouldEvaluateRadar({ action: "deferred" })).toBe(false);
    expect(shouldEvaluateRadar({ action: "not_issue" })).toBe(false);
    expect(shouldEvaluateRadar({ action: "ignored" })).toBe(false);
    expect(shouldEvaluateRadar({ action: "already_clustered", newConversation: true } as never)).toBe(false);
  });

  it("third qualifying conversation triggers evaluation", async () => {
    const { deps } = depsWith({ members: THREE, messages: 6, optedIn: ["op-1"] });
    const r = await maybeSendRadarAlert("ws-novacart", "ck-1", deps, new Date(min(30)));
    expect(r.action).toBe("alerted");
    if (r.action !== "alerted") return;
    expect(r.sent).toBe(1);
    expect(mapRadarResultToOutcome(r)).toBe("notification_accepted");
  });

  it("existing conversation follow-up must not evaluate (gate is false)", () => {
    // Same-conversation follow-up returns joined with newConversation=false
    // in detection; the gate stays false so Radar is never re-evaluated.
    expect(shouldEvaluateRadar({ action: "joined", newConversation: false })).toBe(false);
  });

  it("two customers never trigger Radar", async () => {
    const two = [mem("c1", "u1", min(0)), mem("c2", "u2", min(10))];
    const { deps } = depsWith({ members: two, messages: 2, optedIn: ["op-1"] });
    const r = await maybeSendRadarAlert("ws-novacart", "ck-1", deps, new Date(min(30)));
    expect(r).toMatchObject({ action: "ineligible" });
    expect(mapRadarResultToOutcome(r as never)).toBe("radar_ineligible");
  });
});

describe("eligibility and recipient gates", () => {
  it("ineligible candidate does not send", async () => {
    const { deps: d1 } = depsWith({
      candidate: cand({ status: "accepted" }),
      members: THREE,
      messages: 3,
      optedIn: ["op-1"],
    });
    const r1 = await maybeSendRadarAlert("ws-novacart", "ck-1", d1, new Date(min(30)));
    expect(r1.action).toBe("ineligible");

    const { deps: d2 } = depsWith({
      candidate: cand({ title: "Payment failed please thanks", summary: "issue with payment" }),
      members: THREE,
      messages: 3,
      optedIn: ["op-1"],
    });
    const r2 = await maybeSendRadarAlert("ws-novacart", "ck-1", d2, new Date(min(30)));
    expect(r2.action).toBe("ineligible");

    const { deps: d3, calls } = depsWith({ candidate: null, members: THREE, messages: 3, optedIn: ["op-1"] });
    const r3 = await maybeSendRadarAlert("ws-novacart", "ck-1", d3, new Date(min(30)));
    expect(r3.action).toBe("deferred");
    expect(calls.notify).toHaveLength(0);
  });

  it("eligible operator receives exactly one send attempt", async () => {
    const calls = { notify: [] as unknown[], resolve: [] as string[] };
    const { deps } = depsWith({
      members: THREE,
      messages: 3,
      optedIn: ["op-1"],
      recipients: { "op-1": { bindingId: "b-1", threadId: "t-1" } },
      calls,
    });
    const r = await maybeSendRadarAlert("ws-novacart", "ck-1", deps, new Date(min(30)));
    expect(r).toMatchObject({ action: "alerted", sent: 1, deduped: 0, suppressed: 0 });
    expect(calls.notify).toHaveLength(1);
    const first = calls.notify[0] as { idempotencyKey: string; threadId: string; body: string };
    expect(first.idempotencyKey).toBe(radarIdempotencyKey("ck-1", "op-1"));
    expect(first.threadId).toBe("t-1");
    // Alert links review page; never customer destinations or raw ids.
    expect(first.body).toMatch(/\/app\/workspaces\/novacart-support\/incidents\/detected\/ck-1/);
  });

  it("missing/invalid pairing safely blocks sending", async () => {
    const { deps } = depsWith({
      members: THREE,
      messages: 3,
      optedIn: ["op-1", "op-2"],
      recipients: { "op-1": null, "op-2": { bindingId: "b-2", threadId: "" } },
      notify: async () => {
        throw new Error("must not be called without a recipient");
      },
    });
    const r = await maybeSendRadarAlert("ws-novacart", "ck-1", deps, new Date(min(30)));
    expect(r).toMatchObject({ action: "alerted", sent: 0, suppressed: 2 });
    if (r.action !== "alerted") return;
    expect(r.suppressedReasons).toContain("no_eligible_recipient");
    expect(mapRadarResultToOutcome(r)).toBe("notification_suppressed");
  });

  it("no opted-in operators maps to no_eligible_operator without sends", async () => {
    const { deps, calls } = depsWith({ members: THREE, messages: 3, optedIn: [] });
    const r = await maybeSendRadarAlert("ws-novacart", "ck-1", deps, new Date(min(30)));
    expect(r.action).toBe("no_recipients");
    expect(mapRadarResultToOutcome(r as never)).toBe("no_eligible_operator");
    expect(calls.notify).toHaveLength(0);
  });
});

describe("delivery semantics", () => {
  it("provider failure is reported accurately and never retried with a fresh key", async () => {
    const { deps } = depsWith({
      members: THREE,
      messages: 3,
      optedIn: ["op-1"],
      notify: async () => ({ sent: false, deduped: false, reason: "Photon send failed" }),
    });
    const r = await maybeSendRadarAlert("ws-novacart", "ck-1", deps, new Date(min(30)));
    expect(r).toMatchObject({ action: "alerted", sent: 0, suppressed: 1 });
    if (r.action !== "alerted") return;
    expect(r.suppressedReasons?.[0]).toMatch(/Photon send failed/);
    expect(mapRadarResultToOutcome(r)).toBe("notification_suppressed");
  });

  it("sendOperatorNotification reports provider_failed without claiming delivery", async () => {
    const result = await sendOperatorNotification(
      {
        workspaceId: "ws-novacart",
        operatorUserId: "op-1",
        type: "incident_detected",
        body: "MEROS / INCIDENT RADAR\ntest",
        idempotencyKey: "radar:ck-1:op-1",
        isTest: false,
      },
      {
        findBindingForOperator: async () => ({ id: "b-1", workspaceId: "ws-novacart", operatorUserId: "op-1", threadId: "t-1" }),
        checkStaff: async () => {},
        getPreferences: async () => ({
          proactiveEnabled: true,
          quietHoursEnabled: false,
          quietStart: "22:00",
          quietEnd: "07:00",
          timezone: "Africa/Lagos",
          malformed: false,
        }),
        claimProactive: async () => ({ id: "out-1", status: "received", providerMessageId: null, deduped: false }),
        markSent: async () => {},
        markFailed: async () => {},
        postToThread: async () => {
          throw new Error("adapter down");
        },
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("provider_failed");
  });

  it("duplicate delivery cannot cause duplicate sends", async () => {
    const shared = { notify: [] as unknown[], resolve: [] as string[] };
    const { deps } = depsWith({ members: THREE, messages: 3, optedIn: ["op-1"], calls: shared });
    const [a, b] = await Promise.all([
      maybeSendRadarAlert("ws-novacart", "ck-1", deps, new Date(min(30))),
      maybeSendRadarAlert("ws-novacart", "ck-1", deps, new Date(min(30))),
    ]);
    const sent = [a, b].filter((r) => r.action === "alerted" && r.sent === 1).length;
    const deduped = [a, b].filter((r) => r.action === "alerted" && r.deduped === 1).length;
    expect(sent).toBe(1);
    expect(deduped).toBe(1);
    if (a.action === "alerted" && b.action === "alerted") {
      expect(mapRadarResultToOutcome(a) === "notification_accepted" || mapRadarResultToOutcome(b) === "notification_accepted").toBe(true);
    }
  });
});

describe("background failures are observable", () => {
  it("transient reads defer with diagnosable reasons", async () => {
    const { deps: dLoad } = depsWith({ throwOn: "load", members: THREE, messages: 3, optedIn: ["op-1"] });
    expect(await maybeSendRadarAlert("ws-novacart", "ck-1", dLoad)).toMatchObject({
      action: "deferred",
      reason: "candidate read failed",
    });

    const { deps: dMem } = depsWith({ throwOn: "members", members: THREE, messages: 3, optedIn: ["op-1"] });
    expect(await maybeSendRadarAlert("ws-novacart", "ck-1", dMem)).toMatchObject({ action: "deferred" });

    const { deps: dOpt } = depsWith({ throwOn: "optin", members: THREE, messages: 3, optedIn: ["op-1"] });
    const rOpt = await maybeSendRadarAlert("ws-novacart", "ck-1", dOpt);
    expect(rOpt).toMatchObject({ action: "deferred", reason: "opt-in read failed" });
    expect(mapRadarResultToOutcome(rOpt as never)).toBe("notification_failed");

    const { deps: dSlug } = depsWith({ members: THREE, messages: 3, optedIn: ["op-1"], slug: null });
    expect(await maybeSendRadarAlert("ws-novacart", "ck-1", dSlug)).toMatchObject({ action: "deferred" });
  });

  it("decision log is structured and privacy-safe", () => {
    const lines: string[] = [];
    logRadarDecision(
      {
        outcome: "notification_accepted",
        workspaceSlug: "novacart-support",
        candidateIdPrefix: "ck-422-uuid-0000",
        sent: 1,
        deduped: 0,
        suppressed: 0,
      },
      (line) => lines.push(line),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[radar-decision\] \{/);
    const parsed = JSON.parse(lines[0].replace(/^\[radar-decision\] /, "")) as Record<string, unknown>;
    expect(parsed).toMatchObject({ outcome: "notification_accepted", workspace: "novacart-support", candidate: "ck-422-u" });
    const raw = lines[0];
    expect(raw).not.toMatch(/\+254|@example|thread|phone|token|secret|sk-/i);
  });

  it("evaluation uses persisted memberships, not recency from now", () => {
    // Three members inside one early hour still qualify when evaluated much
    // later — the window is over evidence, not over now.
    const early = [mem("c1", "u1", min(0)), mem("c2", "u2", min(20)), mem("c3", "u3", min(40))];
    const eligibility = evaluateRadarEligibility(cand(), early, 3, new Date(min(500)));
    expect(eligibility.eligible).toBe(true);
  });
});

describe("customer/workspace privacy remains intact", () => {
  it("alert body links review and leaks no customer data", () => {
    const body = buildRadarMessage({
      title: "Checkout validation rejects Visa pay with 500",
      customers: 3,
      conversations: 5,
      windowMinutes: 60,
      candidateId: "ck-422",
      workspaceSlug: "novacart-support",
    });
    expect(body).toMatch(/MEROS \/ INCIDENT RADAR/);
    expect(body).toMatch(/\/app\/workspaces\/novacart-support\/incidents\/detected\/ck-422/);
    expect(body).not.toMatch(/confirmed|resolved|fixed|refund/i);
    expect(body).not.toMatch(/@|\+254|phone|email|customer.*u1/i);
    expect(body.length).toBeLessThanOrEqual(2000);
  });

  it("safe title falls back instead of leaking", () => {
    expect(safeRadarTitle("Contact jane@example.com urgently")).toBe("Possible recurring support issue");
    expect(safeRadarTitle("Payment failed please thanks")).toBe("Possible recurring support issue");
  });

  it("decision formatter truncates and strips sensitive shapes", () => {
    expect(safeIdPrefix("ck-422-uuid-0000-0000-000000000001")).toBe("ck-422-u");
    expect(safeIdPrefix(null)).toBe("none");
    expect(safeSlug("novacart-support; DROP")).toBe("novacart-supportDROP");
    expect(safeSlug("")).toBe("unknown");
    expect(sanitizeReason("  a  b \n c  ")?.length).toBeLessThanOrEqual(120);
    const formatted = formatRadarDecision({
      outcome: "radar_ineligible",
      workspaceSlug: "novacart-support",
      candidateIdPrefix: "ck-422-uuid-0000",
      reason: "candidate evidence is generic-only",
    });
    // No raw addresses, contents, or full ids ever appear.
    const raw = JSON.stringify(formatted);
    expect(raw).not.toMatch(/thread|t-1|op-1|u1|c1|Visa pay failing|\+254|@/i);
    expect(formatted).toMatchObject({ outcome: "radar_ineligible", candidate: "ck-422-u" });
  });

  it("realRadar wiring never touches customer messaging or memory", async () => {
    const fs = await import("node:fs");
    const lib = fs.readFileSync("lib/radar.ts", "utf8");
    expect(lib).not.toMatch(/rememberInNamespace|rememberShared|walrus|sendMessage|transitionIncident|resolveConversation/);
  });

  it("logger mock never sends real iMessages", async () => {
    const postToThread = vi.fn(async () => {
      throw new Error("must not send in tests");
    });
    const result = await sendOperatorNotification(
      {
        workspaceId: "ws-novacart",
        operatorUserId: "op-1",
        type: "incident_detected",
        body: "x".repeat(10),
        idempotencyKey: "k-1",
        isTest: false,
      },
      {
        findBindingForOperator: async () => null,
        checkStaff: async () => {},
        getPreferences: async () => ({
          proactiveEnabled: true,
          quietHoursEnabled: false,
          quietStart: "22:00",
          quietEnd: "07:00",
          timezone: "Africa/Lagos",
          malformed: false,
        }),
        claimProactive: async () => ({ id: "o", status: "received", providerMessageId: null, deduped: false }),
        markSent: async () => {},
        markFailed: async () => {},
        postToThread,
      },
    );
    expect(result.ok).toBe(false);
    expect(postToThread).not.toHaveBeenCalled();
  });
});
