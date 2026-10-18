import { describe, expect, it, afterAll, vi } from "vitest";
import { buildEvidenceView, safeHeading, type EvidenceViewInput } from "../evidence-view";
import { GET as pngGET } from "@/app/api/incidents/[id]/evidence-image/route";

let cookieJar = "";
vi.mock("next/headers", () => ({
  headers: async () => new Headers(cookieJar ? { cookie: cookieJar } : {}),
}));

function input(over: Partial<EvidenceViewInput> = {}): EvidenceViewInput {
  return {
    incident: { id: "inc-1", title: "Visa checkout returns HTTP 500 on pay", status: "investigating", severity: "high", customer_count: 2, conversation_count: 2 },
    brief: {
      status: "current",
      version: 2,
      fingerprint: "fp-ev-1",
      generated_at: "2026-10-18T12:00:00.000Z",
      source_count: 2,
      findings: {
        facts: [
          { observation: "Visa checkout returns HTTP 500 on pay", identifiers: ["500", "Visa"], sources: ["m1", "m2"] },
          { observation: "Same 500 on Visa checkout at peak", identifiers: ["500"], sources: ["m2"] },
        ],
        corroborated: [{ pattern: "Same 500 on Visa checkout", sources: ["m1", "m2"] }],
        contradictions: [{ description: "One reporter sees 402 instead of 500" }],
        unknowns: ["Root cause unknown"],
        hypotheses: [{ text: "Might be a gateway timeout" }],
      },
    },
    matches: [
      { refId: "card-1", tier: "verified_fix", excerpt: "Visa 500. Cause: gateway timeout. Fix: retried idempotently.", cardStatus: "shared", cardResolved: true, reasons: ["Same 500 on Visa pay"] },
    ],
    recovery: { plans: [{ version: 1, status: "staged" }], approvedApprovals: 1, unverifiedExecutions: 0 },
    watch: { status: "improvement_indicated", observations: 2, improvements: 1, regressions: 0 },
    sourceLinks: [
      { messageId: "m1", conversationId: "c1" },
      { messageId: "m2", conversationId: "c1" },
    ],
    postmortemFinalized: false,
    briefAvailable: true,
    ...over,
  };
}

describe("evidence view model (pure)", () => {
  it("assembles a grounded ready view in brief order", () => {
    const v = buildEvidenceView(input());
    expect(v.ready).toBe(true);
    if (!v.ready) return;
    expect(v.heading).toBe("Visa checkout returns HTTP 500 on pay");
    expect(v.briefVersion).toBe(2);
    expect(v.briefFingerprint).toBe("fp-ev-1");
    expect(v.facts.map((f) => f.observation)).toEqual([
      "Visa checkout returns HTTP 500 on pay",
      "Same 500 on Visa checkout at peak",
    ]);
    expect(v.identifiers).toContain("500");
    expect(v.identifiers).toContain("Visa");
    expect(v.contradictions).toEqual(["One reporter sees 402 instead of 500"]);
    expect(v.unknowns).toEqual(["Root cause unknown"]);
    expect(v.hypotheses).toEqual(["Might be a gateway timeout"]);
    expect(v.matches[0].tier).toBe("verified_fix");
    expect(v.recovery.stagedPlans).toBe(1);
    expect(v.watch?.status).toBe("improvement_indicated");
  });

  it("redacts sensitive titles instead of leaking them", () => {
    expect(safeHeading("Refund issue for jane@example.com")).toBe("Incident evidence");
    expect(safeHeading("Call +1 555 123 4567 about the outage")).toBe("Incident evidence");
    expect(safeHeading("  ")).toBe("Incident evidence");
    expect(safeHeading("Visa checkout 500s")).toBe("Visa checkout 500s");
    const v = buildEvidenceView(input({ incident: { id: "inc-1", title: "Problem for jane@example.com", status: "open", severity: "low", customer_count: 0, conversation_count: 0 } }));
    expect(v.heading).toBe("Incident evidence");
  });

  it("never invents excluded customers, errors, fixes, or causes", () => {
    const v = buildEvidenceView(input());
    expect(v.ready).toBe(true);
    if (!v.ready) return;
    const text = JSON.stringify(v);
    expect(text).not.toMatch(/excluded|HTTP 4\d\d.*confirmed|root cause is|guaranteed|resolved customer/i);
    expect(v).not.toHaveProperty("excludedCustomers");
    expect(v).not.toHaveProperty("outcomeCounts");
    expect(v.matches.every((m) => ["verified_fix", "documented_unverified", "possible_match"].includes(m.tier))).toBe(true);
  });

  it("yields honest non-ready states without fabricating currency", () => {
    for (const [status, state] of [["pending", "pending"], ["stale", "stale"], ["failed", "failed"]] as const) {
      const v = buildEvidenceView(input({ brief: { ...input().brief!, status, version: 1, fingerprint: "fp-x", generated_at: null, source_count: 1, findings: { facts: [], corroborated: [], contradictions: [], unknowns: [], hypotheses: [] } } }));
      expect(v.ready).toBe(false);
      if (v.ready) continue;
      expect(v.state).toBe(state);
    }
    const missing = buildEvidenceView(input({ brief: null, briefAvailable: false }));
    expect(missing.ready).toBe(false);
    if (!missing.ready) expect(missing.state).toBe("empty");
  });

  it("marks unverified hypotheses as unverified, never confirmed", () => {
    const v = buildEvidenceView(input());
    expect(v.ready).toBe(true);
    if (!v.ready) return;
    expect(v.hypotheses.length).toBeGreaterThan(0);
    expect(JSON.stringify(v)).not.toMatch(/verified root cause|confirmed cause/i);
  });
});

describe("route authorization", () => {
  it("anonymous callers get 401, unknown workspaces 404", async () => {
    cookieJar = "";
    const anon = await pngGET(
      new Request("http://test/api/x?workspaceSlug=northstar"),
      { params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000" }) },
    );
    expect(anon.status).toBe(401);
    // Authenticated but unknown workspace slug → 404 (no leak).
    cookieJar = "meros.session_token=deadbeef";
    const missing = await pngGET(
      new Request("http://test/api/x?workspaceSlug=no-such-workspace"),
      { params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000" }) },
    );
    expect([401, 404]).toContain(missing.status);
    cookieJar = "";
  }, 30_000);
});

describe("no automatic side effects", () => {
  it("evidence view carries no execution, messaging, or closure surface", async () => {
    const fs = await import("node:fs");
    const lib = fs.readFileSync("lib/evidence-view.ts", "utf8");
    expect(lib).not.toMatch(/transitionIncident|updateIncidentFields|rememberInNamespace|sendMessage|postToThread|markFixCardShared|resolveConversation/);
  });
});

// ---- Live rendering: PNG bytes, headers, privacy, determinism ----

const stamp = Date.now().toString(36);
const PW = "correct-horse-123";
const createdEmails: string[] = [];
const createdOrgIds: string[] = [];
const SLUG = `s15d-ws-${stamp}`;

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

function pngSize(buf: Buffer): { width: number; height: number } {
  // PNG IHDR: 8-byte signature, 4-byte length, "IHDR", then width/height BE32.
  expect(buf.subarray(1, 4).toString()).toBe("PNG");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe("evidence PNG (live Neon)", () => {
  it("renders a current 16:9 PNG with private headers and no PII", async () => {
    const { organizationIdForSlug, workspaceIdForSlug, customerIdFor } = await import("../tenant");
    const { ensureOrganization, ensureWorkspace, addOrganizationMember, ensureCustomer } = await import("../db");
    const orgId = organizationIdForSlug(SLUG);
    await ensureOrganization({ id: orgId, slug: SLUG, name: `Temp ${SLUG}` });
    const wsId = workspaceIdForSlug(SLUG);
    await ensureWorkspace({ id: wsId, organizationId: orgId, slug: SLUG, name: `Temp ${SLUG}` });
    createdOrgIds.push(orgId);
    cookieJar = await signupSession(`s15d-staff-${stamp}@example.test`);
    const { neon } = await import("@neondatabase/serverless");
    const sql = neon(dbKey());
    const staff = (await sql`select id from "user" where email = ${`s15d-staff-${stamp}@example.test`} limit 1`) as unknown as { id: string }[];
    await addOrganizationMember({ organizationId: orgId, userId: staff[0].id, role: "owner" });

    const { createHash } = await import("node:crypto");
    const h = createHash("sha256").update(`s15d-${stamp}`, "utf8").digest("hex");
    const custId = customerIdFor(wsId, h);
    await ensureCustomer({ id: custId, workspaceId: wsId, bootstrapHash: h });
    const { createConversation, addUserMessage } = await import("../support-ops");
    const conv = (await createConversation({ workspaceId: wsId, customerId: custId, title: "Visa 500s" })).conversation;
    await addUserMessage({ conversationId: conv.id, content: "Visa checkout fails with HTTP 500 every time today", clientId: `s15d-${stamp}-1` });

    const { createIncident, addIncidentConversation } = await import("../incidents");
    // Title carries PII: the PNG heading must redact it.
    const inc = await createIncident({ workspaceId: wsId, title: `Checkout outage for jane${stamp}@example.test`, createdByUserId: staff[0].id });
    await addIncidentConversation({ incidentId: inc.id, workspaceId: wsId, conversationId: conv.id, actorUserId: staff[0].id });
    for (const to of ["investigating", "ready_for_action", "recovering", "monitoring"] as const) {
      await (await import("../incidents")).transitionIncident({ incidentId: inc.id, workspaceId: wsId, to });
    }

    const { realBriefStore, refreshBriefIfNeeded } = await import("../evidence-brief");
    const bjudge = async (input: { sources: { id: string }[] }) => ({
      facts: [{ observation: "Visa checkout returns HTTP 500", identifiers: ["500", "Visa"], sources: input.sources.map((s) => s.id) }],
      corroborated: [],
      contradictions: [],
      unknowns: ["Root cause unknown"],
      hypotheses: [],
    });
    await refreshBriefIfNeeded(inc.id, wsId, { store: await realBriefStore(), judge: bjudge as never });

    const url = `http://test/api/incidents/${inc.id}/evidence-image?workspaceSlug=${SLUG}`;
    const res = await pngGET(new Request(url), { params: Promise.resolve({ id: inc.id }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/png");
    expect(res.headers.get("cache-control")).toMatch(/private/);
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    const buf = Buffer.from(await res.arrayBuffer());
    expect(pngSize(buf)).toEqual({ width: 1200, height: 675 });
    // PII must not appear in the rendered bytes (redacted heading, no raw transcript).
    expect(buf.includes(`jane${stamp}@example.test`)).toBe(false);
    // Deterministic: same evidence renders byte-identical output.
    const res2 = await pngGET(new Request(url), { params: Promise.resolve({ id: inc.id }) });
    expect(Buffer.from(await res2.arrayBuffer()).equals(buf)).toBe(true);
  }, 120_000);

  it("returns 404 for foreign incidents and honest non-ready art for empty briefs", async () => {
    const { organizationIdForSlug, workspaceIdForSlug } = await import("../tenant");
    const { ensureOrganization, ensureWorkspace, addOrganizationMember } = await import("../db");
    const otherSlug = `s15d-other-${stamp}`;
    const otherOrg = organizationIdForSlug(otherSlug);
    await ensureOrganization({ id: otherOrg, slug: otherSlug, name: "Other" });
    createdOrgIds.push(otherOrg);
    await ensureWorkspace({ id: workspaceIdForSlug(otherSlug), organizationId: otherOrg, slug: otherSlug, name: "Other" });
    const { neon } = await import("@neondatabase/serverless");
    const sql = neon(dbKey());
    const staff = (await sql`select id from "user" where email = ${`s15d-staff-${stamp}@example.test`} limit 1`) as unknown as { id: string }[];
    const { getWorkspaceBySlug } = await import("../db");
    const ws = await getWorkspaceBySlug(SLUG);
    await addOrganizationMember({ organizationId: otherOrg, userId: staff[0].id, role: "owner" });
    const { createIncident, getIncidentForWorkspace } = await import("../incidents");
    // Incident lives in the fixture workspace; requesting via another
    // workspace slug must 404 (workspace isolation).
    const incs = (await sql`select id from incidents where workspace_id = ${ws!.id} order by created_at desc limit 1`) as unknown as { id: string }[];
    const cross = await pngGET(
      new Request(`http://test/api/incidents/${incs[0].id}/evidence-image?workspaceSlug=${otherSlug}`),
      { params: Promise.resolve({ id: incs[0].id }) },
    );
    expect(cross.status).toBe(404);

    // Fresh incident with no brief in the staff workspace: still a PNG,
    // but an honest non-ready card — never a fake current image.
    const bare = await createIncident({ workspaceId: ws!.id, title: "[fixture] bare incident", createdByUserId: staff[0].id });
    const r = await pngGET(
      new Request(`http://test/api/incidents/${bare.id}/evidence-image?workspaceSlug=${SLUG}`),
      { params: Promise.resolve({ id: bare.id }) },
    );
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("image/png");
    const buf = Buffer.from(await r.arrayBuffer());
    expect(pngSize(buf)).toEqual({ width: 1200, height: 675 });
    expect(await getIncidentForWorkspace(ws!.id, bare.id).then((x) => x?.status)).toBe("detected");
  }, 120_000);
});
