import { describe, expect, it } from "vitest";
import {
  diagnoseRecoveryPlan,
  generatePlanIfNeeded,
  validateRecoveryPlan,
  type PlanBrief,
  type PlanDeps,
  type PlanJudge,
  type PlanRow,
} from "../recovery-plans";

// P2: recovery plans must work with thin-but-sufficient grounded evidence
// (facts + source message IDs, zero historical matches) while the strict
// validator stays intact. Fakes only — no DB, no network, no model calls
// except the live check (separate temp file, deleted after one run).

const WS = "ws-p2";
const INC = "inc-p2";

function brief(over: Partial<PlanBrief["findings"]> = {}): PlanBrief {
  return {
    status: "current",
    version: 1,
    fingerprint: "fp-1",
    source_count: 2,
    generated_at: new Date().toISOString(),
    findings: {
      facts: [
        { observation: "Checkout returns HTTP 422 on card pay", identifiers: ["422"], sources: ["m-1"] },
        { observation: "Second customer saw the same 422 at 14:02", identifiers: ["422"], sources: ["m-2", "m-3"] },
      ],
      corroborated: [],
      contradictions: [],
      unknowns: ["whether cash payments work"],
      hypotheses: [],
      ...over,
    } as PlanBrief["findings"],
  };
}

type RawPlan = {
  problemSummary: string;
  approach: string;
  steps: Record<string, unknown>[];
  prerequisites: string[];
  missingInfo: string[];
  riskLevel: string;
  safetyWarnings: string[];
  expectedOutcomes: string[];
  verificationChecks: string[];
  rollbackNotes: string;
  historicalBasis: Record<string, unknown>[];
};

function diagRaw(evidenceRefs: string[]): RawPlan {
  return {
    problemSummary: "Customers see HTTP 422 when paying by card at checkout.",
    approach: "Reproduce with a test card, inspect gateway logs, then propose a fix with owner and verification.",
    steps: [
      {
        description: "Reproduce the 422 with a test card in staging",
        purpose: "Confirm the symptom outside production",
        kind: "diagnostic",
        evidenceRefs,
        matchRefs: [],
        prerequisites: [],
        expectedResult: "Same 422 or a clean pass, either is informative",
        risk: "low",
        humanRequired: false,
        verification: "Record request id and gateway response code",
      },
    ],
    prerequisites: [],
    missingInfo: ["gateway log excerpt"],
    riskLevel: "low",
    safetyWarnings: [],
    expectedOutcomes: ["A confirmed reproduction path"],
    verificationChecks: ["Staging log shows the same code"],
    rollbackNotes: "no corrective action proposed",
    historicalBasis: [],
  };
}

function makeDeps(judge: PlanJudge, over: { fingerprint?: string; rows?: PlanRow[] } = {}) {
  const rows: PlanRow[] = over.rows ?? [];
  let judgeCalls = 0;
  const fp = over.fingerprint ?? "fp-1";
  const deps: PlanDeps = {
    loadIncident: async (id, ws) =>
      id === INC && ws === WS ? { id, title: "Checkout 422", status: "open", severity: "high" } : null,
    loadBrief: async () => ({ ...brief(), fingerprint: fp }),
    loadMatches: async () => [],
    store: {
      loadActive: async () => rows.filter((r) => r.status !== "superseded" && r.status !== "rejected"),
      loadHistory: async () => rows,
      loadById: async (pid) => rows.find((r) => r.id === pid) ?? null,
      createDraft: async (input) => {
        const row = {
          id: `plan-${rows.length + 1}`,
          incident_id: input.incidentId,
          workspace_id: input.workspaceId,
          plan_version: rows.length + 1,
          status: "draft" as const,
          brief_fingerprint: input.fingerprint,
          brief_version: input.briefVersion,
          payload: input.payload,
          created_by_user_id: null,
          reviewed_by_user_id: null,
          reviewed_at: null,
          review_note: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        rows.push(row);
        return { row, deduped: false };
      },
      transition: async () => { throw new Error("not under test"); },
      supersedeOlder: async (_i, _w, keep) => {
        let n = 0;
        for (const r of rows) if (r.brief_fingerprint !== keep && r.status === "draft") { r.status = "superseded"; n++; }
        return n;
      },
    },
    judge: async (input) => { judgeCalls++; return judge(input); },
  };
  return { deps, rows, calls: () => judgeCalls };
}

describe("recovery-plan grounding (thin evidence, zero matches)", () => {
  it("builds a valid diagnostic-only plan citing real source IDs", async () => {
    let seen: Parameters<PlanJudge>[0] | null = null;
    const { deps, rows } = makeDeps(async (input) => {
      seen = input;
      return diagRaw([input.observations[0].sourceIds[0]]);
    });
    const r = await generatePlanIfNeeded(INC, WS, "op-1", deps);
    expect(r.action).toBe("built");
    if (r.action !== "built") return;
    expect(r.plan.payload.steps[0].evidenceRefs).toEqual(["m-1"]);
    expect(r.plan.payload.steps[0].matchRefs).toEqual([]);
    expect(rows).toHaveLength(1);
    // The judge received structured IDs — never asked to invent references.
    expect(seen!.observations).toEqual([
      { text: "Checkout returns HTTP 422 on card pay", sourceIds: ["m-1"] },
      { text: "Second customer saw the same 422 at 14:02", sourceIds: ["m-2", "m-3"] },
    ]);
  });

  it("steps spanning multiple facts cite distinct source IDs", async () => {
    const { deps } = makeDeps(async () => {
      const raw = diagRaw(["m-1"]);
      raw.steps = [
        { ...raw.steps[0], description: "Check fact one", evidenceRefs: ["m-1"] },
        { ...raw.steps[0], description: "Check fact two", evidenceRefs: ["m-2", "m-3"] },
      ];
      return raw;
    });
    const r = await generatePlanIfNeeded(INC, WS, "op-1", deps);
    expect(r.action).toBe("built");
    if (r.action !== "built") return;
    expect(r.plan.payload.steps.map((s) => s.evidenceRefs)).toEqual([["m-1"], ["m-2", "m-3"]]);
  });

  it("fabricated or unknown references fail with a safe category, storing nothing", async () => {
    const { deps, rows } = makeDeps(async () => diagRaw(["msg-invented-9"]));
    const r = await generatePlanIfNeeded(INC, WS, "op-1", deps);
    expect(r).toMatchObject({ action: "failed", error: expect.stringContaining("no_step_cited_authorized_evidence") });
    expect(rows).toHaveLength(0);
  });

  it("wrong-workspace references fail (validator scope is the brief's own IDs)", async () => {
    const ids = new Set(["ws-a-msg-1"]);
    expect(validateRecoveryPlan(diagRaw(["ws-b-msg-9"]), ids, new Set(), new Map())).toBeNull();
    expect(validateRecoveryPlan(diagRaw(["ws-a-msg-1"]), ids, new Set(), new Map())?.steps[0].evidenceRefs).toEqual([
      "ws-a-msg-1",
    ]);
  });

  it("unsafe corrective step (no owner) and certainty language are rejected", async () => {
    const ids = new Set(["m-1"]);
    const corrective = diagRaw(["m-1"]);
    corrective.steps = [{
      description: "Refund all affected cards now", purpose: "Make it right", kind: "corrective",
      evidenceRefs: ["m-1"], matchRefs: [], prerequisites: [], expectedResult: "Refunds sent",
      risk: "medium", humanRequired: false, verification: "Check ledger",
    }];
    expect(validateRecoveryPlan(corrective, ids, new Set(), new Map())).toBeNull();
    expect(diagnoseRecoveryPlan(corrective, ids, new Set(), new Map())).toBe("steps_rejected_safety_or_ownership");

    const certain = diagRaw(["m-1"]);
    certain.problemSummary = "The root cause is the database index.";
    expect(validateRecoveryPlan(certain, ids, new Set(), new Map())).toBeNull();
    expect(diagnoseRecoveryPlan(certain, ids, new Set(), new Map())).toBe("unsupported_certainty_or_executable_language");
  });

  it("high-risk corrective needs an approval warning", async () => {
    const ids = new Set(["m-1"]);
    const high = diagRaw(["m-1"]);
    high.riskLevel = "high";
    high.steps = [{
      description: "Rotate gateway credentials", purpose: "Rule out leak", kind: "corrective",
      evidenceRefs: ["m-1"], matchRefs: [], prerequisites: ["on-call owner"],
      expectedResult: "New credentials live", risk: "high", humanRequired: true,
      verification: "Staging charge succeeds",
    }];
    high.safetyWarnings = ["Downtime possible"];
    expect(validateRecoveryPlan(high, ids, new Set(), new Map())).toBeNull();
    expect(diagnoseRecoveryPlan(high, ids, new Set(), new Map())).toBe("high_risk_without_approval_warning");
    high.safetyWarnings = ["Requires human approval from the on-call owner before rotating."];
    expect(validateRecoveryPlan(high, ids, new Set(), new Map())?.riskLevel).toBe("high");
  });

  it("empty and malformed output fail with safe categories", async () => {
    const ids = new Set(["m-1"]);
    expect(diagnoseRecoveryPlan(null, ids, new Set(), new Map())).toBe("empty_or_malformed_output");
    expect(diagnoseRecoveryPlan({}, ids, new Set(), new Map())).toBe("missing_summary_or_approach");
    expect(diagnoseRecoveryPlan({ problemSummary: "x", approach: "y", steps: [], riskLevel: "low" }, ids, new Set(), new Map())).toBe(
      "no_step_cited_authorized_evidence",
    );
  });

  it("existing current plan is returned unchanged with zero judge calls", async () => {
    const existing = (await makeDeps(async () => diagRaw(["m-1"])).deps.store.createDraft({
      incidentId: INC, workspaceId: WS, fingerprint: "fp-1", briefVersion: 1,
      payload: validateRecoveryPlan(diagRaw(["m-1"]), new Set(["m-1", "m-2", "m-3"]), new Set(), new Map())!,
      createdByUserId: null,
    })).row;
    const d = makeDeps(async () => { throw new Error("judge must not run"); });
    d.rows.push(existing);
    const r = await generatePlanIfNeeded(INC, WS, "op-1", d.deps);
    expect(r).toMatchObject({ action: "unchanged" });
    expect(d.calls()).toBe(0);
  });

  it("new brief fingerprint supersedes the older plan; judge failure preserves data", async () => {
    const first = makeDeps(async () => diagRaw(["m-1"]));
    const built = await generatePlanIfNeeded(INC, WS, "op-1", first.deps);
    expect(built.action).toBe("built");
    const second = makeDeps(async () => diagRaw(["m-2"]), { rows: first.rows, fingerprint: "fp-2" });
    // Brief loader still returns fp-1 in makeDeps unless overridden — emulate the new brief via fingerprint param:
    second.deps.loadBrief = async () => ({ ...brief(), fingerprint: "fp-2", version: 2 });
    const r2 = await generatePlanIfNeeded(INC, WS, "op-1", second.deps);
    expect(r2.action).toBe("built");
    expect(first.rows.find((r) => r.brief_fingerprint === "fp-1")!.status).toBe("superseded");

    const failing = makeDeps(async () => { throw new Error("model down"); }, { rows: second.rows });
    failing.deps.loadBrief = async () => ({ ...brief(), fingerprint: "fp-3", version: 3 });
    const rf = await generatePlanIfNeeded(INC, WS, "op-1", failing.deps);
    expect(rf.action).toBe("failed");
    expect(second.rows.filter((r) => r.brief_fingerprint === "fp-3")).toHaveLength(0);
  });
});
