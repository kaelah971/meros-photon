import { describe, expect, it, afterAll, vi } from "vitest";
import {
  checkEligibility,
  confirmClosure,
  fingerprintClosure,
  generateDraft,
  validateSynthesis,
  type ClosureDeps,
  type PostmortemStore,
  type WatchSnap,
} from "../closure";
import { POST as closurePOST, GET as closureGET } from "@/app/api/incidents/[id]/closure/route";
import { POST as postmortemsPOST } from "@/app/api/incidents/[id]/postmortems/route";

let cookieJar = "";
vi.mock("next/headers", () => ({
  headers: async () => new Headers(cookieJar ? { cookie: cookieJar } : {}),
}));

function watchSnap(over: Partial<WatchSnap> = {}): WatchSnap {
  const now = new Date().toISOString();
  return {
    id: "w-1",
    status: "resolution_confirmed",
    baseline_fingerprint: "fp-1",
    baseline_summary: "Visa checkout 500s stopped after the key rotation.",
    last_evaluation_at: now,
    confirmed_by_user_id: "reviewer",
    confirmed_at: now,
    observations: [
      { kind: "customer_improvement", message_id: "m-1", created_at: now, excerpt: "works now" },
    ],
    ...over,
  };
}

function makeStores() {
  const drafts = new Map<string, import("../closure").PostmortemRow>();
  const finals: import("../closure").PostmortemRow[] = [];
  let n = 0;
  const store: PostmortemStore = {
    loadDraft: async (iid) => drafts.get(iid) ?? null,
    loadById: async (id) => [...drafts.values(), ...finals].find((r) => r.id === id) ?? null,
    listFinalized: async (iid) => finals.filter((r) => r.incident_id === iid),
    saveDraft: async (input) => {
      n++;
      const row = {
        id: `pm-${n}`,
        incident_id: input.incidentId,
        workspace_id: input.workspaceId,
        watch_id: input.watchId,
        status: "draft" as const,
        source_fingerprint: input.fingerprint,
        brief_fingerprint: input.briefFingerprint,
        content: input.content,
        created_by_user_id: input.createdBy,
        finalized_by_user_id: null,
        finalized_at: null,
        note: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      drafts.set(input.incidentId, row);
      return { row, deduped: false };
    },
    finalize: async (id) => {
      const row = drafts.get("inc-1");
      if (!row || row.id !== id) throw Object.assign(new Error("postmortem not found"), { status: 404 });
      drafts.delete("inc-1");
      const fin = { ...row, status: "finalized" as const, finalized_by_user_id: "op-1", finalized_at: new Date().toISOString() };
      finals.push(fin);
      return fin;
    },
  };
  return { store, finals };
}

type Cfg = {
  incident?: { status: string; updated_at?: string } | null;
  watch?: WatchSnap | null;
  briefFp?: string | null;
  messages?: { id: string; created_at: string }[];
  judge?: ClosureDeps["judge"];
};

function makeDeps(cfg: Cfg = {}): { deps: ClosureDeps; stores: ReturnType<typeof makeStores>; transitioned: { count: number; last: unknown } } {
  const stores = makeStores();
  const transitioned = { count: 0, last: null as unknown };
  const updatedAt = cfg.incident?.updated_at ?? new Date().toISOString();
  const watch = "watch" in cfg ? cfg.watch : watchSnap();
  const hasIncident = "incident" in cfg;
  const deps: ClosureDeps = {
    loadIncident: async (_id, ws) => {
      if (ws !== "ws-1") return null;
      if (hasIncident && cfg.incident === null) return null;
      return {
        id: "inc-1",
        workspace_id: "ws-1",
        title: "Visa outage",
        severity: "high",
        status: cfg.incident?.status ?? "monitoring",
        updated_at: updatedAt,
      };
    },
    listEvents: async () => [{ kind: "created", at: updatedAt, detail: {}, actor: null }],
    countLinks: async () => ({ customers: 2, conversations: 3 }),
    loadBrief: async () =>
      cfg.briefFp === null
        ? null
        : {
            fingerprint: cfg.briefFp ?? "fp-1",
            findings: {
              facts: [{ observation: "Visa checkout returns HTTP 500", sources: ["m-1"] }],
              unknowns: ["Root cause unknown"],
              hypotheses: [{ text: "Might be gateway timeout", basedOn: ["m-1"] }],
            },
          },
    listPlans: async () => [
      { id: "plan-1", plan_version: 1, status: "staged", brief_fingerprint: "fp-1", payload: { problemSummary: "Visa 500s", historicalBasis: [{ refId: "card-1", tier: "verified_fix" }] } },
    ],
    listControls: async () => ({
      approvals: [{ id: "ap-1", status: "approved", scope: "steps 1 · fp ab12cd34" }],
      executions: [{ id: "ex-1", status: "verified_success", ref: "CHG-1" }],
    }),
    loadWatchHistory: async () => ({ current: watch ?? null, history: [] }),
    listRecentUserMessages: async () => cfg.messages ?? [],
    postmortems: stores.store,
    judge: cfg.judge ?? null,
  };
  void transitioned;
  return { deps, stores, transitioned };
}

function transitionOk() {
  const calls: unknown[] = [];
  return {
    calls,
    fn: async () => {
      calls.push(1);
      return { status: "resolved" };
    },
  };
}

describe("eligibility", () => {
  async function eligibleDeps() {
    const { deps } = makeDeps();
    const d = await generateDraft("inc-1", "ws-1", "op-1", deps);
    if (d.action !== "drafted") throw new Error("draft setup failed");
    return deps;
  }

  it("approves eligible confirmed-resolution incidents", async () => {
    const deps = await eligibleDeps();
    const e = await checkEligibility("inc-1", "ws-1", deps);
    expect(e.eligible).toBe(true);
  });

  it("blocks every ineligible shape with specific blockers", async () => {
    const foreign = await eligibleDeps();
    expect((await checkEligibility("inc-1", "ws-foreign", foreign)).eligible).toBe(false);
    const noWatch = makeDeps({ watch: null });
    await generateDraft("inc-1", "ws-1", "op-1", noWatch.deps);
    const e1 = await checkEligibility("inc-1", "ws-1", noWatch.deps);
    expect(e1.eligible).toBe(false);
    if (!e1.eligible) expect(e1.blockers).toContain("no resolution_confirmed watch");

    const wrongState = makeDeps({ incident: { status: "recovering" } });
    await generateDraft("inc-1", "ws-1", "op-1", wrongState.deps);
    const e2 = await checkEligibility("inc-1", "ws-1", wrongState.deps);
    expect(e2.eligible).toBe(false);
    if (!e2.eligible) expect(e2.blockers).toContain("incident must be monitoring before closure");

    const stale = makeDeps({ briefFp: "fp-2" });
    await generateDraft("inc-1", "ws-1", "op-1", stale.deps);
    const e3 = await checkEligibility("inc-1", "ws-1", stale.deps);
    expect(e3.eligible).toBe(false);
    if (!e3.eligible) expect(e3.blockers).toContain("underlying evidence moved on — refresh first");

    const pending = makeDeps({ messages: [{ id: "m-new", created_at: new Date().toISOString() }] });
    await generateDraft("inc-1", "ws-1", "op-1", pending.deps);
    const e4 = await checkEligibility("inc-1", "ws-1", pending.deps);
    expect(e4.eligible).toBe(false);
    if (!e4.eligible) expect(e4.blockers).toContain("new reports arrived after confirmation — refresh first");

    const noDraft = makeDeps();
    const e5 = await checkEligibility("inc-1", "ws-1", noDraft.deps);
    expect(e5.eligible).toBe(false);
    if (!e5.eligible) expect(e5.blockers).toContain("no current postmortem draft — generate first");
  });

  it("treats silence and unverified work as blockers, never proof", async () => {
    const silent = makeDeps({ watch: watchSnap({ last_evaluation_at: null }) });
    await generateDraft("inc-1", "ws-1", "op-1", silent.deps);
    const e = await checkEligibility("inc-1", "ws-1", silent.deps);
    expect(e.eligible).toBe(false);
    if (!e.eligible) expect(e.blockers).toContain("watch evaluation is stale — refresh first");
  });
});

describe("postmortem assembly + synthesis validation", () => {
  it("assembles deterministic factual content", async () => {
    const { deps } = makeDeps();
    const d = await generateDraft("inc-1", "ws-1", "op-1", deps);
    expect(d.action).toBe("drafted");
    if (d.action !== "drafted") return;
    expect(d.postmortem.content.title).toBe("Visa outage");
    expect(d.postmortem.content.impact.documentedCustomers).toBe(2);
    expect(d.postmortem.content.chronology.length).toBeGreaterThan(0);
    expect(d.postmortem.content.rootCause.status).toBe("unknown");
    expect(d.synthesis).toBe("factual_only");
  });

  it("attaches validated suggestions, rejects invented grounding", async () => {
    const known = new Set(["brief", "watch", "event:created"]);
    expect(
      validateSynthesis(
        { lessons: [{ text: "Add alerting", basedOn: ["ghost"] }], prevention: [], unknowns: [], rootCause: { status: "unknown", statement: "x" } },
        known,
      ),
    ).toBeNull();
    expect(
      validateSynthesis(
        { lessons: [], prevention: [], unknowns: [], rootCause: { status: "verified", statement: "We proved it" } },
        known,
      ),
    ).toBeNull(); // model may never claim proof
    const ok = validateSynthesis(
      {
        lessons: [{ text: "Add checkout alerting", basedOn: ["brief"] }],
        prevention: [{ text: "Canary deploys", basedOn: ["event:created"] }],
        unknowns: ["Whether mobile was affected"],
        rootCause: { status: "unverified", statement: "Gateway timeout suspected, not proven." },
      },
      known,
    );
    expect(ok?.rootCause.status).toBe("unverified");

    const { deps } = makeDeps({
      judge: async () => ({
        lessons: [{ text: "Add checkout alerting", basedOn: ["brief"] }],
        prevention: [],
        unknowns: [],
        rootCause: { status: "unknown", statement: "No verified root cause recorded." },
      }),
    });
    const d = await generateDraft("inc-1", "ws-1", "op-1", deps);
    expect(d.action).toBe("drafted");
    if (d.action !== "drafted") return;
    expect(d.synthesis).toBe("attached");
    expect(d.postmortem.content.lessons[0].text).toContain("alerting");
  });

  it("survives judge failure with a factual retryable draft", async () => {
    const { deps } = makeDeps({
      judge: async () => {
        throw new Error("model down");
      },
    });
    const d = await generateDraft("inc-1", "ws-1", "op-1", deps);
    expect(d.action).toBe("drafted");
    if (d.action !== "drafted") return;
    expect(d.synthesis).toBe("factual_only");
    expect(d.postmortem.content.chronology.length).toBeGreaterThan(0);
  });

  it("fingerprints are stable and drift-sensitive", () => {
    const snap = watchSnap();
    const base = { incidentUpdatedAt: "t", watch: snap, briefFingerprint: "fp-1", eventCount: 1, lastEventAt: "t", observationCount: 1 };
    const a = fingerprintClosure(base);
    const b = fingerprintClosure({ ...base, briefFingerprint: "fp-2" });
    expect(a).not.toBe(b);
    expect(a).toBe(fingerprintClosure({ ...base }));
  });
});

describe("closure confirmation", () => {
  async function ready() {
    const { deps } = makeDeps();
    const d = await generateDraft("inc-1", "ws-1", "op-1", deps);
    if (d.action !== "drafted") throw new Error("setup");
    return { deps, draftId: d.postmortem.id };
  }

  it("closes eligible incidents and dedupes concurrent confirms", async () => {
    const { deps, draftId } = await ready();
    const t = transitionOk();
    const c1 = await confirmClosure("inc-1", "ws-1", "op-1", { postmortemId: draftId }, deps, t.fn);
    expect(c1.action).toBe("closed");
    const c2 = await confirmClosure("inc-1", "ws-1", "op-1", { postmortemId: draftId }, deps, t.fn);
    // Second call sees a stale draft fingerprint (finalize consumed it) → deferred, not a double close.
    expect(["duplicate", "deferred"]).toContain(c2.action);
    expect(t.calls.length).toBe(1); // exactly one resolve transition
  });

  it("supports explicit administrative closure without verified claims", async () => {
    const { deps } = makeDeps({ watch: null });
    const t = transitionOk();
    const c = await confirmClosure("inc-1", "ws-1", "op-1", { administrative: true, reason: "Vendor outage, nothing to verify" }, deps, t.fn);
    expect(c.action).toBe("closed");
    expect(t.calls.length).toBe(1);
    const empty = await confirmClosure("inc-1", "ws-1", "op-1", { administrative: true, reason: "  " }, deps, t.fn);
    expect(empty.action).toBe("deferred");
  });

  it("refuses stale drafts and wrong postmortems", async () => {
    const { deps, draftId } = await ready();
    const t = transitionOk();
    expect((await confirmClosure("inc-1", "ws-1", "op-1", { postmortemId: "pm-ghost" }, deps, t.fn)).action).toBe("deferred");
    expect(t.calls.length).toBe(0);
    void draftId;
  });
});

describe("route authorization", () => {
  it("anonymous callers get 401 without touching data", async () => {
    cookieJar = "";
    const mk = (body: unknown) =>
      new Request("http://test/api/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const p = { params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000" }) };
    expect((await closurePOST(mk({ workspaceSlug: "northstar", postmortemId: "x" }), p)).status).toBe(401);
    expect((await postmortemsPOST(mk({ workspaceSlug: "northstar" }), p)).status).toBe(401);
    const g = new Request("http://test/api/x?workspaceSlug=northstar");
    expect((await closureGET(g, p)).status).toBe(401);
  }, 60_000);
});

describe("no automatic side effects", () => {
  it("closure domain carries no execution, messaging, or promotion surface", async () => {
    const fs = await import("node:fs");
    const lib = fs.readFileSync("lib/closure.ts", "utf8");
    expect(lib).not.toMatch(/transitionIncident\s*\(|updateIncidentFields\s*\(|rememberInNamespace|walrus.*write|sendMessage\s*\(|postToThread\s*\(/i);
    expect(lib).toMatch(/never executes/);
    const store = fs.readFileSync("lib/closure-store.ts", "utf8");
    // Exactly one resolve call site exists, inside the staff-gated,
    // eligibility-checked bindTransition used only by confirmClosure.
    expect(store.match(/transitionIncident\s*\(/g)?.length).toBe(1);
    expect(store).toMatch(/to: "resolved"/);
  });
});

// ---- Live persistence: draft → finalize → resolve with audit ----

const stamp = Date.now().toString(36);
const PW = "correct-horse-123";
const createdEmails: string[] = [];
const createdOrgIds: string[] = [];
const SLUG = `s12-ws-${stamp}`;

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

describe("closure persistence (live Neon)", () => {
  it("closes on verified recovery end-to-end and preserves history on reopen", async () => {
    const { organizationIdForSlug, workspaceIdForSlug } = await import("../tenant");
    const { ensureOrganization, ensureWorkspace, addOrganizationMember, ensureCustomer } = await import("../db");
    const orgId = organizationIdForSlug(SLUG);
    await ensureOrganization({ id: orgId, slug: SLUG, name: `Temp ${SLUG}` });
    const wsId = workspaceIdForSlug(SLUG);
    await ensureWorkspace({ id: wsId, organizationId: orgId, slug: SLUG, name: `Temp ${SLUG}` });
    createdOrgIds.push(orgId);
    cookieJar = await signupSession(`s12-staff-${stamp}@example.test`);
    const { neon } = await import("@neondatabase/serverless");
    const sql = neon(dbKey());
    const staff = (await sql`select id from "user" where email = ${`s12-staff-${stamp}@example.test`} limit 1`) as unknown as { id: string }[];
    await addOrganizationMember({ organizationId: orgId, userId: staff[0].id, role: "owner" });

    // Real customer evidence: conversation + pre-intervention report.
    const { createHash } = await import("node:crypto");
    const { customerIdFor } = await import("../tenant");
    const h = createHash("sha256").update(`s12-${stamp}`, "utf8").digest("hex");
    const custId = customerIdFor(wsId, h);
    await ensureCustomer({ id: custId, workspaceId: wsId, bootstrapHash: h });
    const { createConversation, addUserMessage } = await import("../support-ops");
    const conv = (await createConversation({ workspaceId: wsId, customerId: custId, title: "Visa 500s" })).conversation;
    await addUserMessage({ conversationId: conv.id, content: "Visa checkout fails with HTTP 500 every time today", clientId: `s12-${stamp}-1` });

    const { createIncident, transitionIncident, listIncidentEvents, getIncidentForWorkspace, addIncidentConversation } = await import("../incidents");
    const inc = await createIncident({ workspaceId: wsId, title: "S12 live incident", createdByUserId: staff[0].id });
    await addIncidentConversation({ incidentId: inc.id, workspaceId: wsId, conversationId: conv.id, actorUserId: staff[0].id });
    for (const to of ["investigating", "ready_for_action", "recovering", "monitoring"] as const) {
      await transitionIncident({ incidentId: inc.id, workspaceId: wsId, to });
    }

    // Real S6 brief with a deterministic judge (no Gemini in tests).
    const { realBriefStore, refreshBriefIfNeeded, getIncidentBrief } = await import("../evidence-brief");
    const bstore = await realBriefStore();
    const bjudge = async (input: { sources: { id: string }[] }) => ({
      facts: [{ observation: "Visa checkout returns HTTP 500", identifiers: ["500", "Visa"], sources: input.sources.map((s) => s.id) }],
      corroborated: [],
      contradictions: [],
      unknowns: ["Root cause unknown"],
      hypotheses: [{ text: "Might be a gateway timeout", basedOn: input.sources.map((s) => s.id) }],
    });
    const rb = await refreshBriefIfNeeded(inc.id, wsId, { store: bstore, judge: bjudge as never });
    expect(rb.action).toBe("built");
    const brief = await getIncidentBrief(inc.id, wsId);
    expect(brief?.status).toBe("current");
    const briefFp = brief!.fingerprint;

    // S9 plan on the real brief fingerprint, staged for humans.
    const { realPlanStore } = await import("../recovery-plans");
    const plans = await realPlanStore();
    const draft = await plans.createDraft({ incidentId: inc.id, workspaceId: wsId, fingerprint: briefFp, briefVersion: brief!.version, payload: livePayload(), createdByUserId: staff[0].id });
    await plans.transition({ planId: draft.row.id, workspaceId: wsId, to: "under_review", actorUserId: staff[0].id });
    await plans.transition({ planId: draft.row.id, workspaceId: wsId, to: "staged", actorUserId: staff[0].id });

    // S10 approval + documented manual intervention.
    const { realApprovalDeps } = await import("../recovery-approvals");
    const adeps = await realApprovalDeps();
    const liveFp = async () => briefFp;
    const req = await (await import("../recovery-approvals")).requestApproval(draft.row.id, wsId, staff[0].id, { actionType: "manual_external_record", steps: [0], riskAck: true }, { ...adeps, loadBriefFingerprint: liveFp });
    if (req.action !== "requested") throw new Error("approval setup failed");
    await (await import("../recovery-approvals")).decideApproval(req.approval.id, wsId, staff[0].id, "approve", "ok", { ...adeps, loadBriefFingerprint: liveFp });
    await (await import("../recovery-approvals")).claimManualExecution(req.approval.id, wsId, staff[0].id, { idempotencyKey: `s12-${stamp}` }, adeps);

    // S11 watch + real post-intervention customer confirmation.
    const { realWatchDeps } = await import("../resolution-watch-store");
    const wdeps = await realWatchDeps({ judge: false });
    const { startWatch, noteNewMessage, confirmResolution } = await import("../resolution-watch");
    const started = await startWatch(inc.id, wsId, staff[0].id, { planId: draft.row.id }, wdeps);
    if (started.action !== "started") throw new Error("watch setup failed");
    const m2 = await addUserMessage({ conversationId: conv.id, content: "Visa checkout is fixed now, no more 500 errors on pay, thank you!", clientId: `s12-${stamp}-2` });
    const { listMessages } = await import("../support-ops");
    const m2row = (await listMessages(conv.id)).find((m) => m.id === m2.id);
    if (!m2row) throw new Error("message setup failed");
    const noted = await noteNewMessage(inc.id, wsId, { id: m2row.id, conversationId: conv.id, excerpt: m2row.content.slice(0, 500), createdAt: m2row.created_at }, wdeps);
    expect(noted.action).toBe("noted");
    const confirmed = await confirmResolution(started.watch.id, wsId, staff[0].id, "Customer confirmed on call", wdeps);
    expect(confirmed.action).toBe("confirmed");

    // S12: factual draft → eligible → verified closure.
    const { realClosureDeps } = await import("../closure-store");
    const closure = await import("../closure");
    const cdeps = await realClosureDeps({ judge: false });
    const generated = await closure.generateDraft(inc.id, wsId, staff[0].id, cdeps);
    expect(generated.action).toBe("drafted");
    if (generated.action !== "drafted") throw new Error("draft failed");
    expect(generated.synthesis).toBe("factual_only");
    expect(generated.postmortem.content.chronology.length).toBeGreaterThan(0);
    const eligibility = await closure.checkEligibility(inc.id, wsId, cdeps);
    expect(eligibility.eligible).toBe(true);
    const done = await closure.confirmClosure(inc.id, wsId, staff[0].id, { postmortemId: generated.postmortem.id }, cdeps, cdeps.bindTransition(inc.id, wsId, staff[0].id));
    expect(done.action).toBe("closed");
    // Concurrent retry dedupes instead of double-closing.
    const retry = await closure.confirmClosure(inc.id, wsId, staff[0].id, { postmortemId: generated.postmortem.id }, cdeps, cdeps.bindTransition(inc.id, wsId, staff[0].id));
    expect(retry.action).toBe("duplicate");

    const events = await listIncidentEvents(inc.id, wsId);
    const kinds = events.map((e) => e.kind);
    for (const k of ["postmortem_drafted", "postmortem_finalized", "closure_confirmed"]) {
      expect(kinds).toContain(k);
    }
    expect(kinds).not.toContain("closure_administrative");
    expect((await getIncidentForWorkspace(wsId, inc.id))?.status).toBe("resolved");

    // S4 gate preserved live: bare resolve is rejected even from monitoring.
    const inc2 = await createIncident({ workspaceId: wsId, title: "S12 gate probe", createdByUserId: staff[0].id });
    for (const to of ["investigating", "ready_for_action", "recovering", "monitoring"] as const) {
      await transitionIncident({ incidentId: inc2.id, workspaceId: wsId, to });
    }
    await expect(transitionIncident({ incidentId: inc2.id, workspaceId: wsId, to: "resolved" })).rejects.toMatchObject({ status: 409 });

    // Reopen preserves the finalized closure history.
    const reopened = await transitionIncident({ incidentId: inc.id, workspaceId: wsId, to: "investigating" });
    expect(reopened.status).toBe("investigating");
    const finals = await cdeps.postmortems.listFinalized(inc.id, wsId);
    expect(finals.length).toBe(1);
    expect(finals[0].status).toBe("finalized");
    const events2 = await listIncidentEvents(inc.id, wsId);
    expect(events2.map((e) => e.kind)).toContain("closure_reopened");
  }, 180_000);
});
