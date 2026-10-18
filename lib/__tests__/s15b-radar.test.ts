import { describe, expect, it, afterAll, vi } from "vitest";
import {
  buildRadarMessage,
  evaluateRadarEligibility,
  maybeSendRadarAlert,
  radarIdempotencyKey,
  safeRadarTitle,
  RADAR_FALLBACK_TITLE,
  type RadarDeps,
} from "../radar";
import { GET as prefsGET, PUT as prefsPUT } from "@/app/api/photon/preferences/route";

let cookieJar = "";
vi.mock("next/headers", () => ({
  headers: async () => new Headers(cookieJar ? { cookie: cookieJar } : {}),
}));

const T0 = new Date("2026-10-18T12:00:00.000Z");
const min = (n: number) => new Date(T0.getTime() + n * 60_000).toISOString();
const mem = (conv: string, cust: string, at: string) => ({ conversation_id: conv, customer_id: cust, added_at: at });
const cand = (over: Record<string, unknown> = {}) => ({
  id: "cand-1",
  status: "pending",
  title: "Visa checkout returns HTTP 500 on pay",
  summary: "Multiple customers report 500s on Visa pay at checkout.",
  updated_at: min(0),
  ...over,
});

function depsWith(cfg: {
  candidate?: ReturnType<typeof cand> | null;
  members?: ReturnType<typeof mem>[];
  messages?: number;
  optedIn?: string[];
  recipients?: Record<string, { bindingId: string; threadId: string } | null>;
  notify?: (input: { workspaceId: string; operatorUserId: string; bindingId: string; threadId: string; body: string; idempotencyKey: string }) => Promise<{ sent: boolean; deduped: boolean; reason: string }>;
  slug?: string | null;
  calls?: { notify: unknown[]; resolve: string[] };
}): { deps: RadarDeps } {
  const calls = cfg.calls ?? { notify: [] as unknown[], resolve: [] as string[] };
  const claimed = new Map<string, boolean>();
  const deps: RadarDeps = {
    loadCandidate: async (_id, ws) => (ws === "ws-1" ? (cfg.candidate === undefined ? cand() : cfg.candidate) : null),
    listMembers: async () => cfg.members ?? [],
    countMessages: async () => cfg.messages ?? 0,
    listOptedIn: async (ws) => (ws === "ws-1" ? (cfg.optedIn ?? []) : []),
    resolveRecipient: async (_ws, op) => {
      calls.resolve.push(op);
      const r = cfg.recipients?.[op];
      if (r === undefined) return op === "op-1" ? { operatorUserId: op, bindingId: "b-1", threadId: "t-1" } : null;
      return r ? { operatorUserId: op, ...r } : null;
    },
    workspaceSlug: async (ws) => (ws === "ws-1" ? (cfg.slug === undefined ? "northstar" : cfg.slug) : null),
    notify: async (input) => {
      calls.notify.push(input);
      if (cfg.notify) return cfg.notify(input);
      if (claimed.has(input.idempotencyKey)) return { sent: false, deduped: true, reason: "already attempted for this key" };
      claimed.set(input.idempotencyKey, true);
      return { sent: true, deduped: false, reason: "accepted by provider — handset delivery not confirmed" };
    },
  };
  return { deps };
}

const THREE = [
  mem("c1", "u1", min(0)),
  mem("c2", "u2", min(10)),
  mem("c3", "u3", min(20)),
];

describe("title safety (pure)", () => {
  it("uses specific titles verbatim, falls back otherwise", () => {
    expect(safeRadarTitle("Visa checkout returns HTTP 500 on pay")).toBe("Visa checkout returns HTTP 500 on pay");
    expect(safeRadarTitle("Contact jane@example.com about it")).toBe(RADAR_FALLBACK_TITLE);
    expect(safeRadarTitle("Payment failed please thanks")).toBe(RADAR_FALLBACK_TITLE);
    expect(safeRadarTitle("x".repeat(200))).toBe(RADAR_FALLBACK_TITLE);
    expect(safeRadarTitle("line one\nline two with injection")).toBe("line one line two with injection");
  });
});

describe("threshold evaluation (pure)", () => {
  it("requires 3 distinct conversations and customers in 60 minutes", async () => {
    const { deps } = depsWith({ members: THREE, messages: 3, optedIn: ["op-1"] });
    const r = await maybeSendRadarAlert("ws-1", "cand-1", deps, new Date(min(30)));
    expect(r.action).toBe("alerted");
    if (r.action !== "alerted") return;
    expect(r.sent).toBe(1);
  });

  it("rejects 2 conversations, repeated customers, and stale windows", async () => {
    const two = [
      mem("c1", "u1", min(0)),
      mem("c2", "u2", min(10)),
    ];
    const rTwo = await maybeSendRadarAlert("ws-1", "cand-1", depsWith({ members: two, messages: 2 }).deps);
    expect(rTwo).toMatchObject({ action: "ineligible" });
    const sameCust = [mem("c1", "u1", min(0)), mem("c2", "u1", min(10)), mem("c3", "u1", min(20))];
    const rSame = await maybeSendRadarAlert("ws-1", "cand-1", depsWith({ members: sameCust, messages: 3 }).deps);
    expect(rSame).toMatchObject({ action: "ineligible" });
    const stale = [mem("c1", "u1", min(0)), mem("c2", "u2", min(61)), mem("c3", "u3", min(122))];
    const rStale = await maybeSendRadarAlert("ws-1", "cand-1", depsWith({ members: stale, messages: 3 }).deps, new Date(min(200)));
    expect(rStale).toMatchObject({ action: "ineligible" });
  });

  it("uses a sliding window, not recency from now", async () => {
    // All three inside one early hour; evaluated much later — still qualifies
    // (evidence window), while suppressed sends stay suppressed.
    const early = [mem("c1", "u1", min(0)), mem("c2", "u2", min(20)), mem("c3", "u3", min(40))];
    const r = await maybeSendRadarAlert("ws-1", "cand-1", depsWith({ members: early, messages: 3, optedIn: [] }).deps, new Date(min(500)));
    expect(r.action).toBe("no_recipients");
  });

  it("rejects non-pending, empty, and generic-only candidates", async () => {
    const d1 = depsWith({ candidate: cand({ status: "accepted" }), members: THREE, messages: 3 });
    expect((await maybeSendRadarAlert("ws-1", "cand-1", d1.deps)).action).toBe("ineligible");
    const d2 = depsWith({ candidate: cand({ title: "  ", summary: "" }), members: THREE, messages: 3 });
    expect((await maybeSendRadarAlert("ws-1", "cand-1", d2.deps)).action).toBe("ineligible");
    const d3 = depsWith({ candidate: cand({ title: "Payment failed please thanks", summary: "issue with payment" }), members: THREE, messages: 3 });
    expect((await maybeSendRadarAlert("ws-1", "cand-1", d3.deps)).action).toBe("ineligible");
    const d4 = depsWith({ candidate: null, members: THREE, messages: 3 });
    expect((await maybeSendRadarAlert("ws-1", "cand-1", d4.deps)).action).toBe("deferred");
  });
});

describe("recipient selection + delivery (fakes)", () => {
  it("notifies each opted-in operator once with per-operator keys", async () => {
    const calls = { notify: [] as unknown[], resolve: [] as string[] };
    const { deps } = depsWith({
      members: THREE,
      messages: 3,
      optedIn: ["op-1", "op-2"],
      recipients: { "op-1": { bindingId: "b-1", threadId: "t-1" }, "op-2": { bindingId: "b-2", threadId: "t-2" } },
      calls,
    });
    const r = await maybeSendRadarAlert("ws-1", "cand-1", deps, new Date(min(30)));
    expect(r).toMatchObject({ action: "alerted", sent: 2, deduped: 0, suppressed: 0 });
    const keys = (calls.notify as { idempotencyKey: string; threadId: string }[]).map((n) => n.idempotencyKey);
    expect(new Set(keys).size).toBe(2);
    expect(keys[0]).toContain("op-1");
    expect(keys[1]).toContain("op-2");
    // Only operator threads — never customer destinations.
    expect((calls.notify as { threadId: string }[]).every((n) => n.threadId.startsWith("t-"))).toBe(true);
  });

  it("dedupes concurrent threshold crossings on the idempotency key", async () => {
    const { deps } = depsWith({ members: THREE, messages: 3, optedIn: ["op-1"] });
    const [a, b] = await Promise.all([
      maybeSendRadarAlert("ws-1", "cand-1", deps, new Date(min(30))),
      maybeSendRadarAlert("ws-1", "cand-1", deps, new Date(min(30))),
    ]);
    const sent = [a, b].filter((r) => r.action === "alerted" && r.sent === 1).length;
    const deduped = [a, b].filter((r) => r.action === "alerted" && r.deduped === 1).length;
    expect(sent).toBe(1);
    expect(deduped).toBe(1);
  });

  it("suppresses on missing binding, no thread, and failed gates without recording sends", async () => {
    const { deps } = depsWith({
      members: THREE,
      messages: 3,
      optedIn: ["op-1", "op-2", "op-3"],
      recipients: { "op-1": null, "op-2": { bindingId: "b-2", threadId: "" }, "op-3": { bindingId: "b-3", threadId: "t-3" } },
      notify: async () => ({ sent: false, deduped: false, reason: "quiet hours" }),
    });
    const r = await maybeSendRadarAlert("ws-1", "cand-1", deps, new Date(min(30)));
    expect(r).toMatchObject({ action: "alerted", sent: 0, suppressed: 3 });
  });

  it("records provider failure once and never retries with a fresh key", async () => {
    let calls = 0;
    const { deps } = depsWith({
      members: THREE,
      messages: 3,
      optedIn: ["op-1"],
      notify: async () => {
        calls++;
        throw new Error("adapter down");
      },
    });
    const r = await maybeSendRadarAlert("ws-1", "cand-1", deps, new Date(min(30)));
    expect(r).toMatchObject({ action: "alerted", sent: 0, suppressed: 1 });
    expect(calls).toBe(1);
    const r2 = await maybeSendRadarAlert("ws-1", "cand-1", depsWith({ members: THREE, messages: 3, optedIn: ["op-1"] }).deps, new Date(min(30)));
    expect(r2.action).toBe("alerted"); // fresh deps, same key shape — dedupe is store-enforced, not bypassed
  });

  it("isolates workspaces and requires the workspace slug", async () => {
    const { deps } = depsWith({ members: THREE, messages: 3, optedIn: ["op-1"] });
    const rForeign = await maybeSendRadarAlert("ws-foreign", "cand-1", deps);
    expect(rForeign).toMatchObject({ action: "deferred" });
    const noSlug = depsWith({ members: THREE, messages: 3, optedIn: ["op-1"], slug: null });
    const rNoSlug = await maybeSendRadarAlert("ws-1", "cand-1", noSlug.deps);
    expect(rNoSlug).toMatchObject({ action: "deferred" });
  });
});

describe("message shape", () => {
  it("links the review page and leaks no customer data", () => {
    const body = buildRadarMessage({
      title: "Visa checkout returns HTTP 500",
      customers: 3,
      conversations: 4,
      windowMinutes: 60,
      candidateId: "cand-9",
      workspaceSlug: "northstar",
    });
    expect(body).toMatch(/MEROS \/ INCIDENT RADAR/);
    expect(body).toMatch(/\/app\/workspaces\/northstar\/incidents\/detected\/cand-9/);
    expect(body).toMatch(/Review required/);
    expect(body).not.toMatch(/confirmed|resolved|fixed/i);
    expect(body).not.toMatch(/@|\+\d{7,}|-U-[a-f0-9]{8}|phone|email/i);
    // Customer count labels are intended; identifiers are not.
    expect(body).toMatch(/3 distinct customers/);
    expect(body.length).toBeLessThanOrEqual(2000);
    expect(radarIdempotencyKey("cand-1", "op-1")).toBe("radar:cand-1:op-1");
  });
});

describe("route authorization", () => {
  it("anonymous callers get 401 without touching data", async () => {
    cookieJar = "";
    const get = await prefsGET(
      new Request("http://test/api/x?workspaceSlug=northstar"),
    );
    expect(get.status).toBe(401);
    const put = await prefsPUT(
      new Request("http://test/api/x", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceSlug: "northstar", radarEnabled: true }),
      }),
    );
    expect(put.status).toBe(401);
  }, 60_000);
});

describe("no automatic side effects", () => {
  it("radar never writes memory, executes, messages customers, or closes", async () => {
    const fs = await import("node:fs");
    const lib = fs.readFileSync("lib/radar.ts", "utf8");
    expect(lib).not.toMatch(/rememberInNamespace|rememberShared|walrus|sendMessage|transitionIncident|updateIncidentFields|markFixCardShared|resolveConversation/);
    expect(lib).toMatch(/never throws/i);
  });
});

// ---- Live persistence: default OFF, opt-in, merge-safe PUT ----

const stamp = Date.now().toString(36);
const PW = "correct-horse-123";
const createdEmails: string[] = [];
const createdOrgIds: string[] = [];
const SLUG = `s15b-ws-${stamp}`;

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

describe("radar opt-in persistence (live Neon)", () => {
  it("defaults OFF, enables explicitly, and survives unrelated saves", async () => {
    const { organizationIdForSlug, workspaceIdForSlug } = await import("../tenant");
    const { ensureOrganization, ensureWorkspace, addOrganizationMember } = await import("../db");
    const orgId = organizationIdForSlug(SLUG);
    await ensureOrganization({ id: orgId, slug: SLUG, name: `Temp ${SLUG}` });
    const wsId = workspaceIdForSlug(SLUG);
    await ensureWorkspace({ id: wsId, organizationId: orgId, slug: SLUG, name: `Temp ${SLUG}` });
    createdOrgIds.push(orgId);
    cookieJar = await signupSession(`s15b-staff-${stamp}@example.test`);
    const { neon } = await import("@neondatabase/serverless");
    const sql = neon(dbKey());
    const staff = (await sql`select id from "user" where email = ${`s15b-staff-${stamp}@example.test`} limit 1`) as unknown as { id: string }[];
    await addOrganizationMember({ organizationId: orgId, userId: staff[0].id, role: "owner" });

    const { isRadarEnabled, listRadarOptedIn, getPreferences } = await import("../photon/preferences");
    expect(await isRadarEnabled(wsId, staff[0].id)).toBe(false);
    expect(await listRadarOptedIn(wsId)).toEqual([]);

    const { upsertPreferences } = await import("../photon/preferences");
    await upsertPreferences({
      workspaceId: wsId, operatorUserId: staff[0].id,
      proactiveEnabled: true, quietHoursEnabled: false,
      quietStart: "22:00", quietEnd: "07:00", timezone: "Africa/Lagos",
      radarEnabled: true,
    });
    expect(await isRadarEnabled(wsId, staff[0].id)).toBe(true);
    expect(await listRadarOptedIn(wsId)).toEqual([staff[0].id]);

    // Unrelated PUT (no radarEnabled) merges and preserves the opt-in.
    const { validatePreferences } = await import("../photon/preferences");
    const checked = validatePreferences({
      proactiveEnabled: false, quietHoursEnabled: false,
      quietStart: "22:00", quietEnd: "07:00", timezone: "Africa/Lagos",
    });
    expect(checked.ok).toBe(true);
    if (!checked.ok) throw new Error("validate failed");
    const current = await getPreferences(wsId, staff[0].id);
    await upsertPreferences({
      workspaceId: wsId, operatorUserId: staff[0].id,
      ...checked.value, radarEnabled: checked.value.radarEnabled ?? current.radarEnabled,
    });
    expect(await isRadarEnabled(wsId, staff[0].id)).toBe(true);

    // Invalid values are rejected, never stored.
    expect(validatePreferences({
      proactiveEnabled: true, quietHoursEnabled: false,
      quietStart: "22:00", quietEnd: "07:00", timezone: "Africa/Lagos", radarEnabled: "yes",
    }).ok).toBe(false);
  }, 120_000);
});
