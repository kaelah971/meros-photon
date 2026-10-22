import { describe, expect, it } from "vitest";
import {
  capFor,
  fallbackReply,
  fastClassify,
  fitConverse,
  factsText,
  gatherContext,
  runConversational,
} from "../photon/converse";

const INC_ID = "9d643921-35e1-4fdc-89f5-b98a11d0df0d";
const CAND_ID = "f9e2e571-c70a-42b9-bc9f-93be338aae20";

const OBS = [
  "My Visa checkout keeps failing with HTTP 422 every single time I try to pay for my order",
  "Visa checkout fails with error 422 when I submit payment for order 1042",
  "my visa checkout keeps failing with http 422 every single time i try to pay for my order!!!",
  "Checkout with Visa card returns 422 Payment validation failed again this morning",
  "Apple Pay worked fine but Visa keeps failing at checkout with a 422 error",
];
const UNKNOWNS = ["Whether the gateway or the app emits the 422"];

function makeReads(over: Record<string, unknown> = {}) {
  return {
    workspaceSlug: async () => "novacart-support",
    listActiveIncidents: async () => [
      { id: INC_ID, title: "Visa checkout fails with error CKT-422", status: "detected", severity: "medium", customers: 4, conversations: 6 },
    ],
    listReviewCandidates: async () => [
      { id: CAND_ID, title: "Checkout 422 pattern", status: "pending", conversations: 2, customers: 2 },
    ],
    getCandidate: async (id: string) =>
      id === CAND_ID
        ? { id, title: "Checkout 422 pattern", status: "pending", conversations: 2, customers: 2, summary: "Two more 422 checkout reports", confidence: "medium" }
        : null,
    getIncident: async (id: string) =>
      id === INC_ID
        ? { id, title: "Visa checkout fails with error CKT-422", status: "detected", severity: "medium", customers: 4, conversations: 6 }
        : null,
    getBrief: async (id: string) =>
      id === INC_ID
        ? {
            status: "current" as const,
            version: 2,
            fingerprint: "fp-12345678",
            generatedAt: new Date().toISOString(),
            facts: OBS.map((observation, i) => ({ observation, sources: [`m-${i}`] })),
            unknowns: UNKNOWNS,
            contradictions: [],
          }
        : null,
    getMatches: async () => ({ current: true, fingerprint: "fp-12345678", rows: [] }),
    listDecisions: async () => [{ label: "Review candidate Checkout 422 pattern" }],
    recentRadarAlerts: async () => [],
    ...over,
  };
}

const HISTORY = [
  { role: "assistant" as const, text: `Worth a look: "Visa checkout fails with error CKT-422" [detected, medium] — 4 customers across 6 conversations. #${INC_ID.slice(0, 8)}` },
];

async function sofarFallback() {
  const ctx = await gatherContext({
    plan: { kind: "sofar", refHint: null, topic: null },
    text: "Tell me more about that Visa checkout problem. What do we know so far, what's still uncertain, and what should we do next?",
    history: HISTORY,
    workspaceId: "ws-nova",
    operatorUserId: "op-1",
    workspaceName: "NovaCart",
    slug: "novacart-support",
    stats: null,
    reads: makeReads() as never,
  });
  expect(ctx.selected?.option.id).toBe(INC_ID);
  const fb = fallbackReply(ctx, { kind: "sofar", refHint: null, topic: null }, "novacart-support");
  return fitConverse(fb.body, fb.link, true);
}

describe("operator briefing quality (production-like fixtures)", () => {
  it("tell-me-more answers known, unknown, and next in labeled sections", async () => {
    const out = await sofarFallback();
    expect(out).toContain("What we know:");
    expect(out).toContain("Still unknown:");
    expect(out).toContain("Whether the gateway or the app emits the 422");
    expect(out).toContain("Suggested next step");
    expect(out).toContain("staff console");
    expect(out).toContain("read-only");
  });

  it("known findings are complete sentences, deduped, and capped", async () => {
    const out = await sofarFallback();
    const known = out.split("What we know:")[1].split("Still unknown:")[0];
    // Near-duplicate third observation collapses; max 3 distinct sentences.
    expect(known).not.toContain("!!!");
    const sentences = known.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
    expect(sentences.length).toBeLessThanOrEqual(3);
    for (const s of sentences) expect(s.trim()).toMatch(/[.!?]$/);
    // Repeat complaint appears once, not twice.
    const hits = known.toLowerCase().match(/every single time i try to pay/g) ?? [];
    expect(hits).toHaveLength(1);
  });

  it("never invents gateway logs, root causes, refunds, or completed recovery", async () => {
    const out = await sofarFallback();
    expect(out).not.toMatch(/refund|root cause|all fixed|resolved successfully|gateway log/i);
    expect(out).toMatch(/unconfirmed|detected|read-only/i);
  });

  it("stays within the detailed cap with the console link intact", async () => {
    const out = await sofarFallback();
    expect(out.length).toBeLessThanOrEqual(capFor("sofar"));
    expect(out).toContain(`/app/workspaces/novacart-support/incidents/${INC_ID}`);
  });

  it("compound questions are covered whichever single kind wins", async () => {
    // The production phrasing fast-paths to the briefing kind …
    expect(fastClassify("Tell me more about that Visa checkout problem. What do we know so far?")?.kind).toBe("sofar");
    // … a pure next-step ask routes to next_steps …
    expect(fastClassify("What should we do next?")?.kind).toBe("next_steps");
    // … while a bare compound with no fast-path trigger falls through to
    // model classification (which may pick sofar or next_steps). Either
    // way the structured reply answers every part:
    const out = await sofarFallback();
    expect(out).toMatch(/What we know:/);
    expect(out).toMatch(/Still unknown:/);
    expect(out).toMatch(/Suggested next step/);
  });

  it("missing brief degrades to a rebuild hint, not fragments", async () => {
    const reads = makeReads({ getBrief: async () => null });
    const ctx = await gatherContext({
      plan: { kind: "sofar", refHint: null, topic: null },
      text: "Tell me more.",
      history: HISTORY,
      workspaceId: "ws-nova",
      operatorUserId: "op-1",
      workspaceName: "NovaCart",
      slug: "novacart-support",
      stats: null,
      reads: reads as never,
    });
    const fb = fallbackReply(ctx, { kind: "sofar", refHint: null, topic: null }, "novacart-support");
    const out = fitConverse(fb.body, fb.link, true);
    expect(out).toContain("evidence brief assembles");
    expect(out).not.toContain("undefined");
  });

  it("timed-out phrasing falls back to the structured reply, never nothing", async () => {
    const { replyText, kind } = await runConversational({
      text: "Tell me more about that Visa checkout problem.",
      history: HISTORY,
      workspaceId: "ws-nova",
      operatorUserId: "op-1",
      workspaceName: "NovaCart",
      slug: "novacart-support",
      stats: null,
      reads: makeReads() as never,
      classify: async () => ({ kind: "sofar", refHint: null, topic: null }),
      phrase: async () => { throw new Error("converse phrase timed out"); },
    });
    expect(kind).toBe("sofar");
    expect(replyText).toContain("What we know:");
    expect(replyText).toContain("Suggested next step");
  });

  it("facts given to the model carry labeled NEXT STEPS and compound coverage", async () => {
    const ctx = await gatherContext({
      plan: { kind: "sofar", refHint: null, topic: null },
      text: "What happened, what is unknown, and what next?",
      history: HISTORY,
      workspaceId: "ws-nova",
      operatorUserId: "op-1",
      workspaceName: "NovaCart",
      slug: "novacart-support",
      stats: null,
      reads: makeReads() as never,
    });
    const facts = factsText(ctx, { kind: "sofar", refHint: null, topic: null }, "novacart-support");
    expect(facts).toContain("NEXT STEPS");
    expect(facts).toContain("SELECTED INCIDENT");
  });
});
