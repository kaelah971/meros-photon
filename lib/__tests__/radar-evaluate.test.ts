import { describe, expect, it, vi, beforeEach } from "vitest";
import type { RadarDecisionFields } from "../radar-decision";

// Shared Radar evaluation used by the live chat chain AND the deferred
// recovery sweep: a recovered join must alert exactly like a live one.
const decisions: unknown[] = [];
const sends: { threadId: string; text: string }[] = [];
const alertedKeys = new Set<string>();

vi.mock("@/lib/radar", async (importOriginal) => {
  const orig = (await importOriginal<typeof import("@/lib/radar")>()) as typeof import("@/lib/radar");
  return {
    ...orig,
    maybeSendRadarAlert: async (workspaceId: string, candidateId: string) => {
      // Eligible fixture candidate; anything else is ineligible/unknown.
      if (workspaceId !== "ws-nova" || candidateId !== "cand-1") {
        return candidateId === "cand-missing"
          ? { action: "deferred", reason: "candidate not found in this workspace" }
          : { action: "ineligible", reason: "no 60-minute window with 3 customers and 3 conversations" };
      }
      if (alertedKeys.has(candidateId)) return { action: "alerted", sent: 0, deduped: 1, suppressed: 0 };
      alertedKeys.add(candidateId);
      sends.push({ threadId: "thread-1", text: "MEROS / INCIDENT RADAR" });
      return { action: "alerted", sent: 1, deduped: 0, suppressed: 0 };
    },
    realRadarDeps: async () => ({}),
  };
});

vi.mock("@/lib/radar-decision", async (importOriginal) => {
  const orig = (await importOriginal<typeof import("@/lib/radar-decision")>()) as typeof import("@/lib/radar-decision");
  return {
    ...orig,
    logRadarDecision: (e: RadarDecisionFields) => {
      decisions.push(e);
      return orig.logRadarDecision(e);
    },
  };
});

import { evaluateRadarForOutcome } from "../radar-evaluate";

beforeEach(() => {
  decisions.length = 0;
  sends.length = 0;
  alertedKeys.clear();
});

const joined = { action: "joined", candidateId: "cand-1", newConversation: true } as const;

describe("shared Radar evaluation (live chain + recovery sweep)", () => {
  it("qualifying recovered join alerts once with an observable decision", async () => {
    const r = await evaluateRadarForOutcome({ workspaceId: "ws-nova", workspaceSlug: "nova", outcome: joined });
    expect(r).toEqual({ evaluated: true });
    expect(sends).toHaveLength(1);
    expect(sends[0].threadId).toBe("thread-1");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ outcome: "notification_accepted", candidateIdPrefix: "cand-1", workspaceSlug: "nova" });
  });

  it("created and non-new joins never evaluate", async () => {
    for (const o of [
      { action: "created", candidateId: "cand-1" },
      { action: "joined", candidateId: "cand-1", newConversation: false },
      { action: "already_clustered", candidateId: "cand-1" },
    ] as const) {
      expect(await evaluateRadarForOutcome({ workspaceId: "ws-nova", workspaceSlug: "nova", outcome: o })).toEqual({ evaluated: false });
    }
    expect(sends).toHaveLength(0);
    expect(decisions).toHaveLength(0);
  });

  it("repeat evaluation dedupes instead of resending", async () => {
    await evaluateRadarForOutcome({ workspaceId: "ws-nova", workspaceSlug: "nova", outcome: joined });
    const r = await evaluateRadarForOutcome({ workspaceId: "ws-nova", workspaceSlug: "nova", outcome: joined });
    expect(r).toEqual({ evaluated: true });
    expect(sends).toHaveLength(1);
    expect(decisions.filter((d) => (d as { outcome: string }).outcome === "notification_attempted")).toHaveLength(1);
  });

  it("unknown candidate defers with an observable failed decision, never a throw", async () => {
    const r = await evaluateRadarForOutcome({
      workspaceId: "ws-nova",
      workspaceSlug: "nova",
      outcome: { action: "joined", candidateId: "cand-missing", newConversation: true },
    });
    expect(r).toEqual({ evaluated: true });
    expect(sends).toHaveLength(0);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ outcome: "notification_failed" });
  });
});
