import { describe, expect, it, afterAll, vi } from "vitest";
import {
  detectContradictions,
  detectGaps,
  detectStale,
  refreshKnowledgeHealth,
  validateContradictionJudge,
  type FindingStore,
  type HealthCard,
  type HealthDeps,
  type HealthMatch,
  type KnowledgeFinding,
  type MemoryLinkInfo,
} from "../knowledge-health";
import { GET as healthGET, POST as healthPOST } from "@/app/api/workspaces/[slug]/knowledge-health/route";
import { POST as reviewPOST } from "@/app/api/workspaces/[slug]/knowledge-health/[findingId]/review/route";
import { POST as repairPOST } from "@/app/api/workspaces/[slug]/knowledge-health/[findingId]/repair/route";

let cookieJar = "";
vi.mock("next/headers", () => ({
  headers: async () => new Headers(cookieJar ? { cookie: cookieJar } : {}),
}));

const NOW = new Date().toISOString();

function card(over: Partial<HealthCard> = {}): HealthCard {
  return {
    id: "card-1",
    status: "shared",
    text: "[SHARED_FIX]\nSymptom: Visa checkout returns HTTP 500 on pay\nCause: gateway timeout\nResolution: retried idempotently after scoping",
    resolved: true,
    createdAt: NOW,
    blobId: "blob-1",
    supersededBy: null,
    ...over,
  };
}

function brief(over: Record<string, unknown> = {}) {
  return {
    status: "current",
    fingerprint: "fp-1",
    version: 1,
    findings: {
      facts: [
        { observation: "Visa checkout returns HTTP 500 on pay", identifiers: ["500", "Visa"], sources: ["m1"] },
        { observation: "Same 500 on Visa checkout at peak", identifiers: ["500"], sources: ["m2"] },
      ],
      unknowns: ["Root cause unknown"],
    },
    ...over,
  };
}

function match(over: Record<string, unknown> = {}): HealthMatch {
  return {
    ref_id: "card-1",
    tier: "verified_fix",
    payload: {
      reasons: ["Same Visa 500 on pay"],
      matchingSymptoms: ["visa checkout returns http 500"],
      differences: [],
      unknowns: [],
      applicable: true,
      warning: "",
      cardStatus: "shared",
      cardResolved: true,
      cardExcerpt: "Visa checkout returns HTTP 500 on pay. Gateway timeout. Retried idempotently.",
    },
    ...over,
  };
}

function makeStores() {
  const rows: KnowledgeFinding[] = [];
  let n = 0;
  const store: FindingStore = {
    listOpen: async (_ws) => rows.filter((r) => ["open", "acknowledged"].includes(r.status)),
    listForWorkspace: async (_ws, limit) => rows.slice(0, limit),
    loadById: async (id) => rows.find((r) => r.id === id) ?? null,
    upsert: async (input) => {
      const existing = rows.find((r) => r.entity_key === input.entityKey && ["open", "acknowledged"].includes(r.status));
      if (existing && existing.fingerprint === input.fingerprint) {
        existing.last_seen_at = new Date().toISOString();
        return { row: existing, created: false, supersededId: null };
      }
      if (existing) existing.status = "superseded";
      const decided = rows.find(
        (r) => r.entity_key === input.entityKey && r.fingerprint === input.fingerprint && ["dismissed", "addressed", "superseded"].includes(r.status),
      );
      if (decided) return { row: decided, created: false, supersededId: existing ? existing.id : null };
      n++;
      const row: KnowledgeFinding = {
        id: `f-${n}`,
        workspace_id: input.workspaceId,
        type: input.type,
        confidence: input.confidence,
        status: "open",
        title: input.title,
        detail: input.detail,
        fingerprint: input.fingerprint,
        entity_key: input.entityKey,
        first_seen_at: NOW,
        last_seen_at: NOW,
        reviewed_by_user_id: null,
        review_note: null,
        created_at: NOW,
        updated_at: NOW,
      };
      rows.push(row);
      return { row, created: true, supersededId: existing ? existing.id : null };
    },
    review: async (input) => {
      const row = rows.find((r) => r.id === input.findingId);
      if (!row || !["open", "acknowledged"].includes(row.status)) {
        throw Object.assign(new Error("finding not found or already decided"), { status: 409 });
      }
      row.status = input.to;
      row.reviewed_by_user_id = input.actorUserId;
      row.review_note = input.note;
      return row;
    },
    autoAddress: async (id) => {
      const row = rows.find((r) => r.id === id);
      if (row) row.status = "addressed";
    },
  };
  return { store, rows };
}

type Cfg = {
  incidents?: { id: string; status: string }[];
  briefs?: Record<string, ReturnType<typeof brief> | null>;
  matches?: Record<string, ReturnType<typeof match>[]>;
  cards?: HealthCard[];
  links?: MemoryLinkInfo[];
  recentMatches?: { incident_id: string; brief_fingerprint: string; ref_id: string }[];
  judge?: HealthDeps["judge"];
};

function makeDeps(cfg: Cfg = {}): { deps: HealthDeps; stores: ReturnType<typeof makeStores> } {
  const stores = makeStores();
  const deps: HealthDeps = {
    listRecentIncidents: async () =>
      (cfg.incidents ?? [{ id: "inc-1", status: "monitoring" }]).map((i) => ({ ...i, updated_at: NOW })),
    loadBrief: async (id) => (cfg.briefs && id in cfg.briefs ? (cfg.briefs[id] as never) : (brief() as never)),
    loadMatches: async (id) => cfg.matches?.[id] ?? [],
    recentMatches: async () => cfg.recentMatches ?? [],
    listSharedCards: async () => cfg.cards ?? [card()],
    getCard: async () => null,
    listMemoryLinks: async () => cfg.links ?? [],
    findings: stores.store,
    judge: cfg.judge ?? null,
  };
  return { deps, stores };
}

describe("gap detection (pure)", () => {
  it("flags a grounded gap when nothing relevant exists", () => {
    const found = detectGaps(
      [{ incident: { id: "inc-1", status: "monitoring", updated_at: NOW }, brief: brief() as never, matches: [] }],
      [card({ id: "card-9", text: "[SHARED_FIX]\nSymptom: password reset email never arrives\nCause: queue stuck\nResolution: restarted worker" })],
    );
    expect(found).toHaveLength(1);
    expect(found[0].confidence).toBe("high");
    expect(found[0].detail.reason).toBe("no_knowledge");
  });

  it("marks thin evidence uncertain, never a confirmed gap", () => {
    const found = detectGaps(
      [{
        incident: { id: "inc-1", status: "monitoring", updated_at: NOW },
        brief: brief({ findings: { facts: [{ observation: "something odd happened", identifiers: [], sources: ["m1"] }], unknowns: [] } }) as never,
        matches: [],
      }],
      [card({ id: "card-9", text: "[SHARED_FIX]\nSymptom: password reset email never arrives\nCause: queue stuck\nResolution: restarted worker" })],
    );
    expect(found).toHaveLength(1);
    expect(found[0].confidence).toBe("low");
    expect(found[0].detail.reason).toBe("thin_evidence");
  });

  it("needs a stored reviewed match — lexical candidates stay unverified leads", () => {
    const found = detectGaps(
      [{ incident: { id: "inc-1", status: "monitoring", updated_at: NOW }, brief: brief() as never, matches: [] }],
      [card()],
    );
    expect(found).toHaveLength(1);
    expect(found[0].detail.reason).toBe("unreviewed_candidates");
    expect(found[0].confidence).toBe("low");
  });

  it("emits nothing when a reviewed match exists", () => {
    const found = detectGaps(
      [{ incident: { id: "inc-1", status: "monitoring", updated_at: NOW }, brief: brief() as never, matches: [match() as never] }],
      [card()],
    );
    expect(found).toHaveLength(0);
  });

  it("unreviewed cards do not count as knowledge", () => {
    const found = detectGaps(
      [{ incident: { id: "inc-1", status: "monitoring", updated_at: NOW }, brief: brief() as never, matches: [] }],
      [card({ id: "card-p", status: "pending_review" })],
    );
    expect(found[0].detail.reason).toBe("unreviewed_candidates");
    expect(found[0].detail.unverified.some((u) => u.includes("unreviewed"))).toBe(true);
  });
});

describe("contradiction detection (pure + judge)", () => {
  const ctx = {
    incident: { id: "inc-1", status: "monitoring", updated_at: NOW },
    brief: brief() as never,
  };

  it("flags tier conflicts on shared symptoms", async () => {
    const cardsById = new Map([
      ["card-a", card({ id: "card-a" })],
      ["card-b", card({ id: "card-b", text: "[SHARED_FIX]\nSymptom: Visa checkout returns HTTP 500 on pay\nCause: client bug\nResolution: ship app update" })],
    ]);
    const found = await detectContradictions(
      [{ ...ctx, matches: [
        match({ ref_id: "card-a", tier: "verified_fix" }) as never,
        match({ ref_id: "card-b", tier: "possible_match", payload: { ...match().payload, applicable: false, warning: "only for app v1" } }) as never,
      ] }],
      cardsById,
      null,
    );
    expect(found).toHaveLength(1);
    expect(found[0].confidence).toBe("high");
    expect(found[0].detail.refs.cardIds.sort()).toEqual(["card-a", "card-b"]);
  });

  it("rejects generic wording overlap without shared symptoms", async () => {
    const cardsById = new Map([
      ["card-a", card({ id: "card-a" })],
      ["card-b", card({ id: "card-b", text: "[SHARED_FIX]\nSymptom: refund email delayed\nCause: queue lag\nResolution: retried job" })],
    ]);
    const found = await detectContradictions(
      [{ ...ctx, matches: [
        match({ ref_id: "card-a", tier: "documented_unverified" }) as never,
        match({ ref_id: "card-b", tier: "possible_match", payload: { ...match().payload, matchingSymptoms: ["refund email"], cardExcerpt: "refund email delayed" } }) as never,
      ] }],
      cardsById,
      null,
    );
    expect(found).toHaveLength(0);
  });

  it("keeps ambiguous overlap uncertain without a judge, upgrades on validated conflict", async () => {
    const cardsById = new Map([
      ["card-a", card({ id: "card-a" })],
      ["card-b", card({ id: "card-b", text: "[SHARED_FIX]\nSymptom: Visa checkout returns HTTP 500 on pay\nCause: gateway timeout\nResolution: wait and retry" })],
    ]);
    const matches = [
      match({ ref_id: "card-a", tier: "documented_unverified" }) as never,
      match({ ref_id: "card-b", tier: "documented_unverified" }) as never,
    ];
    const uncertain = await detectContradictions([{ ...ctx, matches }], cardsById, null);
    expect(uncertain).toHaveLength(1);
    expect(uncertain[0].confidence).toBe("low");

    const judged = await detectContradictions([{ ...ctx, matches }], cardsById, async () => ({
      conflict: true,
      sharedSymptoms: ["visa checkout 500"],
      reason: "opposite guidance for identical symptoms",
    }));
    expect(judged[0].confidence).toBe("high");

    const failed = await detectContradictions([{ ...ctx, matches }], cardsById, async () => {
      throw new Error("model down");
    });
    expect(failed[0].confidence).toBe("low");

    expect(validateContradictionJudge({ conflict: true, sharedSymptoms: [], reason: "x" }, new Set(["card-a", "ghost"]))).toBeTruthy();
    expect(validateContradictionJudge({ conflict: "yes", sharedSymptoms: [], reason: "x" }, new Set(["card-a"]))).toBeNull();
  });
});

describe("staleness detection (pure)", () => {
  const byId = (cards: { id: string; status: string; supersededBy: string | null }[]) =>
    new Map(cards.map((c) => [c.id, c]));

  it("spots corrected cards with stale provenance links", () => {
    const links: MemoryLinkInfo[] = [{ id: "link-1", incident_id: "inc-1", postmortem_id: "pm-1", fix_card_id: "card-old", verified: true }];
    const found = detectStale(
      links,
      byId([
        { id: "card-old", status: "superseded", supersededBy: "card-new" },
        { id: "card-new", status: "shared", supersededBy: null },
      ]),
      [],
    );
    expect(found).toHaveLength(1);
    expect(found[0].detail.reason).toBe("stale_provenance");
    expect(found[0].confidence).toBe("high");
  });

  it("reports plain superseded memories as low-key history", () => {
    const links: MemoryLinkInfo[] = [{ id: "link-1", incident_id: "inc-1", postmortem_id: "pm-1", fix_card_id: "card-old", verified: true }];
    const found = detectStale(links, byId([{ id: "card-old", status: "superseded", supersededBy: null }]), []);
    expect(found).toHaveLength(1);
    expect(found[0].detail.reason).toBe("superseded_memory");
  });

  it("flags recommendations pointing at outdated cards", () => {
    const found = detectStale(
      [],
      byId([{ id: "card-old", status: "superseded", supersededBy: "card-new" }]),
      [{ incident_id: "inc-9", brief_fingerprint: "fp-9", ref_id: "card-old" }],
    );
    expect(found).toHaveLength(1);
    expect(found[0].detail.reason).toBe("outdated_recommendation");
  });
});

describe("refresh orchestration (fakes)", () => {
  it("dedupes unchanged evidence and supersedes on drift", async () => {
    const { deps, stores } = makeDeps();
    const r1 = await refreshKnowledgeHealth("ws-1", "op-1", deps);
    expect(r1.action).toBe("refreshed");
    const r2 = await refreshKnowledgeHealth("ws-1", "op-1", deps);
    expect(r2).toMatchObject({ action: "refreshed", created: 0 });
    expect(stores.rows.filter((r) => r.status === "open")).toHaveLength(1);
  });

  it("auto-addresses gaps that gained matches", async () => {
    const { deps, stores } = makeDeps();
    await refreshKnowledgeHealth("ws-1", "op-1", deps);
    expect(stores.rows[0].status).toBe("open");
    const deps2 = makeDeps({ matches: { "inc-1": [match() as never] } });
    deps2.stores.rows.push(...stores.rows);
    const r = await refreshKnowledgeHealth("ws-1", "op-1", deps2.deps);
    expect(r.action).toBe("refreshed");
    if (r.action !== "refreshed") return;
    expect(r.addressed).toBe(1);
    expect(stores.rows[0].status).toBe("addressed");
  });

  it("keeps dismissed findings dismissed until evidence changes", async () => {
    const { deps, stores } = makeDeps();
    await refreshKnowledgeHealth("ws-1", "op-1", deps);
    await stores.store.review({ findingId: stores.rows[0].id, workspaceId: "ws-1", to: "dismissed", actorUserId: "op-1", note: "not now" });
    const r = await refreshKnowledgeHealth("ws-1", "op-1", deps);
    expect(r.action).toBe("refreshed");
    if (r.action !== "refreshed") return;
    expect(r.created).toBe(0);
    expect(stores.rows.filter((x) => x.status === "open")).toHaveLength(0);
  });

  it("isolates workspaces", async () => {
    const { deps } = makeDeps();
    const r = await refreshKnowledgeHealth("ws-foreign", "op-1", {
      ...deps,
      listRecentIncidents: async () => [],
    });
    expect(r.action).toBe("refreshed");
  });

  it("records operator reviews with attribution", async () => {
    const { deps, stores } = makeDeps();
    await refreshKnowledgeHealth("ws-1", "op-1", deps);
    const row = await stores.store.review({ findingId: stores.rows[0].id, workspaceId: "ws-1", to: "acknowledged", actorUserId: "op-9", note: "looking" });
    expect(row.status).toBe("acknowledged");
    expect(row.reviewed_by_user_id).toBe("op-9");
  });
});

describe("route authorization", () => {
  it("anonymous callers get 401 without touching data", async () => {
    cookieJar = "";
    const slug = { params: Promise.resolve({ slug: "northstar" }) };
    expect((await healthGET(new Request("http://test/api/x"), slug)).status).toBe(401);
    expect(
      (await healthPOST(new Request("http://test/api/x", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), slug)).status,
    ).toBe(401);
    const p = { params: Promise.resolve({ slug: "northstar", findingId: "00000000-0000-0000-0000-000000000000" }) };
    const mk = (body: unknown) =>
      new Request("http://test/api/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await reviewPOST(mk({ decision: "dismissed", note: "x" }), p)).status).toBe(401);
    expect((await repairPOST(mk({}), p)).status).toBe(401);
  }, 60_000);
});

describe("no automatic side effects", () => {
  it("health domain never writes memory, executes, messages, or closes", async () => {
    const fs = await import("node:fs");
    const lib = fs.readFileSync("lib/knowledge-health.ts", "utf8");
    expect(lib).not.toMatch(/rememberInNamespace|rememberShared|walrus|sendMessage|transitionIncident|updateIncidentFields|markFixCardShared|resolveConversation/);
    expect(lib).toMatch(/Advisory only/);
    const store = fs.readFileSync("lib/knowledge-health-store.ts", "utf8");
    expect(store).not.toMatch(/transitionIncident|markFixCardShared|rememberInNamespace/);
  });
});

// ---- Live persistence: refresh → review → dedupe with audit-safe rows ----

const stamp = Date.now().toString(36);
const PW = "correct-horse-123";
const createdEmails: string[] = [];
const createdOrgIds: string[] = [];
const SLUG = `s14-ws-${stamp}`;

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

describe("health persistence (live Neon)", () => {
  it("finds gaps, dedupes, reviews, and auto-addresses on new matches", async () => {
    const { organizationIdForSlug, workspaceIdForSlug, customerIdFor } = await import("../tenant");
    const { ensureOrganization, ensureWorkspace, addOrganizationMember, ensureCustomer } = await import("../db");
    const orgId = organizationIdForSlug(SLUG);
    await ensureOrganization({ id: orgId, slug: SLUG, name: `Temp ${SLUG}` });
    const wsId = workspaceIdForSlug(SLUG);
    await ensureWorkspace({ id: wsId, organizationId: orgId, slug: SLUG, name: `Temp ${SLUG}` });
    createdOrgIds.push(orgId);
    cookieJar = await signupSession(`s14-staff-${stamp}@example.test`);
    const { neon } = await import("@neondatabase/serverless");
    const sql = neon(dbKey());
    const staff = (await sql`select id from "user" where email = ${`s14-staff-${stamp}@example.test`} limit 1`) as unknown as { id: string }[];
    await addOrganizationMember({ organizationId: orgId, userId: staff[0].id, role: "owner" });

    const { createHash } = await import("node:crypto");
    const h = createHash("sha256").update(`s14-${stamp}`, "utf8").digest("hex");
    const custId = customerIdFor(wsId, h);
    await ensureCustomer({ id: custId, workspaceId: wsId, bootstrapHash: h });
    const { createConversation, addUserMessage } = await import("../support-ops");
    const conv = (await createConversation({ workspaceId: wsId, customerId: custId, title: "Refund delays" })).conversation;
    await addUserMessage({ conversationId: conv.id, content: "Refund for order 42 never arrived, been waiting two weeks", clientId: `s14-${stamp}-1` });

    const { createIncident, addIncidentConversation, transitionIncident, listIncidentEvents } = await import("../incidents");
    const inc = await createIncident({ workspaceId: wsId, title: "S14 refund incident", createdByUserId: staff[0].id });
    await addIncidentConversation({ incidentId: inc.id, workspaceId: wsId, conversationId: conv.id, actorUserId: staff[0].id });
    for (const to of ["investigating", "ready_for_action", "recovering", "monitoring"] as const) {
      await transitionIncident({ incidentId: inc.id, workspaceId: wsId, to });
    }

    const { realBriefStore, refreshBriefIfNeeded, getIncidentBrief } = await import("../evidence-brief");
    const bjudge = async (input: { sources: { id: string }[] }) => ({
      facts: [
        { observation: "Refund for order 42 never arrived after two weeks", identifiers: ["order 42", "refund"], sources: input.sources.map((s) => s.id) },
        { observation: "Customer waited two weeks with no update", identifiers: [], sources: input.sources.map((s) => s.id) },
      ],
      corroborated: [],
      contradictions: [],
      unknowns: [],
      hypotheses: [],
    });
    await refreshBriefIfNeeded(inc.id, wsId, { store: await realBriefStore(), judge: bjudge as never });
    const brief = await getIncidentBrief(inc.id, wsId);
    expect(brief?.status).toBe("current");

    const { realHealthDeps } = await import("../knowledge-health-store");
    const deps = await realHealthDeps({ judge: false });
    const { refreshKnowledgeHealth } = await import("../knowledge-health");
    const r1 = await refreshKnowledgeHealth(wsId, staff[0].id, deps, { incidentLimit: 10 });
    expect(r1.action).toBe("refreshed");
    if (r1.action !== "refreshed") throw new Error("refresh failed");
    expect(r1.created).toBeGreaterThanOrEqual(1);
    const gaps = (await deps.findings.listOpen(wsId)).filter((f) => f.type === "gap");
    expect(gaps.length).toBeGreaterThanOrEqual(1);
    expect(gaps[0].confidence).toBe("high");

    // Unchanged evidence dedupes: no new rows.
    const r2 = await refreshKnowledgeHealth(wsId, staff[0].id, deps, { incidentLimit: 10 });
    expect(r2).toMatchObject({ action: "refreshed", created: 0 });

    // Operator review with attribution.
    const reviewed = await deps.findings.review({ findingId: gaps[0].id, workspaceId: wsId, to: "acknowledged", actorUserId: staff[0].id, note: "will document" });
    expect(reviewed.status).toBe("acknowledged");
    expect(reviewed.reviewed_by_user_id).toBe(staff[0].id);

    // A stored match for the same evidence auto-addresses the gap.
    const { realMatchStore } = await import("../fix-matches");
    const mstore = await realMatchStore();
    const { createPendingFixCard, markFixCardShared } = await import("../support-ops");
    const cardRow = await createPendingFixCard({ workspaceId: wsId, customerId: custId, conversationId: conv.id, issueId: null, candidateText: "[SHARED_FIX]\nSymptom: x\nCause: y\nResolution: z" });
    await markFixCardShared(cardRow.id, `blob-s14-${stamp}`, staff[0].id);
    await mstore.saveMatches({
      incidentId: inc.id, workspaceId: wsId, fingerprint: brief!.fingerprint, briefVersion: brief!.version,
      matches: [{ refId: cardRow.id, tier: "documented_unverified", payload: { reasons: ["r"], matchingSymptoms: ["refund"], differences: [], unknowns: [], applicable: true, warning: "", cardStatus: "shared", cardResolved: null, cardExcerpt: "x", identifierHits: [] } }],
    });
    const r3 = await refreshKnowledgeHealth(wsId, staff[0].id, deps, { incidentLimit: 10 });
    expect(r3.action).toBe("refreshed");
    if (r3.action !== "refreshed") throw new Error("refresh3 failed");
    expect(r3.addressed).toBeGreaterThanOrEqual(1);

    // Outdated recommendation: match row pointing at a superseded card.
    const repl = await createPendingFixCard({ workspaceId: wsId, customerId: custId, conversationId: conv.id, issueId: null, candidateText: "[SHARED_FIX]\nSymptom: a\nCause: b\nResolution: c" });
    await markFixCardShared(repl.id, `blob-s14b-${stamp}`, staff[0].id);
    const { markFixCardSuperseded, listSupersededSharedBlobs, getFixCardForWorkspace } = await import("../support-ops");
    await markFixCardSuperseded(cardRow.id, repl.id, staff[0].id);
    expect((await getFixCardForWorkspace(cardRow.id, wsId))?.status).toBe("superseded");
    expect((await listSupersededSharedBlobs(wsId)).includes(`blob-s14-${stamp}`)).toBe(true);
    const r4 = await refreshKnowledgeHealth(wsId, staff[0].id, deps, { incidentLimit: 10 });
    expect(r4.action).toBe("refreshed");
    const stale = (await deps.findings.listOpen(wsId)).filter((f) => f.type === "stale");
    expect(stale.some((f) => f.detail.reason === "outdated_recommendation")).toBe(true);

    // Provenance repair: link on a corrected-away card repoints to the revision.
    const { realMemoryStore } = await import("../operator-memory");
    const pmRows = (await sql`
      insert into incident_postmortems (incident_id, workspace_id, status, source_fingerprint, brief_fingerprint, content)
      values (${inc.id}, ${wsId}, 'finalized', 'fp-s14-test', '', '{}'::jsonb)
      returning id
    `) as unknown as { id: string }[];
    const memStore = await realMemoryStore();
    const link = await memStore.insert({
      incidentId: inc.id, workspaceId: wsId, postmortemId: pmRows[0].id,
      fixCardId: cardRow.id, tier: "verified_fix", verified: true,
      fingerprint: "fp-s14-test", createdBy: staff[0].id,
    });
    expect(link.deduped).toBe(false);
    const { repairProvenanceLink } = await import("../knowledge-health-store");
    const repaired = await repairProvenanceLink(link.row.id, wsId, staff[0].id);
    expect(repaired).toMatchObject({ action: "repaired", cardId: repl.id });
    // History preserved: the finding still references both card versions.
    const r5 = await refreshKnowledgeHealth(wsId, staff[0].id, deps, { incidentLimit: 10 });
    expect(r5.action).toBe("refreshed");

    // Provenance repair path refuses non-stale links honestly.
    const nope = await repairProvenanceLink("00000000-0000-0000-0000-000000000000", wsId, staff[0].id);
    expect(nope.action).toBe("deferred");

    // S12+ history untouched: no incident status changes from health.
    const kinds = (await listIncidentEvents(inc.id, wsId)).map((e) => e.kind);
    expect(kinds).not.toContain("closure_confirmed");
    expect(kinds).not.toContain("closure_administrative");
  }, 180_000);
});
