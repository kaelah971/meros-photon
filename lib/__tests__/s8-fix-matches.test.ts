import { describe, expect, it, afterAll, vi } from "vitest";
import {
  buildRecallQuery,
  extractSignals,
  prefilterCandidates,
  refreshMatchesIfNeeded,
  tierFor,
  validateMatchJudgment,
  type BriefSignals,
  type MatchBrief,
  type MatchCard,
  type MatchDeps,
  type MatchRow,
  type MatchStore,
} from "../fix-matches";
import { isEvidenceAutoNotifyEnabled } from "../photon/preferences";
import { POST as refreshPOST } from "@/app/api/incidents/[id]/fix-matches/refresh/route";

// next/headers has no request scope in tests: control the cookie jar here.
let cookieJar = "";
vi.mock("next/headers", () => ({
  headers: async () => new Headers(cookieJar ? { cookie: cookieJar } : {}),
}));

const BRIEF: MatchBrief = {
  status: "current",
  version: 3,
  fingerprint: "fp-current",
  findings: {
    facts: [
      {
        observation: "Visa checkout returns HTTP 500 on pay",
        identifiers: ["500", "Visa"],
        sources: ["m1", "m2"],
      },
      {
        observation: "Second attempt fails the same way within a minute",
        identifiers: [],
        sources: ["m1"],
      },
    ],
    corroborated: [{ pattern: "Same 500 on Visa checkout", sources: ["m1", "m2"] }],
    contradictions: [],
    unknowns: ["Root cause unknown"],
    hypotheses: [{ text: "Might be a gateway timeout", basedOn: ["m1"] }],
  },
  source_count: 3,
  generated_at: "2026-10-18T12:00:00.000Z",
};

function cardOf(partial: Partial<MatchCard> = {}): MatchCard {
  return {
    id: "card-1",
    status: "shared",
    text: "Symptom: Visa checkout returns HTTP 500. Cause: gateway timeout. Resolution: retried with idempotency key; confirmed fixed.",
    resolved: true,
    createdAt: "2026-10-10T12:00:00.000Z",
    blobId: "blob-1",
    ...partial,
  };
}

describe("signal extraction (pure)", () => {
  it("lowercases and dedupes identifiers, filters generic words", () => {
    const s = extractSignals(BRIEF);
    expect(s.identifiers).toEqual(["500", "visa"]);
    // Generic words never become signals (checkout/payment are stopwords).
    expect(s.symptomTerms).not.toContain("payment");
    expect(s.symptomTerms).not.toContain("checkout");
    expect(s.symptomTerms).toContain("returns");
    expect(s.observations).toHaveLength(2);
  });

  it("generic-only briefs yield weak signals (no strong match possible)", () => {
    const generic: MatchBrief = {
      ...BRIEF,
      findings: {
        facts: [{ observation: "Payment failed for my order", identifiers: [], sources: ["m1"] }],
        corroborated: [],
        contradictions: [],
        unknowns: [],
        hypotheses: [],
      },
    };
    const s = extractSignals(generic);
    expect(s.identifiers).toHaveLength(0);
    // "payment failed order" are all stopwords/short → nothing specific.
    expect(s.symptomTerms).not.toContain("payment");
    expect(s.symptomTerms).not.toContain("failed");
  });
});

describe("recall query (pure)", () => {
  it("is deterministic and identifiers-first", () => {
    const s = extractSignals(BRIEF);
    const a = buildRecallQuery(s);
    const b = buildRecallQuery(s);
    expect(a).toBe(b);
    expect(a.startsWith("500 visa")).toBe(true);
    expect(a.length).toBeLessThanOrEqual(500);
  });

  it("is empty when the brief carries no usable signal", () => {
    expect(buildRecallQuery({ identifiers: [], symptomTerms: [], observations: [] })).toBe("");
  });
});

describe("prefilter (pure)", () => {
  it("passes specific identifier overlap as a strong candidate", () => {
    const s = extractSignals(BRIEF);
    const out = prefilterCandidates(s, [cardOf()]);
    expect(out).toHaveLength(1);
    expect(out[0].identifierHits).toContain("500");
  });

  it("rejects generic-only overlap (no strong match from common words)", () => {
    const generic: MatchBrief = {
      ...BRIEF,
      findings: {
        facts: [{ observation: "Payment failed for my order", identifiers: [], sources: ["m1"] }],
        corroborated: [],
        contradictions: [],
        unknowns: [],
        hypotheses: [],
      },
    };
    const s = extractSignals(generic);
    const unrelated = cardOf({
      id: "card-9",
      text: "Symptom: payment failed for order. Cause: unknown. Resolution: asked customer to retry.",
    });
    expect(prefilterCandidates(s, [unrelated])).toHaveLength(0);
  });

  it("passes converging multi-symptom overlap without identifiers", () => {
    const s: BriefSignals = {
      identifiers: [],
      symptomTerms: ["checkout", "returns", "minute", "attempt"],
      observations: [],
    };
    const card = cardOf({
      text: "Checkout returns an error on second attempt within a minute; retry the checkout attempt after a minute.",
    });
    const out = prefilterCandidates(s, [card]);
    expect(out).toHaveLength(1);
  });

  it("ranks by score and caps the judge shortlist", () => {
    const s = extractSignals(BRIEF);
    const cards = Array.from({ length: 8 }, (_, i) =>
      cardOf({ id: `card-${i}`, text: `Visa 500 checkout failure case ${i} visa 500` }),
    );
    expect(prefilterCandidates(s, cards)).toHaveLength(5);
  });
});

describe("tier mapping (pure)", () => {
  it("verified only for shared + resolved + likely", () => {
    expect(tierFor(cardOf(), "likely")).toBe("verified_fix");
    expect(tierFor(cardOf({ resolved: false }), "likely")).toBe("documented_unverified");
    expect(tierFor(cardOf({ resolved: null }), "likely")).toBe("documented_unverified");
    expect(tierFor(cardOf({ status: "kept_private" }), "likely")).toBe("documented_unverified");
    expect(tierFor(cardOf(), "possible")).toBe("possible_match");
    expect(tierFor(cardOf({ status: "kept_private" }), "possible")).toBe("possible_match");
    expect(tierFor(cardOf(), "none")).toBeNull();
  });
});

describe("judgment validation (pure)", () => {
  const allowed = new Map([
    ["card-1", { cardText: "Visa checkout returns HTTP 500 on pay" }],
    ["card-2", { cardText: "Refund issued for duplicate charge" }],
  ]);
  const corpus = "visa checkout returns http 500 on pay refund issued for duplicate charge";

  function good() {
    return {
      matches: [
        {
          ref: "card-1",
          relevance: "likely",
          reasons: ["Observation reports HTTP 500 on Visa; candidate mentions 500 on Visa capture"],
          matchingSymptoms: ["visa checkout returns http 500"],
          differences: ["candidate was a capture call, current is pay"],
          unknowns: ["whether the gateway is the same"],
          applicable: false,
          warning: "candidate fixed capture 500s; current evidence shows pay 500s",
        },
      ],
    };
  }

  it("accepts grounded findings", () => {
    expect(validateMatchJudgment(good(), allowed, corpus)).toHaveLength(1);
  });

  it("drops invented references and unsupported claims", () => {
    const raw = {
      matches: [
        { ...good().matches[0], ref: "card-ghost" },
        { ref: "card-1", relevance: "likely", reasons: [], matchingSymptoms: ["visa"], differences: [], unknowns: [], applicable: true, warning: "" },
        { ref: "card-1", relevance: "likely", reasons: ["ok"], matchingSymptoms: ["martian xyz"], differences: [], unknowns: [], applicable: true, warning: "" },
        { ref: "card-2", relevance: "none", reasons: ["x"], matchingSymptoms: ["refund"], differences: [], unknowns: [], applicable: true, warning: "" },
      ],
    };
    expect(validateMatchJudgment(raw, allowed, corpus)).toHaveLength(0);
  });

  it("requires a warning when not applicable", () => {
    const raw = {
      matches: [
        { ref: "card-1", relevance: "possible", reasons: ["shared token 500"], matchingSymptoms: ["500"], differences: [], unknowns: [], applicable: false, warning: "" },
      ],
    };
    expect(validateMatchJudgment(raw, allowed, corpus)).toHaveLength(0);
  });

  it("fails closed on malformed output", () => {
    expect(validateMatchJudgment(null, allowed, corpus)).toEqual([]);
    expect(validateMatchJudgment({ matches: "nope" }, allowed, corpus)).toEqual([]);
    expect(validateMatchJudgment({ noMatches: [] }, allowed, corpus)).toEqual([]);
  });
});

// ---- Orchestration with fakes (no AI, no Walrus, no Neon) ----

function makeStore(cards: MatchCard[] = []) {
  const rows: MatchRow[] = [];
  let n = 0;
  const store: MatchStore = {
    loadForBrief: async (incidentId, workspaceId, fingerprint) =>
      rows.filter(
        (r) => r.incident_id === incidentId && r.workspace_id === workspaceId && r.brief_fingerprint === fingerprint,
      ),
    loadLatest: async (incidentId, workspaceId) => {
      const mine = rows.filter((r) => r.incident_id === incidentId && r.workspace_id === workspaceId);
      if (mine.length === 0) return null;
      const fp = mine[mine.length - 1].brief_fingerprint;
      const group = mine.filter((r) => r.brief_fingerprint === fp);
      return { fingerprint: fp, briefVersion: group[0].brief_version, rows: group };
    },
    saveMatches: async (input) => {
      for (const m of input.matches) {
        const exists = rows.some(
          (r) =>
            r.incident_id === input.incidentId &&
            r.brief_fingerprint === input.fingerprint &&
            r.ref_id === m.refId,
        );
        if (exists) continue; // ON CONFLICT DO NOTHING
        n++;
        rows.push({
          id: `match-${n}`,
          incident_id: input.incidentId,
          workspace_id: input.workspaceId,
          brief_fingerprint: input.fingerprint,
          brief_version: input.briefVersion,
          ref_kind: "fix_card",
          ref_id: m.refId,
          tier: m.tier,
          payload: m.payload,
          generated_at: new Date().toISOString(),
        });
      }
    },
    loadCards: async (workspaceId) => (workspaceId === "ws-1" ? cards : []),
    resolveCardsByBlobs: async (workspaceId, blobIds) => {
      const out = new Map<string, MatchCard>();
      if (workspaceId !== "ws-1") return out; // other tenants never resolve
      for (const c of cards) {
        if (c.blobId && blobIds.includes(c.blobId)) out.set(c.blobId, c);
      }
      return out;
    },
  };
  return { store, rows };
}

function goodJudge(cardId = "card-1") {
  return async () => ({
    matches: [
      {
        ref: cardId,
        relevance: "likely",
        reasons: ["Brief reports HTTP 500 on Visa checkout; card records 500 on Visa checkout with a gateway-timeout cause"],
        matchingSymptoms: ["visa checkout returns http 500"],
        differences: [],
        unknowns: ["Root cause unknown"],
        applicable: true,
        warning: "",
      },
    ],
  });
}

function makeDeps(opts: {
  brief?: MatchBrief | null;
  cards?: MatchCard[];
  recall?: MatchDeps["recall"];
  judge?: MatchDeps["judge"];
  workspaceId?: string;
} = {}) {
  const { store, rows } = makeStore(opts.cards ?? [cardOf()]);
  let judgeCalls = 0;
  let recallCalls = 0;
  let recallQueries: string[] = [];
  const deps: MatchDeps = {
    loadBrief: async () => ("brief" in opts ? (opts.brief ?? null) : BRIEF),
    store,
    recall: async (q) => {
      recallCalls++;
      recallQueries.push(q);
      if (opts.recall) return opts.recall(q);
      return [];
    },
    judge: async (input) => {
      judgeCalls++;
      return (opts.judge ?? goodJudge())(input);
    },
  };
  return {
    deps,
    rows,
    calls: () => ({ judgeCalls, recallCalls, recallQueries }),
    input: { incidentId: "inc-1", workspaceId: opts.workspaceId ?? "ws-1" },
  };
}

describe("refresh orchestration (fakes)", () => {
  it("builds verified matches on a current brief", async () => {
    const { deps, input, rows, calls } = makeDeps();
    const r = await refreshMatchesIfNeeded(input.incidentId, input.workspaceId, deps);
    expect(r).toEqual({ action: "built", count: 1 });
    expect(rows[0].tier).toBe("verified_fix");
    expect(rows[0].payload.reasons.length).toBeGreaterThan(0);
    expect(calls().judgeCalls).toBe(1);
  });

  it("skips recompute when the fingerprint is unchanged", async () => {
    const { deps, input, calls } = makeDeps();
    expect((await refreshMatchesIfNeeded(input.incidentId, input.workspaceId, deps)).action).toBe("built");
    expect((await refreshMatchesIfNeeded(input.incidentId, input.workspaceId, deps)).action).toBe("unchanged");
    expect(calls().judgeCalls).toBe(1);
  });

  it("rebuilds on fingerprint change and keeps history", async () => {
    const { deps, input, rows } = makeDeps();
    expect((await refreshMatchesIfNeeded(input.incidentId, input.workspaceId, deps)).action).toBe("built");
    const v2: MatchBrief = { ...BRIEF, fingerprint: "fp-v2", version: 4 };
    const r2 = await refreshMatchesIfNeeded(input.incidentId, input.workspaceId, {
      ...deps,
      loadBrief: async () => v2,
    });
    expect(r2.action).toBe("built");
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.brief_fingerprint))).toEqual(new Set(["fp-current", "fp-v2"]));
  });

  it("defers on missing or non-current briefs without touching AI", async () => {
    for (const brief of [null, { ...BRIEF, status: "pending" }, { ...BRIEF, status: "stale" }] as const) {
      const { deps, input, calls } = makeDeps({ brief });
      const r = await refreshMatchesIfNeeded(input.incidentId, input.workspaceId, deps);
      expect(r.action).toBe("deferred");
      expect(calls().judgeCalls).toBe(0);
      expect(calls().recallCalls).toBe(0);
    }
  });

  it("reports no_match when no cards exist (no invented matches)", async () => {
    const { deps, input, calls } = makeDeps({ cards: [] });
    expect(await refreshMatchesIfNeeded(input.incidentId, input.workspaceId, deps)).toEqual({
      action: "no_match",
    });
    expect(calls().judgeCalls).toBe(0);
  });

  it("reports no_signals for generic-only evidence without calling the judge", async () => {
    const generic: MatchBrief = {
      ...BRIEF,
      findings: {
        facts: [{ observation: "Payment failed for my order", identifiers: [], sources: ["m1"] }],
        corroborated: [],
        contradictions: [],
        unknowns: [],
        hypotheses: [],
      },
    };
    const { deps, input, calls } = makeDeps({
      brief: generic,
      cards: [cardOf({ text: "Payment failed for order; asked customer to retry." })],
    });
    expect(await refreshMatchesIfNeeded(input.incidentId, input.workspaceId, deps)).toEqual({
      action: "no_signals",
    });
    expect(calls().judgeCalls).toBe(0);
  });

  it("degrades to Neon-only matching when recall fails", async () => {
    const { deps, input } = makeDeps({
      recall: async () => {
        throw new Error("walrus down");
      },
    });
    const r = await refreshMatchesIfNeeded(input.incidentId, input.workspaceId, deps);
    expect(r.action).toBe("built");
  });

  it("enriches with workspace-resolved shared hits, drops foreign blobs", async () => {
    const shared = cardOf({ id: "card-shared", blobId: "blob-shared", text: "Visa 500 at checkout; retried safely." });
    const { deps, input, rows } = makeDeps({
      cards: [shared],
      recall: async () => [
        { text: "other tenant shared fix", blobId: "blob-foreign" },
        { text: "own shared fix", blobId: "blob-shared" },
      ],
      judge: async () => ({
        matches: [
          {
            ref: "card-shared",
            relevance: "likely",
            reasons: ["Brief identifiers 500 and visa both appear in the card text"],
            matchingSymptoms: ["visa 500"],
            differences: [],
            unknowns: [],
            applicable: true,
            warning: "",
          },
        ],
      }),
    });
    const r = await refreshMatchesIfNeeded(input.incidentId, input.workspaceId, deps);
    expect(r.action).toBe("built");
    // Foreign blob resolves to nothing in this workspace: only own card stored.
    expect(rows.map((x) => x.ref_id)).toEqual(["card-shared"]);
  });

  it("judge failure stores nothing and preserves prior rows", async () => {
    const { deps, input, rows } = makeDeps({
      judge: async () => {
        throw new Error("model down");
      },
    });
    const r = await refreshMatchesIfNeeded(input.incidentId, input.workspaceId, deps);
    expect(r.action).toBe("failed");
    expect(rows).toHaveLength(0);
  });

  it("drops contradicted candidates the judge marks none", async () => {
    const { deps, input, rows } = makeDeps({
      cards: [cardOf({ id: "card-1" }), cardOf({ id: "card-2", text: "Visa 500 on refund leg; reversed." })],
      judge: async () => ({
        matches: [
          {
            ref: "card-1",
            relevance: "likely",
            reasons: ["Shared 500 on Visa checkout in both"],
            matchingSymptoms: ["visa checkout returns http 500"],
            differences: [],
            unknowns: [],
            applicable: true,
            warning: "",
          },
          {
            ref: "card-2",
            relevance: "none",
            reasons: ["Refund-leg 500 contradicts pay-leg 500 pattern"],
            matchingSymptoms: [],
            differences: ["different leg"],
            unknowns: [],
            applicable: false,
            warning: "different failure leg",
          },
        ],
      }),
    });
    const r = await refreshMatchesIfNeeded(input.incidentId, input.workspaceId, deps);
    expect(r).toEqual({ action: "built", count: 1 });
    expect(rows.map((x) => x.ref_id)).toEqual(["card-1"]);
  });

  it("concurrent same-fingerprint refreshes run the judge once", async () => {
    const { deps, input, calls } = makeDeps({
      judge: async (x) => {
        await new Promise((r) => setTimeout(r, 20));
        return goodJudge()(x);
      },
    });
    const [a, b] = await Promise.all([
      refreshMatchesIfNeeded(input.incidentId, input.workspaceId, deps),
      refreshMatchesIfNeeded(input.incidentId, input.workspaceId, deps),
    ]);
    expect([a.action, b.action].sort()).toEqual(["built", "in_progress"]);
    expect(calls().judgeCalls).toBe(1);
  });

  it("isolates workspaces: foreign workspace sees no rows", async () => {
    const { deps } = makeDeps({ cards: [cardOf()], workspaceId: "ws-foreign" });
    const r = await refreshMatchesIfNeeded("inc-1", "ws-foreign", deps);
    expect(r).toEqual({ action: "no_match" });
  });

  it("never touches private namespaces by construction", async () => {
    const { deps, input } = makeDeps();
    await refreshMatchesIfNeeded(input.incidentId, input.workspaceId, deps);
    // MatchDeps exposes only shared-namespace recall; there is no private
    // recall channel in the dependency surface at all.
    expect("recallPrivate" in deps).toBe(false);
    expect(Object.keys(deps).sort()).toEqual(["judge", "loadBrief", "recall", "store"]);
  });
});

describe("refresh route authorization", () => {
  it("anonymous callers get 401 without touching data", async () => {
    cookieJar = "";
    const res = await refreshPOST(
      new Request("http://test/api/x/fix-matches/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceSlug: "northstar" }),
      }),
      { params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000" }) },
    );
    expect(res.status).toBe(401);
  }, 30_000);
});

describe("proactive notification boundary (S7 foundation untouched)", () => {
  it("auto-notify stays default-disabled; matching never sends", async () => {
    expect(await isEvidenceAutoNotifyEnabled("ws-none", "op-none")).toBe(false);
  });
});

// ---- Live persistence: real store round-trip + stale invalidation ----

const stamp = Date.now().toString(36);
const PW = "correct-horse-123";
const createdEmails: string[] = [];
const createdOrgIds: string[] = [];
const SLUG = `s8-ws-${stamp}`;

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

describe("match persistence (live Neon)", () => {
  it("stores tiered rows per fingerprint and keeps history across refreshes", async () => {
    const { organizationIdForSlug, workspaceIdForSlug } = await import("../tenant");
    const { ensureOrganization, ensureWorkspace, addOrganizationMember } = await import("../db");
    const orgId = organizationIdForSlug(SLUG);
    await ensureOrganization({ id: orgId, slug: SLUG, name: `Temp ${SLUG}` });
    const wsId = workspaceIdForSlug(SLUG);
    await ensureWorkspace({ id: wsId, organizationId: orgId, slug: SLUG, name: `Temp ${SLUG}` });
    createdOrgIds.push(orgId);
    cookieJar = await signupSession(`s8-staff-${stamp}@example.test`);
    const { neon } = await import("@neondatabase/serverless");
    const sql = neon(dbKey());
    const staff = (await sql`select id from "user" where email = ${`s8-staff-${stamp}@example.test`} limit 1`) as unknown as {
      id: string;
    }[];
    await addOrganizationMember({ organizationId: orgId, userId: staff[0].id, role: "owner" });

    // Real customer + conversation + resolved issue + shared card (staff-approved history).
    const { createHash } = await import("node:crypto");
    const { ensureCustomer } = await import("../db");
    const h = createHash("sha256").update(`s8-cust-${stamp}`, "utf8").digest("hex");
    const { customerIdFor } = await import("../tenant");
    const custId = customerIdFor(wsId, h);
    await ensureCustomer({ id: custId, workspaceId: wsId, bootstrapHash: h });
    const { createConversation, createPendingFixCard, markFixCardShared } = await import("../support-ops");
    const { conversation } = await createConversation({ workspaceId: wsId, customerId: custId, title: "Visa 500s" });
    const issueRows = (await sql`select id from support_issues where conversation_id = ${conversation.id} limit 1`) as unknown as {
      id: string;
    }[];
    await sql`update support_issues set status = 'resolved', resolution_summary = 'retried idempotently' where id = ${issueRows[0].id}`;
    const card = await createPendingFixCard({
      workspaceId: wsId,
      customerId: custId,
      conversationId: conversation.id,
      issueId: issueRows[0].id,
      candidateText: "Symptom: Visa checkout returns HTTP 500. Cause: gateway timeout. Resolution: retried with idempotency key.",
    });
    await markFixCardShared(card.id, `blob-s8-${stamp}`, staff[0].id);

    const { createIncident } = await import("../incidents");
    const inc = await createIncident({ workspaceId: wsId, title: "S8 live incident", createdByUserId: staff[0].id });

    const { realMatchStore, refreshMatchesIfNeeded } = await import("../fix-matches");
    const store = await realMatchStore();
    const judgeFor = (ref: string) => async () => ({
      matches: [
        {
          ref,
          relevance: "likely",
          reasons: ["Brief reports HTTP 500 on Visa; card records 500 on Visa with gateway-timeout cause"],
          matchingSymptoms: ["visa checkout returns http 500"],
          differences: [],
          unknowns: ["Root cause unknown"],
          applicable: true,
          warning: "",
        },
      ],
    });
    const noRecall = async () => [];

    const briefV1 = { ...BRIEF, fingerprint: `fp-s8a-${stamp}`, version: 1 };
    const r1 = await refreshMatchesIfNeeded(inc.id, wsId, {
      loadBrief: async () => briefV1,
      store,
      recall: noRecall,
      judge: judgeFor(card.id),
    });
    expect(r1).toEqual({ action: "built", count: 1 });
    const stored1 = await store.loadForBrief(inc.id, wsId, briefV1.fingerprint);
    expect(stored1).toHaveLength(1);
    expect(stored1[0].tier).toBe("verified_fix");
    expect(stored1[0].payload.cardResolved).toBe(true);

    // Recompute is a no-op for unchanged evidence.
    const rSame = await refreshMatchesIfNeeded(inc.id, wsId, {
      loadBrief: async () => briefV1,
      store,
      recall: noRecall,
      judge: judgeFor(card.id),
    });
    expect(rSame).toEqual({ action: "unchanged" });

    // New evidence fingerprint rebuilds; history is preserved.
    const briefV2 = { ...BRIEF, fingerprint: `fp-s8b-${stamp}`, version: 2 };
    const r2 = await refreshMatchesIfNeeded(inc.id, wsId, {
      loadBrief: async () => briefV2,
      store,
      recall: noRecall,
      judge: judgeFor(card.id),
    });
    expect(r2).toEqual({ action: "built", count: 1 });
    const latest = await store.loadLatest(inc.id, wsId);
    expect(latest?.fingerprint).toBe(briefV2.fingerprint);
    const count = (await sql`select count(*)::int as n from incident_fix_matches where incident_id = ${inc.id}`) as unknown as {
      n: number;
    }[];
    expect(count[0].n).toBe(2);
    // No per-test deletes: the afterAll organization delete cascades through
    // workspaces -> incidents/cards -> match rows (test-hygiene rule).
  }, 120_000);
});
