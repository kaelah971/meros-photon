import { describe, expect, it, vi } from "vitest";
import { handlePlanRequest, matchDraftConfirmation } from "../photon/plan-copilot";
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
    expect(res.body).toContain("just a draft");
    expect(res.body).toContain("needs your review");
    expect(res.body).toContain("nothing is approved or sent");
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
    expect(res.body).toContain("Reply YES");
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
    expect(cand.body).toContain("not a confirmed incident yet");
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
    expect(thin.body).toContain("can't draft anything useful yet");
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
    expect(busy.body).toContain("already on its way");
  });

  it("duplicate requests reuse the unchanged draft (idempotent)", async () => {
    let calls = 0;
    const stored = (builtResult() as Extract<GenerateResult, { action: "built" }>).plan;
    const idempotent = async (): Promise<GenerateResult> => { calls++; return { action: "unchanged", plan: stored }; };
    const sel = { state: "selected" as const, option: { kind: "incident" as const, id: INC, title: "Checkout 422" } };
    const a = await handlePlanRequest({ selection: sel, workspaceId: WS, slug: "demo-shop", authorized: true, runPlan: idempotent, getIncident: async () => incidentRow });
    const b = await handlePlanRequest({ selection: sel, workspaceId: WS, slug: "demo-shop", authorized: true, runPlan: idempotent, getIncident: async () => incidentRow });
    expect(calls).toBe(2);
    expect(a.body).toContain("already a draft");
    expect(b.body).toContain("already a draft");
    expect(a.body).toContain("nothing is approved or sent");
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
    expect(out.replyText).toContain("just a draft");
    expect(out.replyText).toContain("needs your review");
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
    expect(out.replyText).toContain("Reply YES");
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
    expect(capturedFacts).toContain("already a draft recovery plan (v2");
    expect(capturedFacts).toContain("needs your review");
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

describe("contextual YES confirmation (no exact phrase required)", () => {
  const promptFor = (shortRef: string): ConverseTurn => ({
    role: "assistant",
    text: `Checkout 422 [open, high].\n\nWant me to draft it? Reply YES — or reply "draft a recovery plan for #${shortRef}" anytime.`,
  });
  const SHORT = INC.slice(0, 8);

  it("matchDraftConfirmation binds YES to our newest prompt only", () => {
    expect(matchDraftConfirmation("yes", [promptFor(SHORT)])).toEqual({ shortRef: SHORT });
    expect(matchDraftConfirmation("Yes!", [promptFor(SHORT)])).toEqual({ shortRef: SHORT });
    expect(matchDraftConfirmation("go ahead", [promptFor(SHORT)])).toEqual({ shortRef: SHORT });
    expect(matchDraftConfirmation("yes", [])).toBeNull();
    expect(matchDraftConfirmation("no thanks", [promptFor(SHORT)])).toBeNull();
    expect(matchDraftConfirmation("yes", [{ role: "assistant", text: "All quiet here." }])).toBeNull();
    // Stale prompt expires once a newer assistant turn exists.
    expect(matchDraftConfirmation("yes", [promptFor(SHORT), { role: "assistant", text: "Anything else?" }])).toBeNull();
  });

  it("natural flow: inferred request → YES → draft, model never authorizes", async () => {
    const classify = vi.fn(async (): Promise<import("../photon/converse").ConversePlan> => ({ kind: "unknown", refHint: null, topic: null }));
    const phrase = vi.fn(async () => "phrased");
    let runs = 0;
    const history: ConverseTurn[] = [
      { role: "user", text: "what's happening with checkout?" },
      { role: "assistant", text: `Open now: "Checkout 422" [open, high] — 3 customers. #${SHORT} full ref ${INC}` },
    ];
    const ask = baseRuntime({
      text: "Can you put together a plan for me?",
      history,
      phrase,
      classify: async () => ({ kind: "plan_request", refHint: null, topic: null }),
      runPlan: async () => { runs++; return builtResult(); },
    });
    const confirm = await runConversational(ask);
    expect(confirm.kind).toBe("plan_request");
    expect(runs).toBe(0);
    expect(phrase).not.toHaveBeenCalled();
    expect(confirm.replyText).toContain("Reply YES");
    expect(confirm.replyText).toContain(`#${SHORT}`);
    // Owner replies YES — classify mock would say unknown; confirmation binds deterministically.
    const history2: ConverseTurn[] = [...history, { role: "user", text: "Can you put together a plan for me?" }, { role: "assistant", text: confirm.replyText }];
    const yes = baseRuntime({
      text: "Yes",
      history: history2,
      phrase,
      classify,
      runPlan: async () => { runs++; return builtResult(); },
    });
    const done = await runConversational(yes);
    expect(done.kind).toBe("plan_request");
    expect(runs).toBe(1);
    expect(classify).not.toHaveBeenCalled();
    expect(phrase).not.toHaveBeenCalled();
    expect(done.replyText).toContain("just a draft");
  });

  it("YES with no live matching incident stays honest and runs nothing", async () => {
    const history: ConverseTurn[] = [promptFor("deadbeef")];
    let runs = 0;
    const rt = baseRuntime({
      text: "yes",
      history,
      classify: async () => { throw new Error("must not be called"); },
      runPlan: async () => { runs++; return builtResult(); },
    });
    const out = await runConversational(rt);
    expect(out.kind).toBe("plan_request");
    expect(runs).toBe(0);
    expect(out.replyText).toContain("Which incident should I draft for?");
  });
});

describe("alert-context follow-up (status after Radar alert)", () => {
  const CAND = "22222222-3333-4444-5555-666666666666";
  const candRow = {
    id: CAND, title: "Checkout 422", summary: "same 422", status: "pending",
    confidence: "high", rationale: "r", acceptedIncidentId: null,
    conversations: 3, customers: 3, messages: 3, updatedAt: new Date().toISOString(),
  };
  const readsWithAlert = (alerts: { candidateId: string }[]) =>
    makeReads({
      listActiveIncidents: async () => [],
      listReviewCandidates: async () => [candRow],
      getCandidate: async (id, ws) => (id === CAND && ws === WS ? candRow : null),
      recentRadarAlerts: async () => alerts.map((a) => ({ ...a, createdAt: new Date().toISOString() })),
    });

  it("'what's going on' focuses the just-alerted candidate, labeled unconfirmed", async () => {
    let facts = "";
    const rt = baseRuntime({
      text: "What's going on?",
      reads: readsWithAlert([{ candidateId: CAND }]),
      stats: { openIssues: 0, conversations: 3, customers: 3 } as never,
      classify: async (): Promise<import("../photon/converse").ConversePlan> => ({ kind: "status", refHint: null, topic: null }),
      phrase: async (input) => { facts = input.facts; return "phrased"; },
    });
    const out = await runConversational(rt);
    expect(out.kind).toBe("status");
    expect(facts).toContain("SELECTED CANDIDATE");
    expect(facts).toContain("not confirmed yet");
    expect(facts).toContain("RADAR: a recent Radar alert exists");
  });

  it("fallback reply leads with the alerted record, never generic stats", async () => {
    const rt = baseRuntime({
      text: "What's going on?",
      reads: readsWithAlert([{ candidateId: CAND }]),
      stats: { openIssues: 0, conversations: 3, customers: 3 } as never,
      classify: async (): Promise<import("../photon/converse").ConversePlan> => ({ kind: "status", refHint: null, topic: null }),
      phrase: async () => { throw new Error("phrase down"); },
    });
    const out = await runConversational(rt);
    expect(out.replyText).toContain("Most recent alert:");
    expect(out.replyText).toContain("not confirmed yet");
  });

  it("several live alerts never auto-select on status; stale alerts are ignored", async () => {
    const CAND2 = "33333333-4444-5555-6666-777777777777";
    const candRow2 = { ...candRow, id: CAND2, title: "Login loop" };
    const twoLive = makeReads({
      listActiveIncidents: async () => [],
      listReviewCandidates: async () => [candRow, candRow2],
      getCandidate: async () => null,
      recentRadarAlerts: async () => [
        { candidateId: CAND, createdAt: new Date().toISOString() },
        { candidateId: CAND2, createdAt: new Date().toISOString() },
      ],
    });
    let facts = "";
    const multi = baseRuntime({
      text: "What's going on?",
      reads: twoLive,
      stats: { openIssues: 0, conversations: 3, customers: 3 } as never,
      classify: async (): Promise<import("../photon/converse").ConversePlan> => ({ kind: "status", refHint: null, topic: null }),
      phrase: async (input) => { facts = input.facts; return "phrased"; },
    });
    await runConversational(multi);
    expect(facts).not.toContain("SELECTED CANDIDATE");
    let facts2 = "";
    const stale = baseRuntime({
      text: "What's going on?",
      reads: readsWithAlert([{ candidateId: "99999999-0000-0000-0000-000000000000" }]),
      stats: { openIssues: 0, conversations: 3, customers: 3 } as never,
      classify: async (): Promise<import("../photon/converse").ConversePlan> => ({ kind: "status", refHint: null, topic: null }),
      phrase: async (input) => { facts2 = input.facts; return "phrased"; },
    });
    await runConversational(stale);
    expect(facts2).not.toContain("SELECTED CANDIDATE");
    expect(facts2).toContain("RADAR: no recent Radar alert in context");
  });

  it("explicit draft request on a pending candidate asks for review first", async () => {
    let runs = 0;
    const rt = baseRuntime({
      text: `draft a recovery plan for #${CAND.slice(0, 8)}`,
      reads: readsWithAlert([{ candidateId: CAND }]),
      classify: async (): Promise<import("../photon/converse").ConversePlan> => ({ kind: "status", refHint: null, topic: null }),
      runPlan: async () => { runs++; return builtResult(); },
    });
    const out = await runConversational(rt);
    expect(out.kind).toBe("plan_request");
    expect(runs).toBe(0);
    expect(out.replyText).toContain("not a confirmed incident yet");
  });

  it("'what do you think we should do' routes deterministically", async () => {
    const { fastClassify } = await import("../photon/converse");
    expect(fastClassify("What do you think we should do?")?.kind).toBe("next_steps");
    expect(fastClassify("What's going on?")?.kind).toBe("status");
  });
});

describe("P7 incident selection (topic beats recency)", () => {
  const VISA = "9d643921-35e1-4fdc-89f5-b98a11d0df0d";
  const TRACK = "8847f10d-a20c-493f-8af9-5f07afa2f319";
  const visaRow = {
    id: VISA, title: "Visa checkout fails with error CKT-422 Payment validation failed",
    status: "ready_for_action", severity: "medium", customers: 5, conversations: 6,
    evidence: 9, updatedAt: new Date().toISOString(),
  };
  const trackRow = {
    id: TRACK, title: "Tracking page shows parcel delivered but customer received nothing",
    status: "investigating", severity: "high", customers: 3, conversations: 3,
    evidence: 4, updatedAt: new Date().toISOString(),
  };
  const readsBoth = makeReads({
    listActiveIncidents: async () => [visaRow, trackRow],
    listReviewCandidates: async () => [],
    getIncident: async (id, ws) => (ws !== WS ? null : id === VISA ? visaRow : id === TRACK ? trackRow : null),
    getBrief: async () => null,
    getMatches: async () => ({ current: true, fingerprint: null, rows: [] as never[] }),
  });
  // Production history shape: newest assistant turn names Visa (listed),
  // older turns carry the tracking alert context.
  const prodHistory: ConverseTurn[] = [
    { role: "user", text: "what's going on?" },
    { role: "assistant", text: `Most recent alert: Possible issue (not confirmed yet): Tracking page shows parcel delivered. #${TRACK.slice(0, 8)}` },
    { role: "user", text: "what do you think we should do?" },
    { role: "assistant", text: `Open now: "Visa checkout fails with error CKT-422" [ready_for_action, medium] — 5 customers. #${VISA.slice(0, 8)}` },
  ];

  it("exact prod repro: 'plan for the tracking issue' selects tracking, not Visa", async () => {
    let runs: string[] = [];
    const rt = baseRuntime({
      text: "Can you put together a plan for the tracking issue?",
      history: prodHistory,
      reads: readsBoth,
      classify: async () => ({ kind: "plan_request", refHint: null, topic: null }),
      phrase: async () => { throw new Error("phrase must not run"); },
      runPlan: async (id) => { runs.push(id); return builtResult(); },
    });
    const confirm = await runConversational(rt);
    expect(confirm.kind).toBe("plan_request");
    expect(runs).toHaveLength(0);
    expect(confirm.replyText).toContain("Tracking page shows parcel delivered");
    expect(confirm.replyText).not.toContain("Visa checkout");
    expect(confirm.replyText).toContain(`#${TRACK.slice(0, 8)}`);
    // "Yes, please." authorizes the TRACKING draft only.
    const done = await runConversational(baseRuntime({
      text: "Yes, please.",
      history: [...prodHistory, { role: "user", text: "Can you put together a plan for the tracking issue?" }, { role: "assistant", text: confirm.replyText }],
      reads: readsBoth,
      classify: async () => { throw new Error("model must not authorize"); },
      phrase: async () => { throw new Error("phrase must not run"); },
      runPlan: async (id) => { runs.push(id); return builtResult(); },
    }));
    expect(runs).toEqual([TRACK]);
    expect(done.replyText).toContain("just a draft");
    expect(done.replyText).not.toContain("Visa");
  });

  it("unmatched explicit topic never falls back to history", async () => {
    const rt = baseRuntime({
      text: "Plan for the warehouse outage",
      history: prodHistory,
      reads: readsBoth,
      classify: async () => ({ kind: "plan_request", refHint: null, topic: null }),
      phrase: async () => "phrased",
      runPlan: async () => { throw new Error("must not generate"); },
    });
    const out = await runConversational(rt);
    expect(out.kind).toBe("plan_request");
    // Asks instead of guessing: lists options, links the list (not one record).
    expect(out.replyText).toContain("Which incident should I draft for?");
    expect(out.replyText).toContain("Visa checkout");
    expect(out.replyText).toContain("Tracking page");
  });

  it("tied topics ask for clarification instead of guessing", async () => {
    const rt = baseRuntime({
      text: "draft a plan for the checkout problem",
      history: [],
      reads: makeReads({
        listActiveIncidents: async () => [visaRow, { ...trackRow, title: "Checkout tracking page shows wrong status" }],
        listReviewCandidates: async () => [],
        getIncident: async () => null,
      }),
      classify: async (): Promise<import("../photon/converse").ConversePlan> => ({ kind: "plan_request", refHint: null, topic: null }),
      phrase: async () => "phrased",
    });
    const out = await runConversational(rt);
    expect(out.kind).toBe("plan_request");
    expect(out.replyText).toContain("which incident should I draft for");
  });

  it("accepted candidate resolves to its live incident", async () => {
    const candId = "aaaaaaaa-1111-2222-3333-444444444444";
    const rt = baseRuntime({
      text: "sofar",
      history: [],
      reads: makeReads({
        listActiveIncidents: async () => [trackRow],
        listReviewCandidates: async () => [{ id: candId, title: "Tracking 422", summary: "s", status: "pending", confidence: "high", rationale: "r", acceptedIncidentId: TRACK, conversations: 3, customers: 3, messages: 3, updatedAt: new Date().toISOString() }],
        getCandidate: async (id, ws) => (id === candId && ws === WS ? { id: candId, title: "Tracking 422", summary: "s", status: "pending", confidence: "high", rationale: "r", acceptedIncidentId: TRACK, conversations: 3, customers: 3, messages: 3, updatedAt: new Date().toISOString() } : null),
        getIncident: async (id, ws) => (id === TRACK && ws === WS ? trackRow : null),
        getBrief: async () => null,
      }),
      classify: async () => ({ kind: "sofar", refHint: candId, topic: null }),
      phrase: async (input) => input.facts,
    });
    const out = await runConversational(rt);
    expect(out.replyText).toContain(TRACK.slice(0, 8));
    expect(out.replyText).toContain("SELECTED INCIDENT");
  });

  it("human voice: no jargon, no raw statuses, draft meaning kept", async () => {
    const sel = { state: "selected" as const, option: { kind: "incident" as const, id: TRACK, title: trackRow.title } };
    const res = await handlePlanRequest({
      selection: sel, workspaceId: WS, slug: "demo-shop", authorized: true,
      runPlan: async () => builtResult(),
      getIncident: async () => ({ ...trackRow, customers: 3, conversations: 3 }),
    });
    for (const banned of ["ready_for_action", "UNCONFIRMED", "planning-only artifact", "Reply exactly", "validated draft", "[diagnostic]", "[corrective]", "Candidate ("]) {
      expect(res.body).not.toContain(banned);
    }
    expect(res.body).toContain("needs your review");
    expect(res.body).toContain("nothing is approved or sent");
    expect(res.body).toContain("Here's what I'd check first");
  });
});
