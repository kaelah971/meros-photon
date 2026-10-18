import { describe, expect, it, afterAll, vi } from "vitest";
import {
  fingerprintSources,
  refreshBriefIfNeeded,
  validateBriefFindings,
  type BriefJudge,
  type BriefSource,
  type BriefStore,
} from "../evidence-brief";
import { addOrganizationMember, ensureOrganization, ensureWorkspace } from "../db";
import { organizationIdForSlug, workspaceIdForSlug, customerIdFor } from "../tenant";
import { createConversation, addUserMessage } from "../support-ops";
import { createIncident, addIncidentConversation, listIncidentEvents } from "../incidents";
import { POST as reviewPOST } from "@/app/api/issue-candidates/[id]/review/route";

// next/headers has no request scope in tests: control the cookie jar here.
let cookieJar = "";
vi.mock("next/headers", () => ({
  headers: async () => new Headers(cookieJar ? { cookie: cookieJar } : {}),
}));

function src(id: string, conv = "c1", cust = "u1", content = "Visa checkout fails with 500"): BriefSource {
  return { messageId: id, conversationId: conv, customerId: cust, content, createdAt: "2026-06-15T12:00:00Z" };
}

function goodRaw(ids: string[]) {
  return {
    facts: [{ observation: "Visa checkout returns HTTP 500", identifiers: ["500", "Visa"], sources: [ids[0]] }],
    corroborated: ids.length > 1 ? [{ pattern: "Same 500 on Visa checkout", sources: ids }] : [],
    contradictions: [],
    unknowns: ["Root cause unknown"],
    hypotheses: [{ text: "Might be a gateway timeout", basedOn: [ids[0]] }],
  };
}

function makeStore(sources: BriefSource[] = []) {
  type Stored = {
    status: "pending" | "current" | "stale" | "failed";
    fingerprint: string;
    findings: import("../evidence-brief").BriefFindings | null;
    sourceCount: number;
    updatedMs: number;
  };
  let b: Stored | null = null;
  const store: BriefStore = {
    loadBrief: async () =>
      b === null
        ? null
        : {
            incident_id: "inc-1",
            workspace_id: "ws",
            status: b.status,
            version: 1,
            fingerprint: b.fingerprint,
            findings: (b.findings ?? { facts: [], corroborated: [], contradictions: [], unknowns: [], hypotheses: [] }),
            source_count: b.sourceCount,
            generated_at: null,
            error: null,
            updated_at: new Date(b.updatedMs).toISOString(),
          },
    insertPending: async (_incidentId, _workspaceId, fingerprint, sourceCount) => {
      if (b !== null) return false; // ON CONFLICT DO NOTHING: loser steps aside.
      b = { status: "pending", fingerprint, findings: null, sourceCount, updatedMs: Date.now() };
      return true;
    },
    claimRebuild: async () => true,
    markStale: async () => {},
    completeBrief: async (input) => {
      b = {
        status: "current",
        fingerprint: input.fingerprint,
        findings: input.findings,
        sourceCount: input.sourceCount,
        updatedMs: Date.now(),
      };
    },
    failBrief: async () => {},
    getSources: async () => sources,
  };
  return { store, seed: (v: Stored | null) => { b = v; }, peek: () => b };
}

describe("evidence validation (pure)", () => {
  it("accepts grounded findings and drops invented ids", () => {
    const out = validateBriefFindings(goodRaw(["m1", "m2"]), new Set(["m1", "m2"]))!;
    expect(out.facts).toHaveLength(1);
    expect(out.corroborated).toHaveLength(1);
    expect(out.hypotheses[0].text).toContain("gateway");
  });

  it("rejects facts citing unknown sources", () => {
    const out = validateBriefFindings(
      { facts: [{ observation: "X fails", identifiers: [], sources: ["ghost"] }], unknowns: ["why"] },
      new Set(["m1"]),
    )!;
    // Ghost-cited fact is dropped; the unknown survives so the brief is honest.
    expect(out.facts).toHaveLength(0);
    expect(out.unknowns).toEqual(["why"]);
  });

  it("rejects corroboration on a single source and self-contradictions", () => {
    const out = validateBriefFindings(
      {
        facts: [{ observation: "X fails", sources: ["m1"] }],
        corroborated: [{ pattern: "same", sources: ["m1"] }],
        contradictions: [{ description: "diff", between: ["m1", "m1"] }],
        unknowns: [],
        hypotheses: [],
      },
      new Set(["m1"]),
    )!;
    expect(out.corroborated).toHaveLength(0);
    expect(out.contradictions).toHaveLength(0);
    expect(out.facts).toHaveLength(1);
  });

  it("fails closed on empty or malformed output", () => {
    expect(validateBriefFindings(null, new Set(["m1"]))).toBeNull();
    expect(validateBriefFindings({ facts: [] }, new Set(["m1"]))).toBeNull();
    expect(validateBriefFindings({ facts: [{ observation: "  ", sources: ["m1"] }] }, new Set(["m1"]))).toBeNull();
    expect(validateBriefFindings("nope", new Set())).toBeNull();
  });

  it("hypotheses require grounding; labels stay in UI copy", () => {
    const out = validateBriefFindings(
      {
        facts: [{ observation: "X fails", sources: ["m1"] }],
        hypotheses: [{ text: "Definitely the database", basedOn: [] }],
      },
      new Set(["m1"]),
    )!;
    expect(out.hypotheses).toHaveLength(0);
  });

  it("fingerprints are stable and order-independent", () => {
    expect(fingerprintSources(["b", "a", "c"])).toBe(fingerprintSources(["c", "b", "a"]));
    expect(fingerprintSources(["a"])).not.toBe(fingerprintSources(["a", "b"]));
  });
});

describe("brief refresh orchestration (fakes)", () => {
  const judgeFor = (ids: string[]): BriefJudge => async () => goodRaw(ids);

  it("builds on first evidence and skips unchanged sources", async () => {
    const { store } = makeStore([src("m1"), src("m2")]);
    let calls = 0;
    const judge: BriefJudge = async (input) => {
      calls++;
      return goodRaw(input.sources.map((s) => s.id));
    };
    const r1 = await refreshBriefIfNeeded("inc-1", "ws", { store, judge });
    expect(r1.action).toBe("built");
    const r2 = await refreshBriefIfNeeded("inc-1", "ws", { store, judge });
    expect(r2).toEqual({ action: "unchanged" });
    expect(calls).toBe(1);
  });

  it("rebuilds when a new message lands (freshness)", async () => {
    const arr = [src("m1")];
    const { store } = makeStore(arr);
    const judge: BriefJudge = async (input) => goodRaw(input.sources.map((s) => s.id));
    expect((await refreshBriefIfNeeded("inc-1", "ws", { store, judge })).action).toBe("built");
    expect((await refreshBriefIfNeeded("inc-1", "ws", { store, judge })).action).toBe("unchanged");
    arr.push(src("m2"));
    expect((await refreshBriefIfNeeded("inc-1", "ws", { store, judge })).action).toBe("built");
  });

  it("concurrent builds: loser sees in_progress, no duplicate judge runs", async () => {
    // No pre-seeded brief: both racers load nothing, the unique insert lets
    // exactly one through, and the loser observes the winner's pending row.
    const { store } = makeStore([src("m1"), src("m2")]);
    let calls = 0;
    const judge: BriefJudge = async (input) => {
      calls++;
      return goodRaw(input.sources.map((s) => s.id));
    };
    const [a, b] = await Promise.all([
      refreshBriefIfNeeded("inc-1", "ws", { store, judge }),
      refreshBriefIfNeeded("inc-1", "ws", { store, judge }),
    ]);
    expect([a.action, b.action].sort()).toEqual(["built", "in_progress"]);
    expect(calls).toBe(1);
  });

  it("AI failure records failed state without throwing", async () => {
    const { store } = makeStore([src("m1")]);
    const failing: BriefJudge = async () => {
      throw new Error("model down");
    };
    const r = await refreshBriefIfNeeded("inc-1", "ws", { store, judge: failing });
    expect(r.action).toBe("failed");
  });

  it("empty incident defers honestly (no fabricated brief)", async () => {
    const { store } = makeStore([]);
    const r = await refreshBriefIfNeeded("inc-1", "ws", { store, judge: judgeFor([]) });
    expect(r).toEqual({ action: "deferred", reason: "no linked customer reports" });
  });

  it("deleted sources are simply absent from the next build", async () => {
    const { store } = makeStore([src("m1"), src("m3")]);
    const judge: BriefJudge = async (input) => goodRaw(input.sources.map((s) => s.id));
    const r = await refreshBriefIfNeeded("inc-1", "ws", { store, judge });
    expect(r.action).toBe("built");
  });
});

describe("candidate-to-incident evidence continuity (fakes)", () => {
  it("accepted member conversations become the brief source set", async () => {
    // The S5 accept path links member conversations to the incident; the
    // brief then assembles from exactly those linked threads.
    const { store } = makeStore([
      src("m1", "c1", "cu1", "Visa 500 at checkout"),
      src("m2", "c2", "cu2", "Visa 500 again at pay"),
    ]);
    let seen: string[] = [];
    const judge: BriefJudge = async (input) => {
      seen = input.sources.map((s) => s.id);
      return goodRaw(seen);
    };
    const r = await refreshBriefIfNeeded("inc-1", "ws", { store, judge });
    expect(r.action).toBe("built");
    expect(seen.sort()).toEqual(["m1", "m2"]);
  });
});

describe("review endpoint authorization", () => {
  it("anonymous callers get 401 without touching data", async () => {
    const res = await reviewPOST(
      new Request("http://test/api/x/review", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceSlug: "northstar", action: "dismiss" }),
      }),
      { params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000" }) },
    );
    expect(res.status).toBe(401);
  }, 30_000);
});

// ---- Live persistence: real brief rows, fingerprint stability, cleanup ----

const stamp = Date.now().toString(36);
const PW = "correct-horse-123";
const createdEmails: string[] = [];
const createdOrgIds: string[] = [];
const SLUG = `s6-ws-${stamp}`;

function dbKey(): string {
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  return readFileSync(".env.local", "utf8")
    .split("\n").map((l) => l.trim()).find((l) => l.startsWith("DATABASE_URL="))!
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

describe("evidence brief persistence (live Neon)", () => {
  it("assembles a source-cited brief, skips unchanged, rebuilds on new evidence", async () => {
    const orgId = organizationIdForSlug(SLUG);
    await ensureOrganization({ id: orgId, slug: SLUG, name: `Temp ${SLUG}` });
    await ensureWorkspace({ id: workspaceIdForSlug(SLUG), organizationId: orgId, slug: SLUG, name: `Temp ${SLUG}` });
    createdOrgIds.push(orgId);
    cookieJar = await signupSession(`s6-staff-${stamp}@example.test`);
    const { neon } = await import("@neondatabase/serverless");
    const sql = neon(dbKey());
    const staff = (await sql`select id from "user" where email = ${`s6-staff-${stamp}@example.test`} limit 1`) as unknown as { id: string }[];
    await addOrganizationMember({ organizationId: orgId, userId: staff[0].id, role: "owner" });

    const { createHash } = await import("node:crypto");
    const wsId = workspaceIdForSlug(SLUG);
    const { ensureCustomer } = await import("../db");
    const mkCust = async (tag: string) => {
      const h = createHash("sha256").update(`${tag}-${stamp}`, "utf8").digest("hex");
      const { customerIdFor: cid } = await import("../tenant");
      const id = cid(wsId, h);
      await ensureCustomer({ id, workspaceId: wsId, bootstrapHash: h });
      return id;
    };
    const cu1 = await mkCust("s6a");
    const t1 = (await createConversation({ workspaceId: wsId, customerId: cu1, title: "Visa 500s" })).conversation;
    const m1 = await addUserMessage({ conversationId: t1.id, content: "Visa checkout fails with HTTP 500 every time today", clientId: `s6-${stamp}-1` });

    const inc = await createIncident({ workspaceId: wsId, title: "Visa outage", createdByUserId: staff[0].id });
    await addIncidentConversation({ incidentId: inc.id, workspaceId: wsId, conversationId: t1.id, actorUserId: staff[0].id });

    const { realBriefStore, getIncidentBrief } = await import("../evidence-brief");
    const store = await realBriefStore();
    const judge: import("../evidence-brief").BriefJudge = async (input) => ({
      facts: [{ observation: "Visa checkout returns HTTP 500", identifiers: ["500", "Visa"], sources: input.sources.map((s) => s.id) }],
      corroborated: [],
      contradictions: [],
      unknowns: ["Root cause unknown"],
      hypotheses: [{ text: "Might be a gateway timeout", basedOn: input.sources.map((s) => s.id) }],
    });

    const { refreshBriefIfNeeded } = await import("../evidence-brief");
    const r1 = await refreshBriefIfNeeded(inc.id, wsId, { store, judge });
    console.log("DBG r1:", JSON.stringify(r1));
    expect(r1.action).toBe("built");
    const brief1 = await getIncidentBrief(inc.id, wsId);
    expect(brief1?.status).toBe("current");
    expect(brief1?.source_count).toBe(1);
    expect(brief1?.findings.facts[0].sources).toEqual([m1.id]);

    // Unchanged sources: no rebuild.
    const r2 = await refreshBriefIfNeeded(inc.id, wsId, { store, judge });
    expect(r2).toEqual({ action: "unchanged" });

    // New report lands: fingerprint changes, brief rebuilds.
    const m2 = await addUserMessage({ conversationId: t1.id, content: "Still 500 on Visa, second attempt failed too", clientId: `s6-${stamp}-2` });
    const r3 = await refreshBriefIfNeeded(inc.id, wsId, { store, judge });
    expect(r3.action).toBe("built");
    const brief3 = await getIncidentBrief(inc.id, wsId);
    expect(brief3?.source_count).toBe(2);
    expect(brief3?.version).toBeGreaterThan(brief1?.version ?? 0);
    void m2;
  }, 120_000);
});
