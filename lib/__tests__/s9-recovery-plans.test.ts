import { describe, expect, it, afterAll, vi } from "vitest";
import {
  briefEvidenceIds,
  canPlanTransition,
  generatePlanIfNeeded,
  reviewPlan,
  validateRecoveryPlan,
  type PlanBrief,
  type PlanDeps,
  type PlanMatch,
  type PlanPayload,
  type PlanRow,
  type PlanStore,
} from "../recovery-plans";
import { POST as generatePOST } from "@/app/api/incidents/[id]/plans/generate/route";
import { POST as reviewPOST } from "@/app/api/incidents/[id]/plans/[planId]/review/route";

// next/headers has no request scope in tests: control the cookie jar here.
let cookieJar = "";
vi.mock("next/headers", () => ({
  headers: async () => new Headers(cookieJar ? { cookie: cookieJar } : {}),
}));

const BRIEF: PlanBrief = {
  status: "current",
  version: 2,
  fingerprint: "fp-plan-1",
  findings: {
    facts: [
      {
        observation: "Visa checkout returns HTTP 500 on pay",
        identifiers: ["500", "Visa"],
        sources: ["m1", "m2"],
      },
    ],
    corroborated: [{ pattern: "Same 500 on Visa checkout", sources: ["m1", "m2"] }],
    contradictions: [{ description: "One reporter sees 402 instead of 500", between: ["m1", "m3"] }],
    unknowns: ["Root cause unknown", "Whether the gateway is the same"],
    hypotheses: [{ text: "Might be a gateway timeout", basedOn: ["m1"] }],
  },
  source_count: 3,
  generated_at: "2026-10-18T12:00:00.000Z",
};

const MATCHES: PlanMatch[] = [
  {
    refId: "card-1",
    tier: "verified_fix",
    reasons: ["Card records 500 on Visa checkout with a gateway-timeout cause"],
    matchingSymptoms: ["visa checkout returns http 500"],
    differences: [],
    unknowns: ["Whether the gateway is the same"],
    applicable: true,
    warning: "",
    cardStatus: "shared",
    cardResolved: true,
    cardExcerpt: "Symptom: Visa 500. Cause: gateway timeout. Fix: retried idempotently.",
  },
  {
    refId: "card-2",
    tier: "possible_match",
    reasons: ["Same checkout surface, different error code"],
    matchingSymptoms: ["visa checkout"],
    differences: ["candidate was a 402 decline path"],
    unknowns: ["Whether the decline path shares infrastructure"],
    applicable: false,
    warning: "candidate fixed 402 declines; current evidence shows 500s",
    cardStatus: "shared",
    cardResolved: false,
    cardExcerpt: "Symptom: Visa 402 decline. Fix: retried with 3DS.",
  },
];

function goodRaw() {
  return {
    problemSummary: "Visa checkout reports HTTP 500 on pay across two independent customer reports.",
    approach: "Verify the failure scope from the evidence first, then pursue the idempotent-retry lead with a named human owner.",
    steps: [
      {
        description: "Confirm the 500 scope from linked reports before touching anything",
        purpose: "Establish whether all reports share the same pay action and code",
        kind: "diagnostic",
        evidenceRefs: ["m1", "m2"],
        matchRefs: [],
        prerequisites: [],
        expectedResult: "A scoped list of affected actions and codes",
        risk: "low",
        humanRequired: false,
        verification: "Scope note recorded on the incident",
      },
      {
        description: "With staff approval, retry one affected checkout idempotently and observe",
        purpose: "Test whether the historically documented retry lead applies",
        kind: "corrective",
        evidenceRefs: ["m1"],
        matchRefs: ["card-1"],
        prerequisites: ["on-call approval in the incident thread", "idempotency key confirmed"],
        expectedResult: "Either a clean retry or a new evidence point",
        risk: "medium",
        humanRequired: true,
        verification: "Retry outcome recorded with provider reference",
      },
    ],
    prerequisites: ["on-call approval"],
    missingInfo: ["Root cause unknown", "Whether the gateway is the same"],
    riskLevel: "medium",
    safetyWarnings: ["Corrective steps require human approval before acting"],
    expectedOutcomes: ["A verified scope note or a confirmed retry outcome"],
    verificationChecks: ["Scope note present", "Retry outcome recorded"],
    rollbackNotes: "No persistent change is proposed; retries are read-safe to abandon.",
    historicalBasis: [
      {
        refId: "card-1",
        tier: "verified_fix",
        whatWasDocumented: "Visa 500 retried idempotently after gateway timeout",
        whyMayApply: "Same symptom, code, and surface as current evidence",
        differences: "",
        preconditions: "Idempotency key available",
        needsVerification: "Confirm the same gateway serves current traffic",
        caution: "",
      },
      {
        refId: "card-2",
        tier: "possible_match",
        whatWasDocumented: "Visa 402 decline path retried with 3DS",
        whyMayApply: "Same checkout surface",
        differences: "candidate was a 402 decline path, current evidence shows 500s",
        preconditions: "",
        needsVerification: "Whether the decline path shares infrastructure",
        caution: "A 402 decline fix is not evidence for a 500 failure mode",
      },
    ],
  };
}

describe("evidence id extraction (pure)", () => {
  it("collects every cited message id across finding kinds", () => {
    expect(briefEvidenceIds(BRIEF)).toEqual(new Set(["m1", "m2", "m3"]));
  });
});

describe("plan validation (pure)", () => {
  const evidenceIds = new Set(["m1", "m2", "m3"]);
  const matchIds = new Set(["card-1", "card-2"]);
  const tiers = new Map([
    ["card-1", "verified_fix"],
    ["card-2", "possible_match"],
  ]);

  it("accepts a grounded, safe proposal", () => {
    const out = validateRecoveryPlan(goodRaw(), evidenceIds, matchIds, tiers);
    expect(out).not.toBeNull();
    expect(out!.steps).toHaveLength(2);
    expect(out!.historicalBasis).toHaveLength(2);
  });

  it("rejects invented certainty about root causes", () => {
    const raw = goodRaw();
    raw.problemSummary = "The root cause is a database deadlock in payments.";
    expect(validateRecoveryPlan(raw, evidenceIds, matchIds, tiers)).toBeNull();
    const raw2 = goodRaw();
    raw2.approach = "We definitely know the gateway is down.";
    expect(validateRecoveryPlan(raw2, evidenceIds, matchIds, tiers)).toBeNull();
  });

  it("drops invented references and ungrounded steps", () => {
    const raw = goodRaw() as unknown as Record<string, unknown>;
    (raw.steps as Record<string, unknown>[])[0].evidenceRefs = ["ghost-msg"];
    (raw.steps as Record<string, unknown>[])[1].matchRefs = ["ghost-card"];
    const out = validateRecoveryPlan(raw, evidenceIds, matchIds, tiers);
    // First step loses its only ref and is dropped; second keeps m1.
    expect(out).not.toBeNull();
    expect(out!.steps).toHaveLength(1);
    expect(out!.steps[0].evidenceRefs).toEqual(["m1"]);

    const raw2 = goodRaw() as unknown as Record<string, unknown>;
    raw2.steps = [
      {
        description: "Do something",
        purpose: "Unknown",
        kind: "diagnostic",
        evidenceRefs: ["nope"],
        matchRefs: ["nah"],
        prerequisites: [],
        expectedResult: "x",
        risk: "low",
        humanRequired: false,
        verification: "y",
      },
    ];
    expect(validateRecoveryPlan(raw2, evidenceIds, matchIds, tiers)).toBeNull();
  });

  it("rejects executable commands, scripts, and endpoint calls", () => {
    const raw = goodRaw();
    raw.steps[1].description = "Run `curl https://ops.internal/exec -d reboot` on the gateway";
    const out = validateRecoveryPlan(raw, evidenceIds, matchIds, tiers);
    expect(out).not.toBeNull();
    expect(out!.steps).toHaveLength(1); // unsafe step dropped, diagnostic survives

    const raw2 = goodRaw();
    raw2.steps = [
      {
        description: "sudo rm -rf /var/payments and restart",
        purpose: "x",
        kind: "corrective",
        evidenceRefs: ["m1"],
        matchRefs: [],
        prerequisites: ["y"],
        expectedResult: "z",
        risk: "high",
        humanRequired: true,
        verification: "w",
      },
    ];
    expect(validateRecoveryPlan(raw2, evidenceIds, matchIds, tiers)).toBeNull();
  });

  it("requires human ownership, prerequisites, and verification for corrective steps", () => {
    const raw = goodRaw();
    raw.steps[1].humanRequired = false;
    expect(validateRecoveryPlan(raw, evidenceIds, matchIds, tiers)?.steps).toHaveLength(1);
    const raw2 = goodRaw();
    raw2.steps[1].prerequisites = [];
    expect(validateRecoveryPlan(raw2, evidenceIds, matchIds, tiers)?.steps).toHaveLength(1);
    const raw3 = goodRaw();
    raw3.steps[1].verification = "   ";
    expect(validateRecoveryPlan(raw3, evidenceIds, matchIds, tiers)?.steps).toHaveLength(1);
  });

  it("requires a human-approval warning for high-risk corrective steps", () => {
    const raw = goodRaw();
    raw.steps[1].risk = "high";
    raw.safetyWarnings = ["Be careful out there"];
    expect(validateRecoveryPlan(raw, evidenceIds, matchIds, tiers)).toBeNull();
    const raw2 = goodRaw();
    raw2.steps[1].risk = "high";
    raw2.safetyWarnings = ["High-risk retry requires explicit human approval first"];
    expect(validateRecoveryPlan(raw2, evidenceIds, matchIds, tiers)).not.toBeNull();
  });

  it("requires caution for non-verified historical tiers", () => {
    const raw = goodRaw();
    raw.historicalBasis[1].caution = "";
    expect(validateRecoveryPlan(raw, evidenceIds, matchIds, tiers)?.historicalBasis).toHaveLength(1);
    const raw2 = goodRaw();
    raw2.historicalBasis = [
      { ...raw2.historicalBasis[1], refId: "ghost" },
    ];
    // Invented card ref is dropped; the grounded plan itself still stands.
    const out2 = validateRecoveryPlan(raw2, evidenceIds, matchIds, tiers);
    expect(out2).not.toBeNull();
    expect(out2!.historicalBasis).toHaveLength(0);
  });

  it("fails closed on malformed output", () => {
    expect(validateRecoveryPlan(null, evidenceIds, matchIds, tiers)).toBeNull();
    expect(validateRecoveryPlan({ steps: [] }, evidenceIds, matchIds, tiers)).toBeNull();
    expect(validateRecoveryPlan({ ...goodRaw(), riskLevel: "extreme" }, evidenceIds, matchIds, tiers)).toBeNull();
  });
});

describe("plan lifecycle rules (pure)", () => {
  it("allows draft -> under_review -> staged and rejections only", () => {
    expect(canPlanTransition("draft", "under_review")).toBe(true);
    expect(canPlanTransition("draft", "rejected")).toBe(true);
    expect(canPlanTransition("under_review", "staged")).toBe(true);
    expect(canPlanTransition("under_review", "rejected")).toBe(true);
    expect(canPlanTransition("draft", "staged")).toBe(false);
    expect(canPlanTransition("staged", "draft")).toBe(false);
    expect(canPlanTransition("rejected", "draft")).toBe(false);
    expect(canPlanTransition("superseded", "draft")).toBe(false);
  });
});

// ---- Orchestration with fakes (no AI, no Neon) ----

function makeStore() {
  const rows: PlanRow[] = [];
  let n = 0;
  const store: PlanStore = {
    loadActive: async (incidentId, workspaceId) =>
      rows
        .filter(
          (r) =>
            r.incident_id === incidentId &&
            r.workspace_id === workspaceId &&
            ["draft", "under_review", "staged"].includes(r.status),
        )
        .sort((a, b) => b.plan_version - a.plan_version),
    loadHistory: async (incidentId, workspaceId) =>
      rows
        .filter((r) => r.incident_id === incidentId && r.workspace_id === workspaceId)
        .sort((a, b) => b.plan_version - a.plan_version)
        .slice(0, 20),
    loadById: async (planId, workspaceId) =>
      rows.find((r) => r.id === planId && r.workspace_id === workspaceId) ?? null,
    createDraft: async (input) => {
      const dup = rows.find(
        (r) =>
          r.incident_id === input.incidentId &&
          r.brief_fingerprint === input.fingerprint &&
          ["draft", "under_review", "staged"].includes(r.status),
      );
      if (dup) return { row: dup, deduped: true }; // partial unique index
      n++;
      const max = rows
        .filter((r) => r.incident_id === input.incidentId)
        .reduce((m, r) => Math.max(m, r.plan_version), 0);
      const row: PlanRow = {
        id: `plan-${n}`,
        incident_id: input.incidentId,
        workspace_id: input.workspaceId,
        plan_version: max + 1,
        status: "draft",
        brief_fingerprint: input.fingerprint,
        brief_version: input.briefVersion,
        payload: input.payload,
        created_by_user_id: input.createdByUserId,
        reviewed_by_user_id: null,
        reviewed_at: null,
        review_note: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      rows.push(row);
      return { row, deduped: false };
    },
    transition: async (input) => {
      const row = rows.find((r) => r.id === input.planId && r.workspace_id === input.workspaceId);
      if (!row) throw Object.assign(new Error("plan not found"), { status: 404 });
      const { canPlanTransition } = await import("../recovery-plans");
      if (!canPlanTransition(row.status, input.to)) {
        throw Object.assign(new Error(`cannot move plan from ${row.status} to ${input.to}`), { status: 409 });
      }
      row.status = input.to;
      row.reviewed_by_user_id = input.actorUserId;
      row.reviewed_at = new Date().toISOString();
      row.review_note = input.note?.trim() ? input.note.trim().slice(0, 500) : null;
      return row;
    },
    supersedeOlder: async (incidentId, workspaceId, keepFingerprint) => {
      let count = 0;
      for (const r of rows) {
        if (
          r.incident_id === incidentId &&
          r.workspace_id === workspaceId &&
          r.brief_fingerprint !== keepFingerprint &&
          ["draft", "under_review", "staged"].includes(r.status)
        ) {
          r.status = "superseded";
          count++;
        }
      }
      return count;
    },
  };
  return { store, rows };
}

function makeDeps(opts: {
  brief?: PlanBrief | null;
  matches?: PlanMatch[];
  judge?: PlanDeps["judge"];
  incident?: { id: string; title: string; status: string; severity: string } | null;
} = {}) {
  const { store, rows } = makeStore();
  let judgeCalls = 0;
  const deps: PlanDeps = {
    loadIncident: async () => ("incident" in opts ? (opts.incident ?? null) : { id: "inc-1", title: "Visa outage", status: "investigating", severity: "high" }),
    loadBrief: async () => ("brief" in opts ? (opts.brief ?? null) : BRIEF),
    loadMatches: async () => opts.matches ?? MATCHES,
    store,
    judge: async (input) => {
      judgeCalls++;
      return (opts.judge ?? (async () => goodRaw()))(input);
    },
  };
  return { deps, rows, store, calls: () => ({ judgeCalls }), input: { incidentId: "inc-1", workspaceId: "ws-1" } };
}

describe("generation orchestration (fakes)", () => {
  it("builds a grounded draft from current evidence + matches", async () => {
    const { deps, input, rows, calls } = makeDeps();
    const r = await generatePlanIfNeeded(input.incidentId, input.workspaceId, "op-1", deps);
    expect(r.action).toBe("built");
    if (r.action !== "built") return;
    expect(r.plan.status).toBe("draft");
    expect(r.plan.plan_version).toBe(1);
    expect(r.plan.payload.steps).toHaveLength(2);
    expect(r.plan.payload.steps.every((s) => s.evidenceRefs.length + s.matchRefs.length > 0)).toBe(true);
    expect(r.plan.payload.steps.filter((s) => s.kind === "corrective").every((s) => s.humanRequired)).toBe(true);
    expect(rows).toHaveLength(1);
    expect(calls().judgeCalls).toBe(1);
  });

  it("returns the existing plan for unchanged evidence (zero model calls)", async () => {
    const { deps, input, calls } = makeDeps();
    expect((await generatePlanIfNeeded(input.incidentId, input.workspaceId, "op-1", deps)).action).toBe("built");
    const r2 = await generatePlanIfNeeded(input.incidentId, input.workspaceId, "op-1", deps);
    expect(r2.action).toBe("unchanged");
    expect(calls().judgeCalls).toBe(1);
  });

  it("supersedes old proposals on new evidence and versions up", async () => {
    const { deps, input, rows } = makeDeps();
    await generatePlanIfNeeded(input.incidentId, input.workspaceId, "op-1", deps);
    const v2 = { ...BRIEF, fingerprint: "fp-plan-2", version: 3 };
    const r2 = await generatePlanIfNeeded(input.incidentId, input.workspaceId, "op-1", {
      ...deps,
      loadBrief: async () => v2,
    });
    expect(r2.action).toBe("built");
    if (r2.action !== "built") return;
    expect(r2.plan.plan_version).toBe(2);
    expect(rows.find((x) => x.brief_fingerprint === "fp-plan-1")?.status).toBe("superseded");
    expect(rows).toHaveLength(2);
  });

  it("reports insufficient evidence without calling the judge or storing", async () => {
    for (const brief of [
      null,
      { ...BRIEF, status: "stale" },
      { ...BRIEF, status: "pending" },
      {
        ...BRIEF,
        findings: { facts: [], corroborated: [], contradictions: [], unknowns: ["What happened?"], hypotheses: [] },
      },
    ] as const) {
      const { deps, input, rows, calls } = makeDeps({ brief });
      const r = await generatePlanIfNeeded(input.incidentId, input.workspaceId, "op-1", deps);
      expect(r.action).toBe("insufficient");
      expect(calls().judgeCalls).toBe(0);
      expect(rows).toHaveLength(0);
    }
  });

  it("drafts a diagnostic plan with no matches (no invented history)", async () => {
    const { deps, input } = makeDeps({ matches: [] });
    const r = await generatePlanIfNeeded(input.incidentId, input.workspaceId, "op-1", {
      ...deps,
      judge: async () => {
        const raw = goodRaw();
        raw.historicalBasis = [];
        raw.steps = [raw.steps[0]];
        return raw;
      },
    });
    expect(r.action).toBe("built");
    if (r.action !== "built") return;
    expect(r.plan.payload.historicalBasis).toHaveLength(0);
    expect(r.plan.payload.steps[0].matchRefs).toHaveLength(0);
  });

  it("fails closed on unsafe or unusable judge output, keeping existing data", async () => {
    const { deps, input, rows } = makeDeps({
      judge: async () => ({ problemSummary: "The root cause is the database.", approach: "Restart it." }),
    });
    const r = await generatePlanIfNeeded(input.incidentId, input.workspaceId, "op-1", deps);
    expect(r.action).toBe("failed");
    expect(rows).toHaveLength(0);

    const throwing = makeDeps({
      judge: async () => {
        throw new Error("model down");
      },
    });
    expect(
      (await generatePlanIfNeeded(throwing.input.incidentId, throwing.input.workspaceId, "op-1", throwing.deps)).action,
    ).toBe("failed");
  });

  it("concurrent same-fingerprint generates run the judge once", async () => {
    const { deps, input, calls } = makeDeps({
      judge: async () => {
        await new Promise((r) => setTimeout(r, 20));
        return goodRaw();
      },
    });
    const [a, b] = await Promise.all([
      generatePlanIfNeeded(input.incidentId, input.workspaceId, "op-1", deps),
      generatePlanIfNeeded(input.incidentId, input.workspaceId, "op-1", deps),
    ]);
    expect([a.action, b.action].sort()).toEqual(["built", "in_progress"]);
    expect(calls().judgeCalls).toBe(1);
  });

  it("defers when the incident is missing or cross-workspace", async () => {
    const { deps, input, calls } = makeDeps({ incident: null });
    const r = await generatePlanIfNeeded(input.incidentId, "ws-foreign", "op-1", deps);
    expect(r.action).toBe("deferred");
    expect(calls().judgeCalls).toBe(0);
  });

  it("carries no execution or outbound surface", async () => {
    const { deps, input } = makeDeps();
    await generatePlanIfNeeded(input.incidentId, input.workspaceId, "op-1", deps);
    expect(Object.keys(deps).sort()).toEqual(["judge", "loadBrief", "loadIncident", "loadMatches", "store"]);
    const payload = JSON.stringify(deps);
    expect(payload).not.toMatch(/execute|webhook|sendMessage|postToThread/i);
  });
});

describe("review orchestration (fakes)", () => {
  async function built() {
    const { deps, input, store } = makeDeps();
    const r = await generatePlanIfNeeded(input.incidentId, input.workspaceId, "op-1", deps);
    if (r.action !== "built") throw new Error("setup failed");
    return { store, plan: r.plan };
  }

  it("walks draft -> under_review -> staged with actor attribution", async () => {
    const { store, plan } = await built();
    const deps = { store };
    const s1 = await reviewPlan(plan.id, "ws-1", "reviewer-1", "submit_for_review", null, deps);
    expect(s1.action).toBe("reviewed");
    if (s1.action !== "reviewed") return;
    expect(s1.plan.status).toBe("under_review");
    expect(s1.plan.reviewed_by_user_id).toBe("reviewer-1");
    const s2 = await reviewPlan(plan.id, "ws-1", "reviewer-2", "stage", "looks safe to consider", deps);
    if (s2.action !== "reviewed") throw new Error("stage failed");
    expect(s2.plan.status).toBe("staged");
    expect(s2.plan.review_note).toBe("looks safe to consider");
  });

  it("rejects from draft or review, and blocks illegal jumps", async () => {
    const { store, plan } = await built();
    const deps = { store };
    const bad = await reviewPlan(plan.id, "ws-1", "op-1", "stage", null, deps);
    expect(bad.action).toBe("deferred"); // draft -> staged is not a step
    const rej = await reviewPlan(plan.id, "ws-1", "op-1", "reject", "not applicable", deps);
    expect(rej.action).toBe("reviewed");
    if (rej.action !== "reviewed") return;
    expect(rej.plan.status).toBe("rejected");
    const after = await reviewPlan(plan.id, "ws-1", "op-1", "submit_for_review", null, deps);
    expect(after.action).toBe("deferred"); // rejected is terminal
  });

  it("scopes plans to the workspace", async () => {
    const { store, plan } = await built();
    const r = await reviewPlan(plan.id, "ws-foreign", "op-1", "reject", null, { store });
    expect(r.action).toBe("deferred");
  });
});

describe("route authorization", () => {
  it("anonymous callers get 401 without touching data", async () => {
    cookieJar = "";
    const gen = await generatePOST(
      new Request("http://test/api/x/plans/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceSlug: "northstar" }),
      }),
      { params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000" }) },
    );
    expect(gen.status).toBe(401);
    const rev = await reviewPOST(
      new Request("http://test/api/x/plans/p/review", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceSlug: "northstar", action: "stage" }),
      }),
      { params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000", planId: "00000000-0000-0000-0000-000000000000" }) },
    );
    expect(rev.status).toBe(401);
  }, 30_000);
});

// ---- Live persistence: real store round-trip, review audit, history ----

const stamp = Date.now().toString(36);
const PW = "correct-horse-123";
const createdEmails: string[] = [];
const createdOrgIds: string[] = [];
const SLUG = `s9-ws-${stamp}`;

function dbKey(): string {
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  return readFileSync(".env.local", "utf8")
    .split("\n")
    .map((l: string) => l.trim())
    .find((l: string) => l.startsWith("DATABASE_URL="))!
    .slice("DATABASE_URL=".length);
}

async function signupSession(email: string): Promise<string> {
  const { auth } = await import("../better-auth");
  const res = (await auth.api.signUpEmail({
    body: { email, password: PW, name: email.split("@")[0] },
    headers: new Headers(),
    asResponse: true,
  })) as unknown as Response;
  const setCookies = res.headers.getSetCookie();
  const sessionCookie = setCookies.find((c) => c.startsWith("meros.session_token="))!;
  createdEmails.push(email);
  return sessionCookie.split(";")[0];
}

afterAll(async () => {
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(dbKey());
  for (const id of createdOrgIds) {
    await sql`delete from organizations where id = ${id}`;
  }
  for (const email of createdEmails) {
    await sql`delete from "user" where email = ${email}`;
  }
});

function testPayload(): PlanPayload {
  return {
    problemSummary: "Visa checkout reports HTTP 500 on pay.",
    approach: "Verify scope, then pursue the retry lead with approval.",
    steps: [
      {
        description: "Confirm scope from linked reports",
        purpose: "Bound the affected actions",
        kind: "diagnostic",
        evidenceRefs: ["m1"],
        matchRefs: [],
        prerequisites: [],
        expectedResult: "Scoped note",
        risk: "low",
        humanRequired: false,
        verification: "Note recorded",
      },
    ],
    prerequisites: [],
    missingInfo: ["Root cause unknown"],
    riskLevel: "low",
    safetyWarnings: [],
    expectedOutcomes: ["Scoped note"],
    verificationChecks: ["Note present"],
    rollbackNotes: "No change proposed.",
    historicalBasis: [],
  };
}

describe("plan persistence (live Neon)", () => {
  it("versions drafts, audits reviews, and supersedes on new evidence", async () => {
    const { organizationIdForSlug, workspaceIdForSlug } = await import("../tenant");
    const { ensureOrganization, ensureWorkspace, addOrganizationMember } = await import("../db");
    const orgId = organizationIdForSlug(SLUG);
    await ensureOrganization({ id: orgId, slug: SLUG, name: `Temp ${SLUG}` });
    const wsId = workspaceIdForSlug(SLUG);
    await ensureWorkspace({ id: wsId, organizationId: orgId, slug: SLUG, name: `Temp ${SLUG}` });
    createdOrgIds.push(orgId);
    cookieJar = await signupSession(`s9-staff-${stamp}@example.test`);
    const { neon } = await import("@neondatabase/serverless");
    const sql = neon(dbKey());
    const staff = (await sql`select id from "user" where email = ${`s9-staff-${stamp}@example.test`} limit 1`) as unknown as {
      id: string;
    }[];
    await addOrganizationMember({ organizationId: orgId, userId: staff[0].id, role: "owner" });

    const { createIncident, listIncidentEvents } = await import("../incidents");
    const inc = await createIncident({ workspaceId: wsId, title: "S9 live incident", createdByUserId: staff[0].id });

    const { realPlanStore } = await import("../recovery-plans");
    const store = await realPlanStore();
    const d1 = await store.createDraft({
      incidentId: inc.id,
      workspaceId: wsId,
      fingerprint: `fp-s9a-${stamp}`,
      briefVersion: 1,
      payload: testPayload(),
      createdByUserId: staff[0].id,
    });
    expect(d1.deduped).toBe(false);
    expect(d1.row.plan_version).toBe(1);
    expect(d1.row.status).toBe("draft");

    // Same evidence repeats dedupe instead of duplicating.
    const d1b = await store.createDraft({
      incidentId: inc.id,
      workspaceId: wsId,
      fingerprint: `fp-s9a-${stamp}`,
      briefVersion: 1,
      payload: testPayload(),
      createdByUserId: staff[0].id,
    });
    expect(d1b.deduped).toBe(true);
    expect(d1b.row.id).toBe(d1.row.id);

    // Review walk with actor attribution + timeline audit.
    const submitted = await store.transition({
      planId: d1.row.id,
      workspaceId: wsId,
      to: "under_review",
      actorUserId: staff[0].id,
    });
    expect(submitted.status).toBe("under_review");
    expect(submitted.reviewed_by_user_id).toBe(staff[0].id);
    const staged = await store.transition({
      planId: d1.row.id,
      workspaceId: wsId,
      to: "staged",
      actorUserId: staff[0].id,
      note: "consider next",
    });
    expect(staged.status).toBe("staged");
    expect(staged.review_note).toBe("consider next");
    await expect(
      store.transition({ planId: d1.row.id, workspaceId: wsId, to: "draft", actorUserId: staff[0].id }),
    ).rejects.toThrow();

    // New evidence versions up and supersedes the old proposal.
    const d2 = await store.createDraft({
      incidentId: inc.id,
      workspaceId: wsId,
      fingerprint: `fp-s9b-${stamp}`,
      briefVersion: 2,
      payload: testPayload(),
      createdByUserId: staff[0].id,
    });
    expect(d2.row.plan_version).toBe(2);
    const superseded = await store.supersedeOlder(inc.id, wsId, `fp-s9b-${stamp}`);
    expect(superseded).toBe(1);
    const history = await store.loadHistory(inc.id, wsId);
    expect(history.map((h) => h.status).sort()).toEqual(["draft", "superseded"]);

    // Timeline audit captured the review walk.
    const events = await listIncidentEvents(inc.id, wsId);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("plan_created");
    expect(kinds).toContain("plan_submitted");
    expect(kinds).toContain("plan_staged");
    expect(kinds).toContain("plan_superseded");
    // No per-test deletes: the afterAll organization delete cascades through
    // workspaces -> incidents/plans/events (test-hygiene rule).
  }, 120_000);
});
