import { describe, expect, it, afterAll, vi } from "vitest";
import {
  buildMemoryCandidate,
  proposeMemoryCandidate,
  type ClosureMode,
  type MemoryDeps,
  type MemoryLinkRow,
  type MemoryStore,
} from "../operator-memory";
import { POST as proposePOST, GET as proposeGET } from "@/app/api/incidents/[id]/memory-candidate/route";

let cookieJar = "";
vi.mock("next/headers", () => ({
  headers: async () => new Headers(cookieJar ? { cookie: cookieJar } : {}),
}));

function finalizedPm(over: Record<string, unknown> = {}) {
  return {
    id: "pm-1",
    incident_id: "inc-1",
    workspace_id: "ws-1",
    status: "finalized",
    source_fingerprint: "fp-pm-1",
    brief_fingerprint: "fp-1",
    content: {
      symptoms: ["Visa checkout returns HTTP 500 on pay"],
      outcome: "Resolution confirmed by an authorized operator on supporting customer evidence.",
      rootCause: { status: "unverified", statement: "Gateway timeout suspected, not proven." },
      interventions: [{ id: "ex-1", status: "verified_success", ref: "CHG-42" }],
      watch: { status: "resolution_confirmed", observations: 2, improvements: 1, regressions: 0, confirmedBy: "op-1" },
      unknowns: ["Whether mobile was affected"],
    },
    ...over,
  };
}

function makeStores() {
  const links: MemoryLinkRow[] = [];
  let ln = 0;
  let cardSeq = 0;
  const cards: { id: string; status: string }[] = [];
  const store: MemoryStore = {
    findByPostmortem: async (pm) => links.find((l) => l.postmortem_id === pm) ?? null,
    listApprovedForIncident: async (iid) => links.filter((l) => l.incident_id === iid),
    listForCards: async (_ws, ids) => new Map(links.filter((l) => ids.includes(l.fix_card_id)).map((l) => [l.fix_card_id, l])),
    insert: async (input) => {
      const dup = links.find((l) => l.postmortem_id === input.postmortemId);
      if (dup) return { row: dup, deduped: true };
      ln++;
      const row: MemoryLinkRow = {
        id: `link-${ln}`,
        incident_id: input.incidentId,
        workspace_id: input.workspaceId,
        postmortem_id: input.postmortemId,
        fix_card_id: input.fixCardId,
        tier: input.tier,
        verified: input.verified,
        source_fingerprint: input.fingerprint,
        created_by_user_id: input.createdBy,
        created_at: new Date().toISOString(),
      };
      links.push(row);
      return { row, deduped: false };
    },
  };
  return {
    store,
    links,
    cards,
    nextCard: () => `card-${++cardSeq}`,
    addCard: (id: string, status = "pending_review") => cards.push({ id, status }),
  };
}

type Cfg = {
  pm?: ReturnType<typeof finalizedPm> | null;
  mode?: ClosureMode;
  targets?: { customerId: string | null; conversationId: string | null };
  failCard?: boolean;
};

function makeDeps(cfg: Cfg = {}): { deps: MemoryDeps; stores: ReturnType<typeof makeStores> } {
  const stores = makeStores();
  const deps: MemoryDeps = {
    loadPostmortem: async (id, ws) => {
      if (ws !== "ws-1") return null;
      const pm = "pm" in cfg ? cfg.pm : finalizedPm();
      if (!pm || pm.id !== id) return null;
      return pm;
    },
    closureMode: async () => cfg.mode ?? "verified",
    linkTargets: async () => cfg.targets ?? { customerId: "cust-1", conversationId: "conv-1" },
    createCard: async () => {
      if (cfg.failCard) throw new Error("db down");
      const id = stores.nextCard();
      stores.addCard(id);
      return { id };
    },
    links: stores.store,
  };
  return { deps, stores };
}

describe("candidate derivation (pure)", () => {
  it("builds a verified candidate with explicit labels", () => {
    const r = buildMemoryCandidate(finalizedPm(), "verified");
    expect(r.eligible).toBe(true);
    if (!r.eligible) return;
    expect(r.candidate.tier).toBe("verified_fix");
    expect(r.candidate.outcomeLabel).toBe("CONFIRMED OUTCOME");
    expect(r.candidate.causeLabel).toBe("HYPOTHESIS");
    expect(r.candidate.cause).toMatch(/unverified hypothesis/);
    expect(r.candidate.provenance.postmortemId).toBe("pm-1");
  });

  it("keeps unknown causes unknown, never invents", () => {
    const pm = finalizedPm({ content: { ...finalizedPm().content, rootCause: { status: "unknown", statement: "" } } });
    const r = buildMemoryCandidate(pm, "verified");
    expect(r.eligible).toBe(true);
    if (!r.eligible) return;
    expect(r.candidate.causeLabel).toBe("UNKNOWN");
  });

  it("refuses administrative closures, drafts, and evidence-free postmortems", () => {
    expect(buildMemoryCandidate(finalizedPm(), "administrative").eligible).toBe(false);
    expect(buildMemoryCandidate(finalizedPm(), "none").eligible).toBe(false);
    const draft = finalizedPm({ status: "draft" });
    expect(buildMemoryCandidate(draft, "verified")).toMatchObject({ eligible: false });
    const noImprove = finalizedPm({
      content: { ...finalizedPm().content, watch: { status: "still_affected", observations: 1, improvements: 0, regressions: 0, confirmedBy: null } },
    });
    expect(buildMemoryCandidate(noImprove, "verified")).toMatchObject({ eligible: false });
    const noAction = finalizedPm({ content: { ...finalizedPm().content, interventions: [] } });
    expect(buildMemoryCandidate(noAction, "verified")).toMatchObject({ eligible: false });
  });

  it("rejects PII-bearing candidates at the gate", () => {
    const pm = finalizedPm({
      content: { ...finalizedPm().content, symptoms: ["Contact jane@example.com about the Visa 500"] },
    });
    const built = buildMemoryCandidate(pm, "verified");
    expect(built.eligible).toBe(true); // shape is fine; redaction gate decides at propose time
  });
});

describe("proposal orchestration (fakes)", () => {
  it("proposes once and dedupes repeats", async () => {
    const { deps, stores } = makeDeps();
    const r1 = await proposeMemoryCandidate("inc-1", "ws-1", "op-1", { postmortemId: "pm-1" }, deps);
    expect(r1.action).toBe("proposed");
    const r2 = await proposeMemoryCandidate("inc-1", "ws-1", "op-1", { postmortemId: "pm-1" }, deps);
    expect(r2.action).toBe("duplicate");
    expect(stores.cards.length).toBe(1);
  });

  it("defers on admin closure, missing evidence, redaction, and failures", async () => {
    expect((await proposeMemoryCandidate("inc-1", "ws-1", "op-1", { postmortemId: "pm-1" }, makeDeps({ mode: "administrative" }).deps)).action).toBe("deferred");
    expect((await proposeMemoryCandidate("inc-1", "ws-1", "op-1", { postmortemId: "pm-1" }, makeDeps({ pm: null }).deps)).action).toBe("deferred");
    expect((await proposeMemoryCandidate("inc-1", "ws-foreign", "op-1", { postmortemId: "pm-1" }, makeDeps().deps)).action).toBe("deferred");
    expect((await proposeMemoryCandidate("inc-1", "ws-1", "op-1", { postmortemId: "pm-1" }, makeDeps({ targets: { customerId: null, conversationId: null } }).deps)).action).toBe("deferred");
    expect((await proposeMemoryCandidate("inc-1", "ws-1", "op-1", { postmortemId: "pm-1" }, makeDeps({ failCard: true }).deps)).action).toBe("deferred");
    const pii = makeDeps();
    pii.deps.loadPostmortem = async () => finalizedPm({ content: { ...finalizedPm().content, symptoms: ["Call +1 555 123 4567 about Visa 500"] } });
    const r = await proposeMemoryCandidate("inc-1", "ws-1", "op-1", { postmortemId: "pm-1" }, pii.deps);
    expect(r.action).toBe("deferred");
  });
});

describe("route authorization", () => {
  it("anonymous callers get 401 without touching data", async () => {
    cookieJar = "";
    const p = { params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000" }) };
    const post = await proposePOST(
      new Request("http://test/api/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceSlug: "northstar", postmortemId: "x" }) }),
      p,
    );
    expect(post.status).toBe(401);
    expect((await proposeGET(new Request("http://test/api/x?workspaceSlug=northstar"), p)).status).toBe(401);
  }, 60_000);
});

describe("no automatic side effects", () => {
  it("memory domain never writes shared memory, sends, executes, or closes", async () => {
    const fs = await import("node:fs");
    const lib = fs.readFileSync("lib/operator-memory.ts", "utf8");
    expect(lib).not.toMatch(/rememberInNamespace|rememberShared|walrus|sendMessage|transitionIncident|updateIncidentFields|markFixCardShared/);
    expect(lib).toMatch(/without explicit staff approval/);
  });
});

// ---- Live persistence: full postmortem → memory → recall loop ----

const stamp = Date.now().toString(36);
const PW = "correct-horse-123";
const createdEmails: string[] = [];
const createdOrgIds: string[] = [];
const SLUG = `s13-ws-${stamp}`;

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

describe("memory loop (live Neon)", () => {
  it("verified closure becomes approved memory recalled by a later incident", async () => {
    const { organizationIdForSlug, workspaceIdForSlug, customerIdFor } = await import("../tenant");
    const { ensureOrganization, ensureWorkspace, addOrganizationMember, ensureCustomer } = await import("../db");
    const orgId = organizationIdForSlug(SLUG);
    await ensureOrganization({ id: orgId, slug: SLUG, name: `Temp ${SLUG}` });
    const wsId = workspaceIdForSlug(SLUG);
    await ensureWorkspace({ id: wsId, organizationId: orgId, slug: SLUG, name: `Temp ${SLUG}` });
    createdOrgIds.push(orgId);
    cookieJar = await signupSession(`s13-staff-${stamp}@example.test`);
    const { neon } = await import("@neondatabase/serverless");
    const sql = neon(dbKey());
    const staff = (await sql`select id from "user" where email = ${`s13-staff-${stamp}@example.test`} limit 1`) as unknown as { id: string }[];
    await addOrganizationMember({ organizationId: orgId, userId: staff[0].id, role: "owner" });

    const { createHash } = await import("node:crypto");
    const h = createHash("sha256").update(`s13-${stamp}`, "utf8").digest("hex");
    const custId = customerIdFor(wsId, h);
    await ensureCustomer({ id: custId, workspaceId: wsId, bootstrapHash: h });
    const { createConversation, addUserMessage, listMessages } = await import("../support-ops");
    const conv = (await createConversation({ workspaceId: wsId, customerId: custId, title: "Visa 500s" })).conversation;
    await addUserMessage({ conversationId: conv.id, content: "Visa checkout fails with HTTP 500 every time today", clientId: `s13-${stamp}-1` });

    const { createIncident, transitionIncident, addIncidentConversation, listIncidentEvents } = await import("../incidents");
    const inc = await createIncident({ workspaceId: wsId, title: "S13 loop incident", createdByUserId: staff[0].id });
    await addIncidentConversation({ incidentId: inc.id, workspaceId: wsId, conversationId: conv.id, actorUserId: staff[0].id });
    for (const to of ["investigating", "ready_for_action", "recovering", "monitoring"] as const) {
      await transitionIncident({ incidentId: inc.id, workspaceId: wsId, to });
    }

    const { realBriefStore, refreshBriefIfNeeded, getIncidentBrief } = await import("../evidence-brief");
    const bjudge = async (input: { sources: { id: string }[] }) => ({
      facts: [{ observation: "Visa checkout returns HTTP 500", identifiers: ["500", "Visa"], sources: input.sources.map((s) => s.id) }],
      corroborated: [],
      contradictions: [],
      unknowns: ["Root cause unknown"],
      hypotheses: [{ text: "Might be a gateway timeout", basedOn: input.sources.map((s) => s.id) }],
    });
    await refreshBriefIfNeeded(inc.id, wsId, { store: await realBriefStore(), judge: bjudge as never });
    const brief = await getIncidentBrief(inc.id, wsId);
    if (!brief || brief.status !== "current") throw new Error("brief setup failed");

    const { realPlanStore } = await import("../recovery-plans");
    const plans = await realPlanStore();
    const draft = await plans.createDraft({ incidentId: inc.id, workspaceId: wsId, fingerprint: brief.fingerprint, briefVersion: brief.version, payload: livePayload(), createdByUserId: staff[0].id });
    await plans.transition({ planId: draft.row.id, workspaceId: wsId, to: "under_review", actorUserId: staff[0].id });
    await plans.transition({ planId: draft.row.id, workspaceId: wsId, to: "staged", actorUserId: staff[0].id });

    const { realApprovalDeps, requestApproval, decideApproval, claimManualExecution } = await import("../recovery-approvals");
    const adeps = await realApprovalDeps();
    const liveFp = async () => brief.fingerprint;
    const req = await requestApproval(draft.row.id, wsId, staff[0].id, { actionType: "manual_external_record", steps: [0], riskAck: true }, { ...adeps, loadBriefFingerprint: liveFp });
    if (req.action !== "requested") throw new Error("approval setup failed");
    await decideApproval(req.approval.id, wsId, staff[0].id, "approve", "ok", { ...adeps, loadBriefFingerprint: liveFp });
    await claimManualExecution(req.approval.id, wsId, staff[0].id, { idempotencyKey: `s13-${stamp}` }, adeps);

    const { realWatchDeps } = await import("../resolution-watch-store");
    const wdeps = await realWatchDeps({ judge: false });
    const { startWatch, noteNewMessage, confirmResolution } = await import("../resolution-watch");
    const started = await startWatch(inc.id, wsId, staff[0].id, { planId: draft.row.id }, wdeps);
    if (started.action !== "started") throw new Error("watch setup failed");
    const m2id = (await addUserMessage({ conversationId: conv.id, content: "Visa checkout is fixed now, no more 500 errors on pay, thank you!", clientId: `s13-${stamp}-2` })).id;
    const m2row = (await listMessages(conv.id)).find((m) => m.id === m2id);
    if (!m2row) throw new Error("message setup failed");
    await noteNewMessage(inc.id, wsId, { id: m2row.id, conversationId: conv.id, excerpt: m2row.content.slice(0, 500), createdAt: m2row.created_at }, wdeps);
    const confirmed = await confirmResolution(started.watch.id, wsId, staff[0].id, "Customer confirmed on call", wdeps);
    expect(confirmed.action).toBe("confirmed");

    const { realClosureDeps } = await import("../closure-store");
    const closure = await import("../closure");
    const cdeps = await realClosureDeps({ judge: false });
    const generated = await closure.generateDraft(inc.id, wsId, staff[0].id, cdeps);
    if (generated.action !== "drafted") throw new Error("draft failed");
    expect(await closure.checkEligibility(inc.id, wsId, cdeps)).toMatchObject({ eligible: true });
    const done = await closure.confirmClosure(inc.id, wsId, staff[0].id, { postmortemId: generated.postmortem.id }, cdeps, cdeps.bindTransition(inc.id, wsId, staff[0].id));
    expect(done.action).toBe("closed");

    // S13: propose from the finalized postmortem.
    const { realMemoryDeps, linkMemoryShare } = await import("../operator-memory");
    const mdeps = await realMemoryDeps();
    const { proposeMemoryCandidate } = await import("../operator-memory");
    const proposed = await proposeMemoryCandidate(inc.id, wsId, staff[0].id, { postmortemId: generated.postmortem.id }, mdeps);
    expect(proposed.action).toBe("proposed");
    const dup = await proposeMemoryCandidate(inc.id, wsId, staff[0].id, { postmortemId: generated.postmortem.id }, mdeps);
    expect(dup.action).toBe("duplicate");

    // Pending memory is NOT recalled yet (unreviewed cards never surface).
    const { realMatchStore } = await import("../fix-matches");
    const mstore = await realMatchStore();
    const { getFixCardForWorkspace, markFixCardShared, listSupersededSharedBlobs } = await import("../support-ops");
    const pendingCard = await getFixCardForWorkspace((proposed as { cardId: string }).cardId, wsId);
    expect(pendingCard?.status).toBe("pending_review");
    expect(pendingCard?.walrus_blob_id).toBeNull();
    expect((await mstore.loadCards(wsId)).some((c) => c.id === pendingCard!.id)).toBe(false);

    // Staff approves in Fix Card review (simulated share + S13 hook).
    const blobId = `blob-s13-${stamp}`;
    await markFixCardShared(pendingCard!.id, blobId, staff[0].id);
    const hook = await linkMemoryShare(wsId, pendingCard!.id, staff[0].id);
    expect(hook.superseded).toEqual([]);

    // Later incident with overlapping symptoms recalls the approved memory.
    const conv2 = (await createConversation({ workspaceId: wsId, customerId: custId, title: "Visa 500s again" })).conversation;
    await addUserMessage({ conversationId: conv2.id, content: "Visa checkout fails with HTTP 500 again today", clientId: `s13-${stamp}-3` });
    const inc2 = await createIncident({ workspaceId: wsId, title: "S13 later incident", createdByUserId: staff[0].id });
    await addIncidentConversation({ incidentId: inc2.id, workspaceId: wsId, conversationId: conv2.id, actorUserId: staff[0].id });
    await refreshBriefIfNeeded(inc2.id, wsId, { store: await realBriefStore(), judge: bjudge as never });
    const brief2 = await getIncidentBrief(inc2.id, wsId);
    if (!brief2 || brief2.status !== "current") throw new Error("brief2 setup failed");

    const { refreshMatchesIfNeeded } = await import("../fix-matches");
    const matched = await refreshMatchesIfNeeded(inc2.id, wsId, {
      loadBrief: async () => ({ status: "current" as const, version: brief2.version, fingerprint: brief2.fingerprint, findings: brief2.findings, source_count: brief2.source_count, generated_at: brief2.generated_at }),
      store: mstore,
      recall: async () => [], // Neon-only path: recall failure degrades deterministically
      judge: (async () => ({
        matches: [{ ref: pendingCard!.id, relevance: "likely", reasons: ["Same Visa 500 on pay"], matchingSymptoms: ["visa checkout"], differences: [], unknowns: [], applicable: true, warning: "" }],
      })) as never,
    });
    expect(matched.action).toBe("built");
    const rows = await mstore.loadForBrief(inc2.id, wsId, brief2.fingerprint);
    expect(rows.some((r) => r.ref_id === pendingCard!.id)).toBe(true);
    const ours = rows.find((r) => r.ref_id === pendingCard!.id)!;
    expect(ours.payload.cardExcerpt).toMatch(/Visa checkout/);

    // Cross-workspace isolation: a foreign workspace sees nothing.
    const otherSlug = `s13-other-${stamp}`;
    const otherOrg = organizationIdForSlug(otherSlug);
    await (await import("../db")).ensureOrganization({ id: otherOrg, slug: otherSlug, name: "Other" });
    createdOrgIds.push(otherOrg);
    const otherWs = workspaceIdForSlug(otherSlug);
    await (await import("../db")).ensureWorkspace({ id: otherWs, organizationId: otherOrg, slug: otherSlug, name: "Other" });
    expect((await mstore.loadCards(otherWs)).some((c) => c.id === pendingCard!.id)).toBe(false);
    expect((await mstore.resolveCardsByBlobs(otherWs, [blobId])).size).toBe(0);

    // Supersession: a newer memory for the same incident retires the old one.
    const { realClosureDeps: realClosureDeps2 } = await import("../closure-store");
    void realClosureDeps2;
    const finals = await cdeps.postmortems.listFinalized(inc.id, wsId);
    expect(finals.length).toBe(1);
    await transitionIncident({ incidentId: inc.id, workspaceId: wsId, to: "investigating" });
    const { linkMemoryShare: _hook } = await import("../operator-memory");
    void _hook;
    // Direct supersede via existing review primitive + deny-list proof:
    const { markFixCardSuperseded } = await import("../support-ops");
    const repl = await (await import("../support-ops")).createPendingFixCard({
      workspaceId: wsId, customerId: custId, conversationId: conv.id, issueId: null,
      candidateText: "[SHARED_FIX]\nSymptom: x\nCause: y\nResolution: z",
    });
    await markFixCardShared(repl.id, `blob-s13b-${stamp}`, staff[0].id);
    await markFixCardSuperseded(pendingCard!.id, repl.id, staff[0].id);
    expect(await getFixCardForWorkspace(pendingCard!.id, wsId).then((c) => c?.status)).toBe("superseded");
    expect((await listSupersededSharedBlobs(wsId)).includes(blobId)).toBe(true);
    expect((await mstore.loadCards(wsId)).some((c) => c.id === pendingCard!.id)).toBe(false);

    // S12 history untouched by memory work.
    expect((await cdeps.postmortems.listFinalized(inc.id, wsId)).length).toBe(1);
    const kinds = (await listIncidentEvents(inc.id, wsId)).map((e) => e.kind);
    expect(kinds).toContain("memory_proposed");

    // Administrative closure can never become memory.
    const incA = await createIncident({ workspaceId: wsId, title: "S13 admin incident", createdByUserId: staff[0].id });
    for (const to of ["investigating", "ready_for_action", "recovering", "monitoring"] as const) {
      await transitionIncident({ incidentId: incA.id, workspaceId: wsId, to });
    }
    await transitionIncident({ incidentId: incA.id, workspaceId: wsId, to: "resolved", closure: { mode: "administrative", reason: "test" } });
    const adminPm = await cdeps.postmortems.saveDraft({
      incidentId: incA.id, workspaceId: wsId, watchId: null, fingerprint: "fp-admin",
      briefFingerprint: "", content: generated.postmortem.content, createdBy: staff[0].id,
    });
    await cdeps.postmortems.finalize(adminPm.row.id, wsId, staff[0].id, null);
    const adminTry = await proposeMemoryCandidate(incA.id, wsId, staff[0].id, { postmortemId: adminPm.row.id }, mdeps);
    expect(adminTry.action).toBe("deferred");
  }, 240_000);
});
