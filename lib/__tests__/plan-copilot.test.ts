import { describe, expect, it, vi } from "vitest";
import { handlePlanRequest } from "../photon/plan-copilot";
import {
  fastClassify,
  runConversational,
  type ConverseRuntime,
  type ConverseTurn,
} from "../photon/converse";
import type { InvestigateReads } from "../photon/investigate";
import type { GenerateResult } from "../recovery-plans";

// P3: iMessage copilot drafts grounded recovery plans. Fakes only — no DB,
// no network, no model. Operator auth lives in operator.ts (binding +
// staff before runConversational); these tests prove the copilot layer
// never trusts IDs, never generates without the deterministic gate, and
// never approves/executes.

const INC = "11111111-2222-3333-4444-555555555555";
const WS = "ws-copilot";

const incidentRow = {
  id: INC,
  title: "Checkout 422",
  status: "open",
  severity: "high",
  customers: 3,
  conversations: 3,
  evidence: 5,
  updatedAt: new Date().toISOString(),
};

function builtResult(): GenerateResult {
  return {
    action: "built",
    plan: {
      id: "plan-1",
      incident_id: INC,
      workspace_id: WS,
      plan_version: 1,
      status: "draft",
      brief_fingerprint: "fp-1",
      brief_version: 1,
      payload: {
        problemSummary: "Customers see HTTP 422 on card pay.",
        approach: "Reproduce, inspect logs, propose fix.",
        steps: [
          {
            description: "Reproduce the 422 with a test card in staging",
            purpose: "Confirm symptom",
            kind: "diagnostic",
            evidenceRefs: ["m-1"],
            matchRefs: [],
            prerequisites: [],
            expectedResult: "Same code or clean pass",
            risk: "low",
            humanRequired: false,
            verification: "Gateway log code",
          },
        ],
        prerequisites: [],
        missingInfo: ["gateway log excerpt"],
        riskLevel: "low",
        safetyWarnings: [],
        expectedOutcomes: ["A confirmed reproduction path"],
        verificationChecks: ["Staging log shows the code"],
        rollbackNotes: "no corrective action proposed",
        historicalBasis: [],
      },
      created_by_user_id: null,
      reviewed_by_user_id: null,
      reviewed_at: null,
      review_note: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  };
}

function makeReads(over: Partial<InvestigateReads> = {}): InvestigateReads {
  return {
    workspaceSlug: async () => "demo-shop",
    listActiveIncidents: async () => [incidentRow],
    listReviewCandidates: async () => [],
    getCandidate: async () => null,
    getIncident: async (id, ws) =>
      id === INC && ws === WS ? incidentRow : null,
    getBrief: async () => null,
    getMatches: async () => ({ current: true, fingerprint: null, rows: [] }),
    listDecisions: async () => [],
    recentRadarAlerts: async () => [],
    ...over,
  };
}

const baseRuntime = (over: Partial<ConverseRuntime> = {}): ConverseRuntime => ({
  text: "",
  history: [],
  workspaceId: WS,
  operatorUserId: "op-1",
  workspaceName: "Demo Shop",
  slug: "demo-shop",
  stats: null,
  reads: makeReads(),
  classify: async () => ({ kind: "unknown", refHint: null, topic: null }),
  phrase: async () => "phrased",
  ...over,
});

describe("plan copilot (deterministic gate + honest replies)", () => {
  it("authorized explicit request builds and summarizes with DRAFT labels + review link", async () => {
    let runs = 0;
    const res = await handlePlanRequest({
      selection: { state: "selected", option: { kind: "incident", id: INC, title: "Checkout 422" } },
      workspaceId: WS,
      slug: "demo-shop",
      authorized: true,
      runPlan: async () => { runs++; return builtResult(); },
      getIncident: async () => incidentRow,
    });
    expect(runs).toBe(1);
    expect(res.body).toContain("DRAFT");
    expect(res.body).toContain("needs human review");
    expect(res.body).toContain("not approved");
    expect(res.body).not.toMatch(/approv(ing|ed) this|will send|fixed/i);
    expect(res.body).toContain("Reproduce the 422");
    expect(res.link).toContain(`/app/workspaces/demo-shop/incidents/${INC}`);
    expect(res.body).not.toMatch(/ada@|customer miles|0803/i);
  });

  it("model-inferred intent gets a confirmation prompt, never generation", async () => {
    let runs = 0;
    const res = await handlePlanRequest({
      selection: { state: "selected", option: { kind: "incident", id: INC, title: "Checkout 422" } },
      workspaceId: WS,
      slug: "demo-shop",
      authorized: false,
      runPlan: async () => { runs++; return builtResult(); },
      getIncident: async () => incidentRow,
    });
    expect(runs).toBe(0);
    expect(res.body).toContain("draft a recovery plan for #");
  });

  it("ambiguous and missing selections clarify without guessing", async () => {
    const amb = await handlePlanRequest({
      selection: { state: "ambiguous", options: [{ kind: "incident", id: INC, title: "Checkout 422" }] },
      workspaceId: WS, slug: "demo-shop", authorized: true,
      runPlan: async () => builtResult(),
      getIncident: async () => incidentRow,
    });
    expect(amb.body).toContain("which incident");
    const none = await handlePlanRequest({
      selection: { state: "none", live: [] },
      workspaceId: WS, slug: "demo-shop", authorized: true,
      runPlan: async () => { throw new Error("must not run"); },
      getIncident: async () => incidentRow,
    });
    expect(none.body).toContain("Nothing to draft");
  });

  it("candidates are not draftable; foreign records stay undisclosed", async () => {
    const cand = await handlePlanRequest({
      selection: { state: "selected", option: { kind: "candidate", id: "cand-1", title: "Maybe 422" } },
      workspaceId: WS, slug: "demo-shop", authorized: true,
      runPlan: async () => { throw new Error("must not run"); },
      getIncident: async () => incidentRow,
    });
    expect(cand.body).toContain("unconfirmed");
    const foreign = await handlePlanRequest({
      selection: { state: "selected", option: { kind: "incident", id: "99999999-0000-0000-0000-000000000000", title: "???" } },
      workspaceId: WS, slug: "demo-shop", authorized: true,
      runPlan: async () => { throw new Error("must not run"); },
      getIncident: async () => null,
    });
    expect(foreign.body).toContain("isn't available anymore");
    expect(foreign.body).not.toContain("99999999");
  });

  it("insufficient evidence, failure, deferral, and in-progress report honestly", async () => {
    const getIncident = async () => incidentRow;
    const sel = { state: "selected" as const, option: { kind: "incident" as const, id: INC, title: "Checkout 422" } };
    const thin = await handlePlanRequest({
      selection: sel, workspaceId: WS, slug: "demo-shop", authorized: true,
      runPlan: async () => ({ action: "insufficient", reason: "brief has no grounded observations yet" }),
      getIncident,
    });
    expect(thin.body).toContain("can't draft yet");
    const failed = await handlePlanRequest({
      selection: sel, workspaceId: WS, slug: "demo-shop", authorized: true,
      runPlan: async () => { throw new Error("model down"); },
      getIncident,
    });
    expect(failed.body).toContain("nothing was created");
    const busy = await handlePlanRequest({
      selection: sel, workspaceId: WS, slug: "demo-shop", authorized: true,
      runPlan: async () => ({ action: "in_progress" }),
      getIncident,
    });
    expect(busy.body).toContain("already being prepared");
  });

  it("duplicate requests reuse the unchanged draft (idempotent)", async () => {
    let calls = 0;
    const stored = (builtResult() as Extract<GenerateResult, { action: "built" }>).plan;
    const idempotent = async (): Promise<GenerateResult> => { calls++; return { action: "unchanged", plan: stored }; };
    const sel = { state: "selected" as const, option: { kind: "incident" as const, id: INC, title: "Checkout 422" } };
    const a = await handlePlanRequest({ selection: sel, workspaceId: WS, slug: "demo-shop", authorized: true, runPlan: idempotent, getIncident: async () => incidentRow });
    const b = await handlePlanRequest({ selection: sel, workspaceId: WS, slug: "demo-shop", authorized: true, runPlan: idempotent, getIncident: async () => incidentRow });
    expect(calls).toBe(2);
    expect(a.body).toContain("Already drafted");
    expect(b.body).toContain("Already drafted");
    expect(a.body).toContain("not approved, nothing sent");
  });
});

describe("conversational wiring (no model phrasing on plan data)", () => {
  const history: ConverseTurn[] = [
    { role: "user", text: "what's happening with checkout?" },
    { role: "assistant", text: `Open now: "Checkout 422" [open, high] — 3 customers. #${INC.slice(0, 8)} full ref ${INC}` },
  ];

  it("'draft a recovery plan for this' resolves history context and drafts without the phrase model", async () => {
    const phrase = vi.fn(async () => "phrased");
    let runs = 0;
    const rt = baseRuntime({
      text: "draft a recovery plan for this",
      history,
      phrase,
      runPlan: async () => { runs++; return builtResult(); },
      classify: async (t, h) => fastClassify(t) ?? { kind: "unknown", refHint: null, topic: null },
    });
    const out = await runConversational(rt);
    expect(out.kind).toBe("plan_request");
    expect(runs).toBe(1);
    expect(phrase).not.toHaveBeenCalled();
    expect(out.replyText).toContain("DRAFT");
    expect(out.replyText).toContain("needs human review");
  });

  it("model-inferred plan intent asks for the explicit phrase (no generation)", async () => {
    const phrase = vi.fn(async () => "phrased");
    let runs = 0;
    const rt = baseRuntime({
      text: "could you put together a recovery plan?",
      history,
      phrase,
      runPlan: async () => { runs++; return builtResult(); },
      classify: async () => ({ kind: "plan_request", refHint: null, topic: null }),
    });
    const out = await runConversational(rt);
    expect(out.kind).toBe("plan_request");
    expect(runs).toBe(0);
    expect(phrase).not.toHaveBeenCalled();
    expect(out.replyText).toContain("reply exactly");
  });

  it("'what should we do' surfaces the existing validated draft", async () => {
    let capturedFacts = "";
    const rt = baseRuntime({
      text: "what should we do about checkout?",
      history,
      reads: makeReads({
        getPlan: async () => ({
          version: 2, status: "draft", riskLevel: "low", stepCount: 3,
          topSteps: ["Reproduce the 422 with a test card"], fingerprint: "fp-1",
        }),
      }),
      classify: async () => ({ kind: "next_steps", refHint: null, topic: null }),
      phrase: async (input) => { capturedFacts = input.facts; return "phrased plan summary"; },
    });
    const out = await runConversational(rt);
    expect(out.kind).toBe("next_steps");
    expect(capturedFacts).toContain("Validated draft plan v2");
    expect(capturedFacts).toContain("DRAFT, needs human review");
  });

  it("approval-flavored draft talk stays refused (action_request)", async () => {
    const phrase = vi.fn(async () => "phrased");
    let runs = 0;
    const rt = baseRuntime({
      text: "approve the recovery plan",
      history,
      phrase,
      runPlan: async () => { runs++; return builtResult(); },
      classify: async (t, h) => fastClassify(t) ?? { kind: "unknown", refHint: null, topic: null },
    });
    const out = await runConversational(rt);
    expect(out.kind).toBe("action_request");
    expect(runs).toBe(0);
    // action_request goes through the normal phrase path (read-only refusal
    // content is covered by the existing s15c suites); the copilot never runs.
  });
});
