import { describe, expect, it, afterAll, vi } from "vitest";
import {
  classifyMessage,
  confirmResolution,
  evaluateWatch,
  extractSymptomTerms,
  markWatch,
  noteNewMessage,
  recordObservation,
  startWatch,
  validateWatchJudge,
  type BaselinePlan,
  type ObservationStore,
  type WatchDeps,
  type WatchObservation,
  type WatchRow,
  type WatchStore,
} from "../resolution-watch";
import { POST as watchesPOST } from "@/app/api/incidents/[id]/watches/route";
import { POST as refreshPOST } from "@/app/api/incidents/[id]/watches/[watchId]/refresh/route";
import { POST as observePOST } from "@/app/api/incidents/[id]/watches/[watchId]/observe/route";
import { POST as confirmPOST } from "@/app/api/incidents/[id]/watches/[watchId]/confirm/route";
import { POST as markPOST } from "@/app/api/incidents/[id]/watches/[watchId]/mark/route";

let cookieJar = "";
vi.mock("next/headers", () => ({
  headers: async () => new Headers(cookieJar ? { cookie: cookieJar } : {}),
}));

function plan(over: Partial<BaselinePlan> = {}): BaselinePlan {
  return {
    id: "plan-1",
    incident_id: "inc-1",
    workspace_id: "ws-1",
    plan_version: 1,
    status: "staged",
    brief_fingerprint: "fp-1",
    problem_summary: "Visa checkout returns HTTP 500 on pay",
    baseline_observations: ["Visa checkout returns HTTP 500 on pay", "Same 500 on Visa checkout"],
    ...over,
  };
}

function makeStores() {
  const watches: WatchRow[] = [];
  const obs: WatchObservation[] = [];
  let wn = 0;
  let on = 0;
  const wStore: WatchStore = {
    activeForIncident: async (iid, ws) => watches.filter((w) => w.incident_id === iid && w.workspace_id === ws && w.status !== "resolution_confirmed"),
    listForIncident: async (iid, ws) => watches.filter((w) => w.incident_id === iid && w.workspace_id === ws),
    loadById: async (id, ws) => watches.find((w) => w.id === id && w.workspace_id === ws) ?? null,
    insert: async (input) => {
      const dup = watches.find((w) => w.incident_id === input.incidentId && w.workspace_id === input.workspaceId && w.status !== "resolution_confirmed");
      if (dup) return { row: dup, deduped: true };
      wn++;
      const row: WatchRow = {
        id: `w-${wn}`,
        incident_id: input.incidentId,
        workspace_id: input.workspaceId,
        plan_id: input.planId,
        approval_id: input.approvalId,
        execution_id: input.executionId,
        baseline_fingerprint: input.baselineFingerprint,
        baseline_summary: input.baselineSummary,
        baseline_symptoms: input.baselineSymptoms,
        status: "awaiting_evidence",
        last_observation_at: null,
        last_evaluation_at: null,
        confirmed_by_user_id: null,
        confirmed_at: null,
        note: input.note,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      watches.push(row);
      return { row, deduped: false };
    },
    setStatus: async (input) => {
      const row = watches.find((w) => w.id === input.watchId && w.workspace_id === input.workspaceId);
      if (!row || row.status === "resolution_confirmed") throw Object.assign(new Error("terminal"), { status: 409 });
      row.status = input.to;
      if (input.to === "resolution_confirmed") {
        row.confirmed_by_user_id = input.actorUserId;
        row.confirmed_at = new Date().toISOString();
      }
      return row;
    },
    touchEvaluation: async (id, _ws, at) => {
      const row = watches.find((w) => w.id === id);
      if (row) row.last_evaluation_at = at;
    },
    touchObservation: async (id, _ws, at) => {
      const row = watches.find((w) => w.id === id);
      if (row) row.last_observation_at = at;
    },
  };
  const oStore: ObservationStore = {
    listForWatch: async (wid, ws) => obs.filter((o) => o.watch_id === wid && o.workspace_id === ws),
    hasMessage: async (wid, ws, mid) => obs.some((o) => o.watch_id === wid && o.workspace_id === ws && o.message_id === mid),
    insert: async (input) => {
      if (input.messageId) {
        const dup = obs.find((o) => o.watch_id === input.watchId && o.message_id === input.messageId);
        if (dup) return { row: dup, deduped: true };
      }
      on++;
      const row: WatchObservation = {
        id: `o-${on}`,
        watch_id: input.watchId,
        incident_id: input.incidentId,
        workspace_id: input.workspaceId,
        kind: input.kind,
        message_id: input.messageId,
        conversation_id: input.conversationId,
        excerpt: input.excerpt,
        created_by_user_id: input.createdBy,
        created_at: new Date().toISOString(),
      };
      obs.push(row);
      return { row, deduped: false };
    },
  };
  return { watches, obs, wStore, oStore };
}

type Cfg = {
  plan?: BaselinePlan | null;
  approval?: { id: string; status: string; plan_id: string } | null;
  execs?: { id: string; status: string }[];
  messages?: { id: string; conversation_id: string; created_at: string; excerpt: string }[];
  judge?: WatchDeps["judge"];
};

function makeDeps(cfg: Cfg = {}): { deps: WatchDeps; stores: ReturnType<typeof makeStores> } {
  const stores = makeStores();
  const deps: WatchDeps = {
    loadPlan: async (_id, ws) => (!cfg.plan || ws !== "ws-1" ? null : cfg.plan ?? plan()),
    loadApproval: async () => cfg.approval ?? null,
    loadApprovalByPlan: async (pid, ws) => {
      if (ws !== "ws-1") return null;
      return cfg.approval && cfg.approval.plan_id === pid ? cfg.approval : null;
    },
    loadExecution: async () => null,
    executionsForPlan: async () => cfg.execs ?? [{ id: "ex-1", status: "verified_success" }],
    loadBriefFingerprint: async () => "fp-1",
    listNewUserMessages: async () => cfg.messages ?? [],
    watches: stores.wStore,
    observations: stores.oStore,
    judge: cfg.judge ?? null,
  };
  if (!("plan" in cfg)) deps.loadPlan = async (_id, ws) => (ws === "ws-1" ? plan() : null);
  if (!("approval" in cfg)) {
    deps.loadApproval = async () => ({ id: "ap-1", status: "approved", plan_id: "plan-1" });
    deps.loadApprovalByPlan = async (pid, ws) => (ws === "ws-1" && pid === "plan-1" ? { id: "ap-1", status: "approved", plan_id: "plan-1" } : null);
  }
  return { deps, stores };
}

describe("activation", () => {
  it("starts a watch from an eligible verified intervention", async () => {
    const { deps } = makeDeps();
    const r = await startWatch("inc-1", "ws-1", "op-1", { planId: "plan-1" }, deps);
    expect(r.action).toBe("started");
    if (r.action !== "started") return;
    expect(r.watch.status).toBe("awaiting_evidence");
    expect(r.watch.baseline_symptoms.length).toBeGreaterThan(0);
    const d = await startWatch("inc-1", "ws-1", "op-1", { planId: "plan-1" }, deps);
    expect(d.action).toBe("duplicate");
  });

  it("anchors unknown_outcome interventions as documented-but-unverified", async () => {
    const { deps } = makeDeps({ execs: [{ id: "ex-9", status: "unknown_outcome" }] });
    const r = await startWatch("inc-1", "ws-1", "op-1", { planId: "plan-1", executionId: undefined }, deps);
    expect(r.action).toBe("started");
    if (r.action !== "started") return;
    expect(r.watch.execution_id).toBe("ex-9");
  });

  it("refuses watches with no intervention, bad plan, or no approval", async () => {
    const { deps } = makeDeps({ execs: [] });
    expect((await startWatch("inc-1", "ws-1", "op-1", { planId: "plan-1" }, deps)).action).toBe("deferred");
    const d2 = makeDeps({ plan: plan({ status: "draft" }) });
    expect((await startWatch("inc-1", "ws-1", "op-1", { planId: "plan-1" }, d2.deps)).action).toBe("deferred");
    const d3 = makeDeps({ approval: null });
    expect((await startWatch("inc-1", "ws-1", "op-1", { planId: "plan-1" }, d3.deps)).action).toBe("deferred");
    expect((await startWatch("inc-1", "ws-foreign", "op-1", { planId: "plan-1" }, deps)).action).toBe("deferred");
  });
});

describe("hot-path observation", () => {
  async function started(cfg: Cfg = {}) {
    const { deps } = makeDeps(cfg);
    const r = await startWatch("inc-1", "ws-1", "op-1", { planId: "plan-1" }, deps);
    if (r.action !== "started" && r.action !== "duplicate") throw new Error("setup failed");
    return { deps, watch: r.watch };
  }

  it("records improvement and persistence with source refs", async () => {
    const { deps, watch } = await started();
    const good = await noteNewMessage("inc-1", "ws-1", { id: "m-1", conversationId: "c-1", excerpt: "Visa checkout is fixed now, no more 500 on pay — thank you, it works!", createdAt: new Date().toISOString() }, deps);
    expect(good.action).toBe("noted");
    const obs = await deps.observations.listForWatch(watch.id, "ws-1");
    expect(obs.some((o) => o.kind === "customer_improvement" && o.message_id === "m-1")).toBe(true);
    const w1 = await deps.watches.loadById(watch.id, "ws-1");
    expect(w1?.status).toBe("improvement_indicated");

    const bad = await noteNewMessage("inc-1", "ws-1", { id: "m-2", conversationId: "c-1", excerpt: "Actually Visa checkout returns HTTP 500 on pay again, same error", createdAt: new Date().toISOString() }, deps);
    expect(bad.action).toBe("noted");
    const obs2 = await deps.observations.listForWatch(watch.id, "ws-1");
    expect(obs2.some((o) => o.kind === "regression")).toBe(true);
    const w2 = await deps.watches.loadById(watch.id, "ws-1");
    expect(w2?.status).toBe("still_affected");
  });

  it("ignores unrelated chatter and dedupes replays", async () => {
    const { deps, watch } = await started();
    await noteNewMessage("inc-1", "ws-1", { id: "m-u", conversationId: "c-1", excerpt: "What are your opening hours on Sunday?", createdAt: new Date().toISOString() }, deps);
    expect((await deps.observations.listForWatch(watch.id, "ws-1")).length).toBe(0);
    const msg = { id: "m-d", conversationId: "c-1", excerpt: "Visa checkout returns HTTP 500 on pay, still broken", createdAt: new Date().toISOString() };
    const [a, b] = await Promise.all([noteNewMessage("inc-1", "ws-1", msg, deps), noteNewMessage("inc-1", "ws-1", msg, deps)]);
    expect([a.action, b.action]).toEqual(["noted", "noted"]);
    expect((await deps.observations.listForWatch(watch.id, "ws-1")).filter((o) => o.message_id === "m-d").length).toBe(1);
  });
});

describe("reconciliation + judge validation", () => {
  it("evaluates bounded messages and keeps history across evidence drift", async () => {
    const msgs = [
      { id: "m-1", conversation_id: "c-1", created_at: new Date(Date.now() - 2000).toISOString(), excerpt: "Visa checkout returns HTTP 500 on pay again" },
    ];
    const { deps } = makeDeps({ messages: msgs });
    const r = await startWatch("inc-1", "ws-1", "op-1", { planId: "plan-1" }, deps);
    if (r.action !== "started") throw new Error("setup");
    const e = await evaluateWatch(r.watch.id, "ws-1", "op-1", deps);
    expect(e.action).toBe("evaluated");
    if (e.action !== "evaluated") return;
    expect(e.added).toBe(1);
    expect(e.state).toBe("still_affected");
  });

  it("rejects fabricated judge source IDs and survives judge failure", async () => {
    expect(validateWatchJudge({ assessments: [{ messageId: "ghost", verdict: "improvement", reason: "trust me" }] }, new Set(["m-1"]))).toBeNull();
    const ok = validateWatchJudge({ assessments: [{ messageId: "m-1", verdict: "persistence", reason: "same 500 reported" }] }, new Set(["m-1"]));
    expect(ok?.[0].verdict).toBe("persistence");

    const msgs = [{ id: "m-9", conversation_id: "c-1", created_at: new Date().toISOString(), excerpt: "Hmm not sure about the checkout page" }];
    const { deps } = makeDeps({
      messages: msgs,
      judge: async () => {
        throw new Error("model down");
      },
    });
    const r = await startWatch("inc-1", "ws-1", "op-1", { planId: "plan-1" }, deps);
    if (r.action !== "started") throw new Error("setup");
    const e = await evaluateWatch(r.watch.id, "ws-1", "op-1", deps);
    expect(e.action).toBe("evaluated"); // deterministic findings stand; retryable
  });

  it("silence is never confirmation", async () => {
    const { deps } = makeDeps({ messages: [] });
    const r = await startWatch("inc-1", "ws-1", "op-1", { planId: "plan-1" }, deps);
    if (r.action !== "started") throw new Error("setup");
    const e = await evaluateWatch(r.watch.id, "ws-1", "op-1", deps);
    expect(e.action).toBe("evaluated");
    if (e.action !== "evaluated") return;
    expect(e.added).toBe(0);
    const c = await confirmResolution(r.watch.id, "ws-1", "op-1", null, deps);
    expect(c.action).toBe("deferred");
  });
});

describe("confirmation + honesty states", () => {
  async function improved() {
    const { deps } = makeDeps({ messages: [] });
    const r = await startWatch("inc-1", "ws-1", "op-1", { planId: "plan-1" }, deps);
    if (r.action !== "started") throw new Error("setup");
    await noteNewMessage("inc-1", "ws-1", { id: "m-ok", conversationId: "c-1", excerpt: "Visa checkout is fixed now, no more 500 on pay, works great!", createdAt: new Date().toISOString() }, deps);
    return { deps, watch: r.watch };
  }

  it("confirms only with fresh improvement evidence and attribution", async () => {
    const { deps, watch } = await improved();
    const c = await confirmResolution(watch.id, "ws-1", "reviewer", "customer confirmed on call", deps);
    expect(c.action).toBe("confirmed");
    if (c.action !== "confirmed") return;
    expect(c.watch.status).toBe("resolution_confirmed");
    expect(c.watch.confirmed_by_user_id).toBe("reviewer");
    // terminal: further marks and confirms are refused, history preserved
    expect((await markWatch(watch.id, "ws-1", "op-1", "watching", null, deps)).action).toBe("deferred");
    expect((await confirmResolution(watch.id, "ws-1", "op-1", null, deps)).action).toBe("deferred");
  });

  it("refuses confirmation on contradiction or unprocessed evidence", async () => {
    const { deps, watch } = await improved();
    await noteNewMessage("inc-1", "ws-1", { id: "m-bad", conversationId: "c-1", excerpt: "Visa checkout returns HTTP 500 on pay once more", createdAt: new Date().toISOString() }, deps);
    expect((await confirmResolution(watch.id, "ws-1", "op-1", null, deps)).action).toBe("deferred");

    const d2 = makeDeps({ messages: [{ id: "m-new", conversation_id: "c-1", created_at: new Date().toISOString(), excerpt: "something new happened" }] });
    const r2 = await startWatch("inc-1", "ws-1", "op-1", { planId: "plan-1" }, d2.deps);
    if (r2.action !== "started") throw new Error("setup");
    await noteNewMessage("inc-1", "ws-1", { id: "m-ok2", conversationId: "c-1", excerpt: "Visa pay fixed now, no more 500!", createdAt: new Date().toISOString() }, d2.deps);
    // unprocessed m-new arrived after evaluation region → refresh first
    const c2 = await confirmResolution(r2.watch.id, "ws-1", "op-1", null, d2.deps);
    expect(c2.action).toBe("deferred");
  });

  it("supports operator honesty states and scoped isolation", async () => {
    const { deps } = makeDeps();
    const r = await startWatch("inc-1", "ws-1", "op-1", { planId: "plan-1" }, deps);
    if (r.action !== "started") throw new Error("setup");
    expect((await markWatch(r.watch.id, "ws-1", "op-1", "insufficient_evidence", "waiting on customer", deps)).action).toBe("marked");
    expect((await markWatch(r.watch.id, "ws-foreign", "op-1", "watching", null, deps)).action).toBe("deferred");
    const o = await recordObservation(r.watch.id, "ws-1", "op-1", { kind: "operator_note", text: "Called customer, line dropped" }, deps);
    expect(o.action).toBe("recorded");
    expect((await recordObservation(r.watch.id, "ws-1", "op-1", { kind: "operator_note", text: "  " }, deps)).action).toBe("deferred");
  });
});

describe("classifier", () => {
  it("extracts stable symptom terms and classifies politeness honestly", async () => {
    const terms = extractSymptomTerms(["Visa checkout returns HTTP 500 on pay", "Visa checkout 500"]);
    expect(terms).toContain("visa");
    expect(terms).toContain("checkout");
    const { verdict } = classifyMessage("Thanks for your help!", ["visa", "checkout", "500"]);
    expect(verdict).toBe("unrelated"); // politeness alone is not improvement
  });
});

describe("route authorization", () => {
  const ids = { id: "00000000-0000-0000-0000-000000000000", watchId: "00000000-0000-0000-0000-000000000000" };
  it("anonymous callers get 401 without touching data", async () => {
    cookieJar = "";
    const mk = (body: unknown) =>
      new Request("http://test/api/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await watchesPOST(mk({ workspaceSlug: "northstar", planId: "p" }), { params: Promise.resolve({ id: ids.id }) })).status).toBe(401);
    const p = { params: Promise.resolve(ids) };
    expect((await refreshPOST(mk({ workspaceSlug: "northstar" }), p)).status).toBe(401);
    expect((await observePOST(mk({ workspaceSlug: "northstar", kind: "operator_note", text: "x" }), p)).status).toBe(401);
    expect((await confirmPOST(mk({ workspaceSlug: "northstar" }), p)).status).toBe(401);
    expect((await markPOST(mk({ workspaceSlug: "northstar", to: "watching" }), p)).status).toBe(401);
  }, 60_000);
});

describe("no automatic side effects", () => {
  it("watch domain carries no execution or closure surface", async () => {
    const fs = await import("node:fs");
    const lib = fs.readFileSync("lib/resolution-watch.ts", "utf8");
    expect(lib).not.toMatch(/transitionIncident\s*\(|updateIncidentFields\s*\(|fetch\s*\(|sendMessage\s*\(|postToThread\s*\(/);
    expect(lib).toMatch(/never executes/);
    const store = fs.readFileSync("lib/resolution-watch-store.ts", "utf8");
    expect(store).not.toMatch(/transitionIncident\s*\(/);
    const chat = fs.readFileSync("app/api/chat/route.ts", "utf8");
    expect(chat).toMatch(/noteNewMessage/);
  });
});

// ---- Live persistence: watch lifecycle round-trip with audit ----

const stamp = Date.now().toString(36);
const PW = "correct-horse-123";
const createdEmails: string[] = [];
const createdOrgIds: string[] = [];
const SLUG = `s11-ws-${stamp}`;

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

function livePayload() {
  return {
    problemSummary: "Visa checkout reports HTTP 500 on pay.",
    approach: "Verify scope, then pursue the retry lead with approval.",
    steps: [
      {
        description: "Confirm scope from linked reports",
        purpose: "Bound the affected actions",
        kind: "diagnostic" as const,
        evidenceRefs: ["m1"],
        matchRefs: [] as string[],
        prerequisites: [] as string[],
        expectedResult: "Scoped note",
        risk: "low" as const,
        humanRequired: false,
        verification: "Note recorded",
      },
    ],
    prerequisites: [] as string[],
    missingInfo: [] as string[],
    riskLevel: "low" as const,
    safetyWarnings: [] as string[],
    expectedOutcomes: ["Scoped note"],
    verificationChecks: ["Note present"],
    rollbackNotes: "No change proposed.",
    historicalBasis: [],
  };
}

describe("watch persistence (live Neon)", () => {
  it("starts, observes, evaluates, and marks with audit", async () => {
    const { organizationIdForSlug, workspaceIdForSlug } = await import("../tenant");
    const { ensureOrganization, ensureWorkspace, addOrganizationMember } = await import("../db");
    const orgId = organizationIdForSlug(SLUG);
    await ensureOrganization({ id: orgId, slug: SLUG, name: `Temp ${SLUG}` });
    const wsId = workspaceIdForSlug(SLUG);
    await ensureWorkspace({ id: wsId, organizationId: orgId, slug: SLUG, name: `Temp ${SLUG}` });
    createdOrgIds.push(orgId);
    cookieJar = await signupSession(`s11-staff-${stamp}@example.test`);
    const { neon } = await import("@neondatabase/serverless");
    const sql = neon(dbKey());
    const staff = (await sql`select id from "user" where email = ${`s11-staff-${stamp}@example.test`} limit 1`) as unknown as { id: string }[];
    await addOrganizationMember({ organizationId: orgId, userId: staff[0].id, role: "owner" });

    const { createIncident, listIncidentEvents } = await import("../incidents");
    const inc = await createIncident({ workspaceId: wsId, title: "S11 live incident", createdByUserId: staff[0].id });

    const { realPlanStore } = await import("../recovery-plans");
    const plans = await realPlanStore();
    const draft = await plans.createDraft({ incidentId: inc.id, workspaceId: wsId, fingerprint: `fp-s11-${stamp}`, briefVersion: 1, payload: livePayload(), createdByUserId: staff[0].id });
    await plans.transition({ planId: draft.row.id, workspaceId: wsId, to: "under_review", actorUserId: staff[0].id });
    await plans.transition({ planId: draft.row.id, workspaceId: wsId, to: "staged", actorUserId: staff[0].id });

    const { realApprovalDeps } = await import("../recovery-approvals");
    const adeps = await realApprovalDeps();
    const req = await (await import("../recovery-approvals")).requestApproval(draft.row.id, wsId, staff[0].id, { actionType: "manual_external_record", steps: [0], riskAck: true }, { ...adeps, loadBriefFingerprint: async () => `fp-s11-${stamp}` });
    if (req.action !== "requested") throw new Error("approval setup failed");
    const dec = await (await import("../recovery-approvals")).decideApproval(req.approval.id, wsId, staff[0].id, "approve", "low risk", { ...adeps, loadBriefFingerprint: async () => `fp-s11-${stamp}` });
    expect(dec.action).toBe("decided");
    const claim = await (await import("../recovery-approvals")).claimManualExecution(req.approval.id, wsId, staff[0].id, { idempotencyKey: `s11-${stamp}`, resultNote: "Rotated key per runbook" }, adeps);
    if (claim.action !== "claimed" && claim.action !== "duplicate") throw new Error("claim setup failed");

    const { realWatchDeps } = await import("../resolution-watch-store");
    const deps = await realWatchDeps({ judge: false });
    const started = await (await import("../resolution-watch")).startWatch(inc.id, wsId, staff[0].id, { planId: draft.row.id }, deps);
    expect(started.action).toBe("started");
    if (started.action !== "started") throw new Error("watch start failed");
    const dup = await (await import("../resolution-watch")).startWatch(inc.id, wsId, staff[0].id, { planId: draft.row.id }, deps);
    expect(dup.action).toBe("duplicate");

    const noted = await (await import("../resolution-watch")).recordObservation(started.watch.id, wsId, staff[0].id, { kind: "operator_note", text: "Customer called: checking out fine on mobile" }, deps);
    expect(noted.action).toBe("recorded");
    const evaled = await (await import("../resolution-watch")).evaluateWatch(started.watch.id, wsId, staff[0].id, deps);
    expect(evaled.action).toBe("evaluated");
    const marked = await (await import("../resolution-watch")).markWatch(started.watch.id, wsId, staff[0].id, "insufficient_evidence", "single anecdote", deps);
    expect(marked.action).toBe("marked");

    const events = await listIncidentEvents(inc.id, wsId);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("watch_started");
    expect(kinds).toContain("watch_observed");
    expect(kinds).toContain("watch_updated");
  }, 120_000);
});
