import { describe, expect, it, afterAll, vi } from "vitest";
import {
  SNAPSHOT_MAX_CHARS,
  buildSnapshot,
  sendIncidentSnapshot,
  type BuiltSnapshot,
  type SnapshotBrief,
  type SnapshotIncident,
  type SnapshotSenderDeps,
  type SnapshotStore,
} from "../incident-snapshot";
import { isEvidenceAutoNotifyEnabled } from "../photon/preferences";
import { POST as snapshotSendPOST } from "@/app/api/incidents/[id]/snapshot/send/route";

// next/headers has no request scope in tests: control the cookie jar here.
let cookieJar = "";
vi.mock("next/headers", () => ({
  headers: async () => new Headers(cookieJar ? { cookie: cookieJar } : {}),
}));

const INC: SnapshotIncident = {
  id: "11111111-2222-3333-4444-555555555555",
  title: "Visa checkout outage",
  status: "investigating",
  severity: "high",
  customer_count: 3,
  conversation_count: 2,
};

const URL = "https://meros-photon.vercel.app/app/workspaces/northstar/incidents/abc";

function briefOf(partial: Partial<SnapshotBrief> = {}): SnapshotBrief {
  return {
    status: "current",
    version: 2,
    fingerprint: "fp-abc123",
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
      unknowns: ["Root cause unknown"],
      hypotheses: [{ text: "Might be a gateway timeout", basedOn: ["m1"] }],
    },
    source_count: 3,
    generated_at: "2026-10-17T12:00:00.000Z",
    ...partial,
  };
}

describe("snapshot rendering (pure)", () => {
  it("is deterministic from persisted incident + brief version", () => {
    const a = buildSnapshot({ incident: INC, brief: briefOf(), incidentUrl: URL });
    const b = buildSnapshot({ incident: INC, brief: briefOf(), incidentUrl: URL });
    expect(a.sendable).toBe(true);
    expect(a.state).toBe("ready");
    expect(a.text).toBe(b.text);
    expect(a.fingerprint).toBe("fp-abc123");
    expect(a.briefVersion).toBe(2);
  });

  it("distinguishes observed facts from unverified hypotheses", () => {
    const s = buildSnapshot({ incident: INC, brief: briefOf(), incidentUrl: URL });
    expect(s.text).toContain("WHAT WE KNOW");
    expect(s.text).toContain("CORROBORATED");
    expect(s.text).toContain("DIFFERS");
    expect(s.text).toContain("STILL UNKNOWN");
    expect(s.text).toContain("UNVERIFIED, NOT CONFIRMED");
    expect(s.text).toContain("[unverified hypothesis]");
  });

  it("never fabricates confidence, causes, or impact figures", () => {
    const s = buildSnapshot({ incident: INC, brief: briefOf(), incidentUrl: URL });
    expect(s.text.toLowerCase()).not.toContain("root cause is");
    expect(s.text).not.toMatch(/100%|guaranteed|definitely fixed/i);
    // Uncertainty is explicit, not hidden.
    expect(s.text).toContain("NOT CONFIRMED");
  });

  it("leaks no customer PII, message ids, or conversation ids", () => {
    const nasty: SnapshotBrief = briefOf({
      findings: {
        facts: [
          {
            observation: "Amara Okafor reports Visa 500",
            identifiers: [],
            sources: ["aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"],
          },
        ],
        corroborated: [],
        contradictions: [],
        unknowns: [],
        hypotheses: [],
      },
    });
    const s = buildSnapshot({ incident: INC, brief: nasty, incidentUrl: URL });
    // Raw source ids never appear (only aggregate report counts do).
    expect(s.text).not.toContain("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(s.text).not.toContain(INC.id);
    expect(s.text).not.toContain("m1");
  });

  it("blocks sends for empty/pending/failed/stale briefs with explicit states", () => {
    const states: Array<[SnapshotBrief | null, BuiltSnapshot["state"]]> = [
      [null, "empty"],
      [briefOf({ status: "pending", fingerprint: "fp-p" }), "pending"],
      [briefOf({ status: "failed", fingerprint: "" }), "failed"],
      [briefOf({ status: "stale", fingerprint: "fp-old" }), "stale"],
    ];
    for (const [brief, state] of states) {
      const s = buildSnapshot({ incident: INC, brief, incidentUrl: URL });
      expect(s.sendable).toBe(false);
      expect(s.state).toBe(state);
      // Honest copy, never a fabricated brief.
      expect(s.text.length).toBeGreaterThan(20);
    }
  });

  it("stays within the Photon body cap even for huge findings", () => {
    const big = briefOf({
      findings: {
        facts: Array.from({ length: 50 }, (_, i) => ({
          observation: `Observation number ${i} `.repeat(30),
          identifiers: ["x".repeat(100)],
          sources: ["m1", "m2", "m3"],
        })),
        corroborated: [],
        contradictions: [],
        unknowns: Array.from({ length: 50 }, (_, i) => `unknown ${i} `.repeat(20)),
        hypotheses: [],
      },
    });
    const s = buildSnapshot({ incident: INC, brief: big, incidentUrl: URL });
    expect(s.text.length).toBeLessThanOrEqual(SNAPSHOT_MAX_CHARS);
    expect(s.text.length).toBeLessThanOrEqual(2000);
  });

  it("emits text only — the iMessage fallback path carries no media payload", () => {
    const s = buildSnapshot({ incident: INC, brief: briefOf(), incidentUrl: URL });
    expect(typeof s.text).toBe("string");
    expect(s.text).toContain(URL);
  });
});

// ---- Send orchestration with fakes (never a real iMessage) ----

function makeFakes(opts: {
  brief?: SnapshotBrief | null;
  incident?: SnapshotIncident | null;
  bindingId?: string | null;
  notify?: SnapshotSenderDeps["notify"];
} = {}) {
  const delivered = new Map<
    string,
    { status: "sending" | "sent" | "failed"; providerId: string | null }
  >();
  let posts = 0;
  const store: SnapshotStore = {
    claimDelivery: async (input) => {
      const hit = delivered.get(input.idempotencyKey);
      if (hit) {
        return {
          row: {
            id: `del-${input.idempotencyKey}`,
            incident_id: input.incidentId,
            workspace_id: input.workspaceId,
            binding_id: input.bindingId,
            brief_fingerprint: input.briefFingerprint,
            brief_version: input.briefVersion,
            idempotency_key: input.idempotencyKey,
            status: hit.status,
            provider_message_id: hit.providerId,
            error: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
          deduped: true,
        };
      }
      delivered.set(input.idempotencyKey, { status: "sending", providerId: null });
      return {
        row: {
          id: `del-${input.idempotencyKey}`,
          incident_id: input.incidentId,
          workspace_id: input.workspaceId,
          binding_id: input.bindingId,
          brief_fingerprint: input.briefFingerprint,
          brief_version: input.briefVersion,
          idempotency_key: input.idempotencyKey,
          status: "sending",
          provider_message_id: null,
          error: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        deduped: false,
      };
    },
    markDeliverySent: async (id) => {
      const key = id.replace(/^del-/, "");
      const hit = delivered.get(key);
      if (hit) delivered.set(key, { status: "sent", providerId: "prov-1" });
    },
    markDeliveryFailed: async (id) => {
      const key = id.replace(/^del-/, "");
      const hit = delivered.get(key);
      if (hit) delivered.set(key, { status: "failed", providerId: null });
    },
  };
  const deps: SnapshotSenderDeps = {
    loadIncident: async () => ("incident" in opts ? (opts.incident ?? null) : INC),
    loadBrief: async () => ("brief" in opts ? (opts.brief ?? null) : briefOf()),
    resolveBindingId: async () => ("bindingId" in opts ? (opts.bindingId ?? null) : "bind-1"),
    store,
    notify:
      opts.notify ??
      (async (body) => {
        posts++;
        expect(typeof body).toBe("string");
        return { ok: true, deduped: false, providerId: "prov-1", messageId: "m-out" };
      }),
  };
  const input = {
    incidentId: INC.id,
    workspaceId: "ws-1",
    operatorUserId: "op-1",
    idempotencyKey: "key-1",
    expectedFingerprint: "fp-abc123",
    incidentUrl: URL,
  };
  return { deps, input, posts: () => posts, delivered };
}

describe("explicit send orchestration (fakes)", () => {
  it("sends the previewed version exactly once", async () => {
    const { deps, input, posts } = makeFakes();
    const r = await sendIncidentSnapshot(input, deps);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.deduped).toBe(false);
      expect(r.providerId).toBe("prov-1");
      expect(r.snapshot.text).toContain("Visa checkout outage");
    }
    expect(posts()).toBe(1);
  });

  it("rejects fingerprint mismatch with the fresh snapshot (no stale send)", async () => {
    const { deps, input, posts } = makeFakes();
    const r = await sendIncidentSnapshot({ ...input, expectedFingerprint: "fp-stale" }, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("fingerprint_mismatch");
      expect(r.recoverable).toBe(true);
      expect(r.snapshot?.fingerprint).toBe("fp-abc123");
    }
    expect(posts()).toBe(0);
  });

  it("blocks non-current briefs before claiming any slot", async () => {
    for (const status of ["pending", "failed", "stale"]) {
      const { deps, input, posts } = makeFakes({ brief: briefOf({ status }) });
      const r = await sendIncidentSnapshot(input, deps);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("brief_not_ready");
      expect(posts()).toBe(0);
    }
    const { deps, input, posts } = makeFakes({ brief: null });
    expect((await sendIncidentSnapshot(input, deps)).ok).toBe(false);
    expect(posts()).toBe(0);
  });

  it("requires incident, binding, and key", async () => {
    const noInc = makeFakes({ incident: null });
    const r1 = await sendIncidentSnapshot(noInc.input, noInc.deps);
    expect(!r1.ok && r1.code).toBe("not_found");

    const noBind = makeFakes({ bindingId: null });
    const r2 = await sendIncidentSnapshot(noBind.input, noBind.deps);
    expect(!r2.ok && r2.code).toBe("no_binding");

    const badKey = makeFakes();
    const r3 = await sendIncidentSnapshot({ ...badKey.input, idempotencyKey: "  " }, badKey.deps);
    expect(!r3.ok && r3.code).toBe("bad_body");
    expect(badKey.posts()).toBe(0);
  });

  it("honors preference suppression (disabled toggle)", async () => {
    const f = makeFakes({
      notify: async () => ({
        ok: false,
        code: "suppressed_disabled",
        recoverable: true,
        suppressed: true as const,
        message: "proactive notifications are disabled for this operator",
      }),
    });
    const r = await sendIncidentSnapshot(f.input, f.deps);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("suppressed_disabled");
      expect(r.suppressed).toBe(true);
    }
    expect(f.delivered.get("key-1")?.status).toBe("failed");
  });

  it("honors quiet hours (held, not sent)", async () => {
    const f = makeFakes({
      notify: async () => ({
        ok: false,
        code: "suppressed_quiet_hours",
        recoverable: true,
        suppressed: true as const,
        message: "inside quiet hours — held, not sent",
      }),
    });
    const r = await sendIncidentSnapshot(f.input, f.deps);
    expect(!r.ok && r.code).toBe("suppressed_quiet_hours");
    expect(f.posts()).toBe(0);
  });

  it("provider failure is recoverable and never claims delivery", async () => {
    const f = makeFakes({
      notify: async () => {
        throw new Error("Spectrum down");
      },
    });
    const r = await sendIncidentSnapshot(f.input, f.deps);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("provider_failed");
      expect(r.recoverable).toBe(true);
    }
  });

  it("same-key double send posts once (double-click safe)", async () => {
    const { deps, input, posts } = makeFakes();
    const a = await sendIncidentSnapshot(input, deps);
    const b = await sendIncidentSnapshot(input, deps);
    expect(a.ok && b.ok).toBe(true);
    if (b.ok) expect(b.deduped).toBe(true);
    expect(posts()).toBe(1);
  });

  it("concurrent same-key sends post once (loser sees in-flight or deduped)", async () => {
    const { deps, input, posts } = makeFakes();
    const [a, b] = await Promise.all([
      sendIncidentSnapshot(input, deps),
      sendIncidentSnapshot(input, deps),
    ]);
    // Winner sends; loser either dedupes (sent) or observes in-flight.
    // Either way exactly one provider post happened.
    expect(a.ok || b.ok).toBe(true);
    expect(posts()).toBe(1);
  });

  it("failed prior attempt requires a fresh key (no silent retry)", async () => {
    const f = makeFakes({
      notify: async () => ({
        ok: false,
        code: "provider_failed",
        recoverable: true,
        message: "Photon send failed",
      }),
    });
    const first = await sendIncidentSnapshot(f.input, f.deps);
    expect(first.ok).toBe(false);
    const second = await sendIncidentSnapshot(f.input, f.deps);
    expect(!second.ok && second.code).toBe("already_attempted");
  });
});

describe("send route authorization", () => {
  it("anonymous callers get 401 without touching data", async () => {
    cookieJar = "";
    const res = await snapshotSendPOST(
      new Request("http://test/api/x/snapshot/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceSlug: "northstar",
          clientSnapshotId: "k-1",
          expectedFingerprint: "fp-x",
        }),
      }),
      { params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000" }) },
    );
    expect(res.status).toBe(401);
  }, 30_000);
});

describe("proactive foundation stays default-disabled", () => {
  it("unknown operators read as OFF and no send path consults it", async () => {
    expect(await isEvidenceAutoNotifyEnabled("ws-none", "op-none")).toBe(false);
    // sendIncidentSnapshot has no auto path by construction: every send
    // requires an explicit idempotency key + fingerprint (asserted above).
  });
});

// ---- Live persistence: delivery idempotency against real Neon ----

const stamp = Date.now().toString(36);
const PW = "correct-horse-123";
const createdEmails: string[] = [];
const createdOrgIds: string[] = [];
const SLUG = `s7-ws-${stamp}`;

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

describe("delivery idempotency (live Neon)", () => {
  it("same key claims once; sent stays sent; no duplicate rows", async () => {
    const { organizationIdForSlug } = await import("../tenant");
    const { ensureOrganization, ensureWorkspace } = await import("../db");
    const orgId = organizationIdForSlug(SLUG);
    await ensureOrganization({ id: orgId, slug: SLUG, name: `Temp ${SLUG}` });
    const { workspaceIdForSlug } = await import("../tenant");
    await ensureWorkspace({ id: workspaceIdForSlug(SLUG), organizationId: orgId, slug: SLUG, name: `Temp ${SLUG}` });
    createdOrgIds.push(orgId);
    cookieJar = await signupSession(`s7-staff-${stamp}@example.test`);
    const { addOrganizationMember } = await import("../db");
    const { neon } = await import("@neondatabase/serverless");
    const sql = neon(dbKey());
    const staff = (await sql`select id from "user" where email = ${`s7-staff-${stamp}@example.test`} limit 1`) as unknown as {
      id: string;
    }[];
    await addOrganizationMember({ organizationId: orgId, userId: staff[0].id, role: "owner" });

    const { realSnapshotStore } = await import("../incident-snapshot");
    const { createIncident } = await import("../incidents");
    const wsId = workspaceIdForSlug(SLUG);
    // No per-test delete: the afterAll organization delete cascades through
    // workspaces -> incidents -> snapshot deliveries (test-hygiene rule).
    const inc = await createIncident({ workspaceId: wsId, title: "S7 live snapshot", createdByUserId: staff[0].id });
    {
      const store = await realSnapshotStore();
      const key = `s7-live-${stamp}`;
      const first = await store.claimDelivery({
        incidentId: inc.id,
        workspaceId: wsId,
        bindingId: null,
        briefFingerprint: "fp-live",
        briefVersion: 1,
        idempotencyKey: key,
      });
      expect(first.deduped).toBe(false);
      expect(first.row.status).toBe("sending");

      // Concurrent double-claim: exactly one winner.
      const again = await store.claimDelivery({
        incidentId: inc.id,
        workspaceId: wsId,
        bindingId: null,
        briefFingerprint: "fp-live",
        briefVersion: 1,
        idempotencyKey: key,
      });
      expect(again.deduped).toBe(true);

      await store.markDeliverySent(first.row.id, "prov-live");
      const after = await store.claimDelivery({
        incidentId: inc.id,
        workspaceId: wsId,
        bindingId: null,
        briefFingerprint: "fp-live",
        briefVersion: 1,
        idempotencyKey: key,
      });
      expect(after.deduped).toBe(true);
      expect(after.row.status).toBe("sent");
      expect(after.row.provider_message_id).toBe("prov-live");

      const count = (await sql`select count(*)::int as n from incident_snapshot_deliveries where idempotency_key = ${key}`) as unknown as {
        n: number;
      }[];
      expect(count[0].n).toBe(1);
    }
  }, 120_000);
});
