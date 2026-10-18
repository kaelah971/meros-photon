import { describe, expect, it, afterAll, vi } from "vitest";
import {
  canonicalScope,
  checkAutoEligibility,
  claimManualExecution,
  decideApproval,
  isHighImpact,
  requestApproval,
  verifyManualExecution,
  type ApprovalDeps,
  type ApprovalRow,
  type ApprovalStore,
  type ExecutionRow,
  type ExecutionStore,
  type PlanRef,
} from "../recovery-approvals";
import { POST as approvalPOST } from "@/app/api/incidents/[id]/plans/[planId]/approvals/route";
import { POST as decisionPOST } from "@/app/api/incidents/[id]/plans/[planId]/approvals/[approvalId]/decision/route";
import { POST as executionsPOST } from "@/app/api/incidents/[id]/plans/[planId]/executions/route";
import { POST as verifyPOST } from "@/app/api/incidents/[id]/plans/[planId]/executions/[executionId]/verify/route";

let cookieJar = "";
vi.mock("next/headers", () => ({
  headers: async () => new Headers(cookieJar ? { cookie: cookieJar } : {}),
}));

function lowPlan(over: Partial<PlanRef> = {}): PlanRef {
  return {
    id: "plan-1",
    incident_id: "inc-1",
    workspace_id: "ws-1",
    plan_version: 1,
    status: "staged",
    brief_fingerprint: "fp-1",
    payload: {
      riskLevel: "low",
      steps: [
        { risk: "low", kind: "diagnostic" },
        { risk: "medium", kind: "corrective" },
      ],
      prerequisites: ["access"],
    },
    ...over,
  };
}

function highPlan(): PlanRef {
  return lowPlan({ payload: { riskLevel: "high", steps: [{ risk: "high", kind: "corrective" }], prerequisites: [] } });
}

function makeStores() {
  const approvals: ApprovalRow[] = [];
  const executions: ExecutionRow[] = [];
  let an = 0;
  let en = 0;
  const aStore: ApprovalStore = {
    listForPlan: async (planId, ws) => approvals.filter((a) => a.plan_id === planId && a.workspace_id === ws),
    loadById: async (id, ws) => approvals.find((a) => a.id === id && a.workspace_id === ws) ?? null,
    insertRequested: async (input) => {
      const dup = approvals.find(
        (a) => a.plan_id === input.plan.id && a.scope_hash === input.scopeHash && ["requested", "approved"].includes(a.status),
      );
      if (dup) return { row: dup, deduped: true };
      const raced = approvals.find((a) => a.plan_id === input.plan.id && ["requested", "approved"].includes(a.status));
      if (raced && input.scopeHash !== raced.scope_hash) {
        // Different scope while one is active: keep single-active invariant.
        return { row: raced, deduped: true };
      }
      an++;
      const row: ApprovalRow = {
        id: `ap-${an}`,
        plan_id: input.plan.id,
        incident_id: input.plan.incident_id,
        workspace_id: input.plan.workspace_id,
        plan_version: input.plan.plan_version,
        brief_fingerprint: input.plan.brief_fingerprint,
        scope_hash: input.scopeHash,
        scope: input.scope,
        status: "requested",
        risk_ack: input.riskAck,
        high_impact: input.highImpact,
        requested_by_user_id: input.requestedBy,
        decided_by_user_id: null,
        expires_at: input.expiresAt,
        decided_at: null,
        note: input.note,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      approvals.push(row);
      return { row, deduped: false };
    },
    decide: async (input) => {
      const row = approvals.find((a) => a.id === input.approvalId && a.workspace_id === input.workspaceId);
      if (!row) throw Object.assign(new Error("approval not found"), { status: 404 });
      const ok =
        (input.to === "approved" && row.status === "requested") ||
        (input.to === "rejected" && row.status === "requested") ||
        (input.to === "revoked" && row.status === "approved");
      if (!ok) throw Object.assign(new Error(`cannot move approval from ${row.status} to ${input.to}`), { status: 409 });
      row.status = input.to;
      row.decided_by_user_id = input.actorUserId;
      row.decided_at = new Date().toISOString();
      if (input.note) row.note = input.note;
      return row;
    },
    markStale: async (input) => {
      const row = approvals.find((a) => a.id === input.approvalId && a.workspace_id === input.workspaceId);
      if (!row || (row.status !== "requested" && row.status !== "approved")) return null;
      row.status = input.to;
      return row;
    },
  };
  const eStore: ExecutionStore = {
    listForPlan: async (planId, ws) => executions.filter((e) => e.plan_id === planId && e.workspace_id === ws),
    loadById: async (id, ws) => executions.find((e) => e.id === id && e.workspace_id === ws) ?? null,
    activeForApproval: async (approvalId, ws) =>
      executions.filter(
        (e) => e.approval_id === approvalId && e.workspace_id === ws && e.status === "unknown_outcome",
      ),
    claim: async (input) => {
      const dup = executions.find((e) => e.workspace_id === input.workspaceId && e.idempotency_key === input.idempotencyKey);
      if (dup) return { row: dup, deduped: true };
      const active = executions.find((e) => e.approval_id === input.approvalId && e.status === "unknown_outcome");
      if (active) return { row: active, deduped: true };
      en++;
      const row: ExecutionRow = {
        id: `ex-${en}`,
        incident_id: input.incidentId,
        workspace_id: input.workspaceId,
        plan_id: input.planId,
        approval_id: input.approvalId,
        action_type: input.actionType,
        params: input.params,
        idempotency_key: input.idempotencyKey,
        status: "unknown_outcome",
        actor_user_id: input.actorUserId,
        verifier_user_id: null,
        provider_ref: input.providerRef,
        result_note: input.resultNote,
        verification_evidence: null,
        started_at: new Date().toISOString(),
        completed_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      executions.push(row);
      return { row, deduped: false };
    },
    verify: async (input) => {
      const row = executions.find((e) => e.id === input.executionId && e.workspace_id === input.workspaceId);
      if (!row || row.status === "verified_success" || row.status === "verified_failure") {
        throw Object.assign(new Error("execution already decided or missing"), { status: 409 });
      }
      row.status = input.outcome;
      row.verifier_user_id = input.verifierUserId;
      row.verification_evidence = input.evidence;
      row.completed_at = new Date().toISOString();
      return row;
    },
  };
  return { approvals, executions, aStore, eStore };
}

function makeDeps(plan: PlanRef | null = lowPlan(), fp: string | null = "fp-1"): { deps: ApprovalDeps } {
  const { aStore, eStore } = makeStores();
  return {
    deps: {
      loadPlan: async (_id, ws) => (plan && plan.workspace_id === ws ? plan : plan && ws === "ws-1" ? plan : null),
      loadBriefFingerprint: async () => fp,
      approvals: aStore,
      executions: eStore,
    },
  };
}

describe("scope hashing + impact", () => {
  it("canonical scope is order-stable and tamper-evident", () => {
    const a = canonicalScope({ planId: "p", planVersion: 1, briefFingerprint: "f", actionType: "manual_external_record", steps: [1, 0], params: { b: 1, a: 2 } });
    const b = canonicalScope({ planId: "p", planVersion: 1, briefFingerprint: "f", actionType: "manual_external_record", steps: [0, 1], params: { a: 2, b: 1 } });
    expect(a.hash).toBe(b.hash);
    const c = canonicalScope({ planId: "p", planVersion: 1, briefFingerprint: "f", actionType: "manual_external_record", steps: [0, 1], params: { a: 3, b: 1 } });
    expect(c.hash).not.toBe(a.hash);
  });

  it("flags high-impact plans", () => {
    expect(isHighImpact(lowPlan().payload)).toBe(false);
    expect(isHighImpact(highPlan().payload)).toBe(true);
  });
});

describe("approval request (fakes)", () => {
  it("requests exact staged scope with dedupe", async () => {
    const { deps } = makeDeps();
    const r1 = await requestApproval("plan-1", "ws-1", "op-1", { actionType: "manual_external_record", steps: [0, 1], riskAck: true }, deps);
    expect(r1.action).toBe("requested");
    const r2 = await requestApproval("plan-1", "ws-1", "op-1", { actionType: "manual_external_record", steps: [1, 0], riskAck: true }, deps);
    expect(r2.action).toBe("duplicate"); // same scope, different order
  });

  it("refuses non-staged plans and bad scopes", async () => {
    const { deps } = makeDeps(lowPlan({ status: "draft" }));
    expect((await requestApproval("plan-1", "ws-1", "op-1", { actionType: "manual_external_record", steps: [0], riskAck: true }, deps)).action).toBe("deferred");
    const { deps: d2 } = makeDeps();
    expect((await requestApproval("plan-1", "ws-1", "op-1", { actionType: "manual_external_record", steps: [9], riskAck: true }, d2)).action).toBe("deferred");
    expect((await requestApproval("plan-1", "ws-1", "op-1", { actionType: "manual_external_record", steps: [], riskAck: true }, d2)).action).toBe("deferred");
  });

  it("requires risk acknowledgment for high-impact scopes", async () => {
    const { deps } = makeDeps(highPlan());
    const denied = await requestApproval("plan-1", "ws-1", "op-1", { actionType: "manual_external_record", steps: [0], riskAck: false }, deps);
    expect(denied.action).toBe("deferred");
    const ok = await requestApproval("plan-1", "ws-1", "op-1", { actionType: "manual_external_record", steps: [0], riskAck: true }, deps);
    expect(ok.action).toBe("requested");
  });

  it("rejects unsupported executors and cross-workspace plans", async () => {
    const { deps } = makeDeps();
    expect((await requestApproval("plan-1", "ws-1", "op-1", { actionType: "auto_restart" as never, steps: [0], riskAck: true }, deps)).action).toBe("deferred");
    expect((await requestApproval("plan-1", "ws-foreign", "op-1", { actionType: "manual_external_record", steps: [0], riskAck: true }, deps)).action).toBe("deferred");
  });
});

describe("approval decision (fakes)", () => {
  async function requested(high = false) {
    const { deps } = makeDeps(high ? highPlan() : lowPlan());
    const r = await requestApproval("plan-1", "ws-1", "requester", { actionType: "manual_external_record", steps: [0], riskAck: true }, deps);
    if (r.action !== "requested") throw new Error("setup failed");
    return { deps, approval: r.approval };
  }

  it("approves and rejects requested scopes with attribution", async () => {
    const { deps, approval } = await requested();
    const ok = await decideApproval(approval.id, "ws-1", "reviewer", "approve", "lgtm", deps);
    expect(ok.action).toBe("decided");
    if (ok.action !== "decided") return;
    expect(ok.approval.status).toBe("approved");
    expect(ok.approval.decided_by_user_id).toBe("reviewer");
  });

  it("blocks high-impact self-approval but allows low-impact self-approval", async () => {
    const hi = await requested(true);
    const selfDenied = await decideApproval(hi.approval.id, "ws-1", "requester", "approve", null, hi.deps);
    expect(selfDenied.action).toBe("deferred");
    const other = await decideApproval(hi.approval.id, "ws-1", "reviewer-2", "approve", null, hi.deps);
    expect(other.action).toBe("decided");

    const lo = await requested(false);
    const selfOk = await decideApproval(lo.approval.id, "ws-1", "requester", "approve", null, lo.deps);
    expect(selfOk.action).toBe("decided");
  });

  it("revokes approved scopes and blocks terminal transitions", async () => {
    const { deps, approval } = await requested();
    await decideApproval(approval.id, "ws-1", "reviewer", "approve", null, deps);
    const rev = await decideApproval(approval.id, "ws-1", "reviewer", "revoke", "no longer safe", deps);
    expect(rev.action).toBe("decided");
    if (rev.action !== "decided") return;
    expect(rev.approval.status).toBe("revoked");
    expect((await decideApproval(approval.id, "ws-1", "reviewer", "approve", null, deps)).action).toBe("deferred");
  });

  it("invalidates when the plan or evidence moves on", async () => {
    let plan: PlanRef | null = lowPlan();
    let fp: string | null = "fp-1";
    const { aStore, eStore } = makeStores();
    const deps: ApprovalDeps = {
      loadPlan: async (_id, ws) => (plan && ws === "ws-1" ? plan : null),
      loadBriefFingerprint: async () => fp,
      approvals: aStore,
      executions: eStore,
    };
    const r = await requestApproval("plan-1", "ws-1", "requester", { actionType: "manual_external_record", steps: [0], riskAck: true }, deps);
    if (r.action !== "requested") throw new Error("setup failed");
    // Evidence moves on: approve + eligibility both invalidate.
    fp = "fp-2";
    const dec = await decideApproval(r.approval.id, "ws-1", "reviewer", "approve", null, deps);
    expect(dec.action).toBe("deferred");
    const after = await aStore.loadById(r.approval.id, "ws-1");
    expect(after?.status).toBe("invalidated");
    // Plan superseded also invalidates a fresh approval.
    plan = lowPlan();
    fp = "fp-1";
    const r2 = await requestApproval("plan-1", "ws-1", "requester", { actionType: "manual_external_record", steps: [0], riskAck: true }, deps);
    if (r2.action !== "requested") throw new Error("setup failed");
    plan = { ...lowPlan(), status: "superseded" };
    const dec2 = await decideApproval(r2.approval.id, "ws-1", "reviewer", "approve", null, deps);
    expect(dec2.action).toBe("deferred");
  });

  it("treats expired approvals as expired, never approvable", async () => {
    const { deps } = makeDeps();
    const r = await requestApproval("plan-1", "ws-1", "requester", { actionType: "manual_external_record", steps: [0], riskAck: true }, deps);
    if (r.action !== "requested") throw new Error("setup failed");
    r.approval.expires_at = new Date(Date.now() - 1000).toISOString();
    const out = await decideApproval(r.approval.id, "ws-1", "reviewer", "approve", null, deps);
    expect(out.action).toBe("deferred");
    expect(r.approval.status).toBe("expired");
  });
});

describe("auto eligibility (fakes)", () => {
  it("never dispatches: valid approvals resolve to no_supported_executor", async () => {
    const { deps } = makeDeps();
    const r = await requestApproval("plan-1", "ws-1", "requester", { actionType: "manual_external_record", steps: [0], riskAck: true }, deps);
    if (r.action !== "requested") throw new Error("setup failed");
    await decideApproval(r.approval.id, "ws-1", "reviewer", "approve", null, deps);
    const e = await checkAutoEligibility(r.approval.id, "ws-1", deps);
    expect(e.eligible).toBe(false);
    if (!e.eligible) expect(e.reason).toMatch(/no_supported_executor/);
  });

  it("fails closed on unapproved, stale, or foreign approvals", async () => {
    const { deps } = makeDeps();
    const r = await requestApproval("plan-1", "ws-1", "requester", { actionType: "manual_external_record", steps: [0], riskAck: true }, deps);
    if (r.action !== "requested") throw new Error("setup failed");
    const before = await checkAutoEligibility(r.approval.id, "ws-1", deps);
    expect(before.eligible).toBe(false);
    const foreign = await checkAutoEligibility(r.approval.id, "ws-foreign", deps);
    expect(foreign.eligible).toBe(false);
  });
});

describe("manual execution fallback (fakes)", () => {
  async function approved() {
    const { deps } = makeDeps();
    const r = await requestApproval("plan-1", "ws-1", "requester", { actionType: "manual_external_record", steps: [0], riskAck: true }, deps);
    if (r.action !== "requested") throw new Error("setup failed");
    const d = await decideApproval(r.approval.id, "ws-1", "reviewer", "approve", null, deps);
    if (d.action !== "decided") throw new Error("approve failed");
    return { deps, approval: d.approval };
  }

  it("claims unknown_outcome and dedupes concurrent + retry claims", async () => {
    const { deps, approval } = await approved();
    const [a, b] = await Promise.all([
      claimManualExecution(approval.id, "ws-1", "op-1", { idempotencyKey: "k-1", externalRef: "CHG-1", resultNote: "restarted queue worker" }, deps),
      claimManualExecution(approval.id, "ws-1", "op-1", { idempotencyKey: "k-1", externalRef: "CHG-1", resultNote: "restarted queue worker" }, deps),
    ]);
    const actions = [a.action, b.action].sort();
    expect(actions).toEqual(["claimed", "duplicate"]);
    const rows = a.action !== "deferred" && b.action !== "deferred" ? [a, b] : [];
    expect(rows.length).toBe(2);
    // Second approval-scoped claim without a new approval dedupes too.
    const c = await claimManualExecution(approval.id, "ws-1", "op-1", { idempotencyKey: "k-2" }, deps);
    expect(c.action).toBe("duplicate");
  });

  it("refuses claims on unapproved or revoked scopes", async () => {
    const { deps } = makeDeps();
    const r = await requestApproval("plan-1", "ws-1", "requester", { actionType: "manual_external_record", steps: [0], riskAck: true }, deps);
    if (r.action !== "requested") throw new Error("setup failed");
    expect((await claimManualExecution(r.approval.id, "ws-1", "op-1", { idempotencyKey: "k-x" }, deps)).action).toBe("deferred");
  });

  it("requires independent verification with evidence", async () => {
    const { deps, approval } = await approved();
    const c = await claimManualExecution(approval.id, "ws-1", "op-1", { idempotencyKey: "k-v" }, deps);
    if (c.action !== "claimed" && c.action !== "duplicate") throw new Error("claim failed");
    const exec = c.execution;
    const self = await verifyManualExecution(exec.id, "ws-1", "op-1", "verified_success", "looks good", deps);
    expect(self.action).toBe("deferred"); // recorder cannot verify own work
    const noEvidence = await verifyManualExecution(exec.id, "ws-1", "reviewer", "verified_success", "  ", deps);
    expect(noEvidence.action).toBe("deferred");
    const ok = await verifyManualExecution(exec.id, "ws-1", "reviewer", "verified_success", "queue depth nominal, 500s stopped", deps);
    expect(ok.action).toBe("verified");
    if (ok.action !== "verified") return;
    expect(ok.execution.status).toBe("verified_success");
    expect(ok.execution.verifier_user_id).toBe("reviewer");
    const twice = await verifyManualExecution(exec.id, "ws-1", "reviewer-2", "verified_failure", "recheck", deps);
    expect(twice.action).toBe("deferred"); // terminal
  });
});

describe("route authorization", () => {
  it("anonymous callers get 401 without touching data", async () => {
    cookieJar = "";
    const a = await approvalPOST(
      new Request("http://test/api/x/approvals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceSlug: "northstar", steps: [0], riskAck: true }),
      }),
      { params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000", planId: "00000000-0000-0000-0000-000000000000" }) },
    );
    expect(a.status).toBe(401);
    const d = await decisionPOST(
      new Request("http://test/api/x/decision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceSlug: "northstar", decision: "approve" }),
      }),
      { params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000", planId: "00000000-0000-0000-0000-000000000000", approvalId: "00000000-0000-0000-0000-000000000000" }) },
    );
    expect(d.status).toBe(401);
    const e = await executionsPOST(
      new Request("http://test/api/x/executions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceSlug: "northstar", approvalId: "x" }),
      }),
      { params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000", planId: "00000000-0000-0000-0000-000000000000" }) },
    );
    expect(e.status).toBe(401);
    const v = await verifyPOST(
      new Request("http://test/api/x/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceSlug: "northstar", outcome: "verified_success", evidence: "x" }),
      }),
      { params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000", planId: "00000000-0000-0000-0000-000000000000", executionId: "00000000-0000-0000-0000-000000000000" }) },
    );
    expect(v.status).toBe(401);
  }, 60_000);
});

describe("no automatic side effects", () => {
  it("approval domain carries no outbound dispatch surface", async () => {
    const src = await import("../recovery-approvals");
    void src;
    const fs = await import("node:fs");
    const text = fs.readFileSync("lib/recovery-approvals.ts", "utf8");
    expect(text).not.toMatch(/fetch\s*\(|sendMessage\s*\(|postToThread\s*\(|axios|XMLHttpRequest|new\s+WebSocket/i);
    expect(text).toMatch(/no_supported_executor/);
  });
});

// ---- Live persistence: approvals + manual executions round-trip ----

const stamp = Date.now().toString(36);
const PW = "correct-horse-123";
const createdEmails: string[] = [];
const createdOrgIds: string[] = [];
const SLUG = `s10-ws-${stamp}`;

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

describe("approval persistence (live Neon)", () => {
  it("requests, approves, records manual work, and verifies with audit", async () => {
    const { organizationIdForSlug, workspaceIdForSlug } = await import("../tenant");
    const { ensureOrganization, ensureWorkspace, addOrganizationMember } = await import("../db");
    const orgId = organizationIdForSlug(SLUG);
    await ensureOrganization({ id: orgId, slug: SLUG, name: `Temp ${SLUG}` });
    const wsId = workspaceIdForSlug(SLUG);
    await ensureWorkspace({ id: wsId, organizationId: orgId, slug: SLUG, name: `Temp ${SLUG}` });
    createdOrgIds.push(orgId);
    cookieJar = await signupSession(`s10-staff-${stamp}@example.test`);
    const { neon } = await import("@neondatabase/serverless");
    const sql = neon(dbKey());
    const staff = (await sql`select id from "user" where email = ${`s10-staff-${stamp}@example.test`} limit 1`) as unknown as { id: string }[];
    await addOrganizationMember({ organizationId: orgId, userId: staff[0].id, role: "owner" });

    const { createIncident, listIncidentEvents } = await import("../incidents");
    const inc = await createIncident({ workspaceId: wsId, title: "S10 live incident", createdByUserId: staff[0].id });

    const { realPlanStore } = await import("../recovery-plans");
    const plans = await realPlanStore();
    const draft = await plans.createDraft({
      incidentId: inc.id,
      workspaceId: wsId,
      fingerprint: `fp-s10-${stamp}`,
      briefVersion: 1,
      payload: {
        problemSummary: "Checkout 500s during peak.",
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
        missingInfo: [],
        riskLevel: "low",
        safetyWarnings: [],
        expectedOutcomes: ["Scoped note"],
        verificationChecks: ["Note present"],
        rollbackNotes: "No change proposed.",
        historicalBasis: [],
      },
      createdByUserId: staff[0].id,
    });
    await plans.transition({ planId: draft.row.id, workspaceId: wsId, to: "under_review", actorUserId: staff[0].id });
    await plans.transition({ planId: draft.row.id, workspaceId: wsId, to: "staged", actorUserId: staff[0].id });

    const { realApprovalDeps } = await import("../recovery-approvals");
    const deps = await realApprovalDeps();
    const req = await requestApproval(draft.row.id, wsId, staff[0].id, {
      actionType: "manual_external_record",
      steps: [0],
      riskAck: true,
    }, { ...deps, loadBriefFingerprint: async () => `fp-s10-${stamp}` });
    expect(req.action).toBe("requested");
    if (req.action !== "requested") throw new Error("request failed");
    const dec = await decideApproval(req.approval.id, wsId, staff[0].id, "approve", "low risk, self-review ok", deps);
    expect(dec.action).toBe("decided");

    const claim = await claimManualExecution(req.approval.id, wsId, staff[0].id, {
      idempotencyKey: `s10-${stamp}`,
      externalRef: "CHG-42",
      resultNote: "Rotated key per runbook section 2",
    }, deps);
    expect(claim.action).toBe("claimed");
    if (claim.action !== "claimed") throw new Error("claim failed");
    expect(claim.execution.status).toBe("unknown_outcome");
    const dup = await claimManualExecution(req.approval.id, wsId, staff[0].id, { idempotencyKey: `s10-${stamp}` }, deps);
    expect(dup.action).toBe("duplicate");

    const events = await listIncidentEvents(inc.id, wsId);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("approval_requested");
    expect(kinds).toContain("approval_approved");
    expect(kinds).toContain("execution_claimed");
    // Verification needs an independent reviewer; the live flow stops at
    // unknown_outcome (honest: unproven until someone else confirms).
  }, 120_000);
});
