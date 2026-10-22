import { describe, expect, it, afterAll, vi } from "vitest";
import { detectFromChat, type DetectDeps } from "../detection";
import { recoverDeferredReports, RECOVERY_WINDOW_MINUTES } from "../detection-recovery";
import { shouldEvaluateRadar } from "../radar";
import { evaluateRadarEligibility } from "../radar";
import { uniqueSlug, uniqueEmail, FixtureTracker } from "./fixtures";

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

// ---- In-memory workspace with real uniqueness semantics ----

type FakeMsg = { id: string; conversationId: string; customerId: string; text: string; createdAt: string };
type FakeCand = {
  id: string;
  workspaceId: string;
  status: "pending";
  title: string;
  members: { conversationId: string; customerId: string; addedAt: string }[];
  messages: { messageId: string; conversationId: string; customerId: string; addedAt: string }[];
};

const W1 = "ws-rec";
const W2 = "ws-other";

function makeWorld() {
  const msgs = new Map<string, FakeMsg>();
  const cands = new Map<string, FakeCand>();
  let seq = 0;
  const store = {
    messageAlreadyClustered: async (workspaceId: string, messageId: string) => {
      for (const c of cands.values()) {
        if (c.workspaceId === workspaceId && c.messages.some((m) => m.messageId === messageId)) return { candidateId: c.id };
      }
      return null;
    },
    pendingCandidatesForConversation: async () => [],
    pendingCandidateContexts: async (workspaceId: string) => {
      const out = [];
      for (const c of cands.values()) {
        if (c.workspaceId === workspaceId && c.status === "pending") {
          out.push({ id: c.id, title: c.title, summary: "s", confidence: "high" as const, excerpts: [] as string[] });
        }
      }
      return out;
    },
    dismissedCandidateTitles: async () => [],
    createCandidate: async (input: { workspaceId: string; title: string }) => {
      const id = `cand-${++seq}`;
      cands.set(id, { id, workspaceId: input.workspaceId, status: "pending", title: input.title, members: [], messages: [] });
      return { id };
    },
    addMessageToCandidate: async (input: { candidateId: string; workspaceId: string; messageId: string; conversationId: string; customerId: string; addedAt?: string }) => {
      for (const other of cands.values()) {
        if (other.workspaceId === input.workspaceId && other.messages.some((m) => m.messageId === input.messageId)) {
          return { memberAdded: false, messageAdded: false, duplicateOf: other.id };
        }
      }
      const c = cands.get(input.candidateId);
      if (!c || c.workspaceId !== input.workspaceId) return null;
      const at = input.addedAt ?? new Date().toISOString();
      const memberAdded = !c.members.some((m) => m.conversationId === input.conversationId);
      c.members.push({ conversationId: input.conversationId, customerId: input.customerId, addedAt: at });
      c.messages.push({ messageId: input.messageId, conversationId: input.conversationId, customerId: input.customerId, addedAt: at });
      return { memberAdded, messageAdded: true, duplicateOf: null };
    },
    deleteCandidate: async (candidateId: string) => {
      cands.delete(candidateId);
    },
    listUnclusteredRecent: async (workspaceId: string, input: { sinceIso: string; excludeMessageIds?: readonly string[]; limit?: number }) => {
      const excluded = new Set(input.excludeMessageIds ?? []);
      return [...msgs.values()]
        .filter((m) => !excluded.has(m.id) && m.createdAt >= input.sinceIso)
        .filter((m) => {
          for (const c of cands.values()) if (c.messages.some((x) => x.messageId === m.id)) return false;
          return true;
        })
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(0, input.limit ?? 3)
        .map((m) => ({ workspaceId, messageId: m.id, conversationId: m.conversationId, customerId: m.customerId, text: m.text, createdAt: m.createdAt }));
    },
    addMessage(m: FakeMsg) {
      msgs.set(m.id, m);
    },
  };
  // Workspace scoping shim: messages carry their workspace via conversation map.
  const convWs = new Map<string, string>();
  const convCust = new Map<string, string>();
  return { store, cands, msgs, convWs, convCust };
}

function tokenJudge(): DetectDeps["judge"] {
  return async ({ message, candidates }) => {
    const toks = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3));
    const mt = toks(message);
    if (mt.size === 0) return { isIssue: false, title: "", summary: "", matchCandidateId: null, dismissedMatchId: null, quality: "low" as const, rationale: "x" };
    let best: string | null = null;
    for (const c of candidates) {
      const overlap = [...toks(c.title)].filter((w) => mt.has(w)).length;
      if (overlap >= 2) best = c.id;
    }
    return { isIssue: mt.size > 0, title: "Checkout fails with HTTP 422", summary: "checkout fails", matchCandidateId: best, dismissedMatchId: null, quality: "high" as const, rationale: "same" };
  };
}

const depsFor = (w: ReturnType<typeof makeWorld>) => ({
  store: w.store,
  judge: tokenJudge(),
  listRecentExcerpts: async () => [] as { id: string; excerpt: string }[],
});

const NOW = new Date("2026-10-22T16:00:00.000Z");
const iso = (minsAgo: number) => new Date(NOW.getTime() - minsAgo * 60_000).toISOString();
const longText = (n: number) => `My Visa checkout keeps failing with HTTP 422 every time I try order number ${1000 + n} today please help`;

describe("deferred recovery (pure orchestration)", () => {
  it("a deferred report gets classified on a later sweep", async () => {
    const w = makeWorld();
    w.store.addMessage({ id: "m-1", conversationId: "c-1", customerId: "u-1", text: longText(1), createdAt: iso(50) });
    let calls = 0;
    const flakyJudge: DetectDeps["judge"] = async (input) => {
      calls++;
      if (calls === 1) throw new Error("GenerateContent failed: 503");
      return tokenJudge()(input);
    };
    // First sweep: judge down → bounded deferral, single judge call.
    const r1 = await recoverDeferredReports(W1, { ...depsFor(w), judge: flakyJudge, now: () => NOW }, { now: NOW });
    expect(r1).toMatchObject({ attempted: 1, attached: 0, deferred: 1, stoppedEarly: true });
    expect(calls).toBe(1);
    expect(w.cands.size).toBe(0);
    // Provider recovers: the SAME persisted report classifies, no resend needed.
    const r2 = await recoverDeferredReports(W1, { ...depsFor(w), now: () => NOW }, { now: NOW });
    expect(r2).toMatchObject({ attempted: 1, attached: 1, stoppedEarly: false });
    expect(w.cands.size).toBe(1);
  });

  it("three original qualifying reports lead to one eligible Radar notification", async () => {
    const w = makeWorld();
    for (const [n, cust, conv] of [[1, "u-1", "c-1"], [2, "u-2", "c-2"], [3, "u-3", "c-3"]] as const) {
      w.store.addMessage({ id: `m-${n}`, conversationId: conv, customerId: cust, text: longText(n), createdAt: iso(50 - n) });
    }
    const r = await recoverDeferredReports(W1, { ...depsFor(w), now: () => NOW }, { now: NOW, limit: 3 });
    expect(r.attached).toBe(3);
    // The 2nd and 3rd attachments joined via genuinely new conversations:
    // the caller runs these through the existing Radar evaluation.
    expect(r.joinedNew).toHaveLength(1);
    const cand = [...w.cands.values()][0];
    expect(cand.members).toHaveLength(3);
    // Honest timestamps: attribution kept the ORIGINAL report times.
    for (const m of cand.members) expect(Date.parse(m.addedAt) <= NOW.getTime()).toBe(true);
    expect(cand.members.map((m) => m.addedAt).sort()).toEqual([iso(49), iso(48), iso(47)].sort());
    const members = cand.members.map((m) => ({ conversation_id: m.conversationId, customer_id: m.customerId, added_at: m.addedAt }));
    const elig = evaluateRadarEligibility(
      { id: cand.id, status: "pending", title: cand.title, summary: "s", updated_at: NOW.toISOString() },
      members,
      3,
      NOW,
    );
    expect(elig).toMatchObject({ eligible: true, customers: 3, conversations: 3 });
    expect(shouldEvaluateRadar({ action: "joined", newConversation: true })).toBe(true);
  });

  it("expired reports never become fresh reports", async () => {
    const w = makeWorld();
    // 3-hour-old reports: outside the 60-minute Radar window at replay time.
    const old = new Date(NOW.getTime() - 180 * 60_000).toISOString();
    for (const [n, cust, conv] of [[1, "u-1", "c-1"], [2, "u-2", "c-2"], [3, "u-3", "c-3"]] as const) {
      w.store.addMessage({ id: `m-${n}`, conversationId: conv, customerId: cust, text: longText(n), createdAt: old });
    }
    // Default 60-min window sweep ignores them entirely.
    const r = await recoverDeferredReports(W1, { ...depsFor(w), now: () => NOW }, { now: NOW });
    expect(r).toMatchObject({ attempted: 0, attached: 0 });
    // Even forcing an explicit wide window keeps original timestamps:
    // attribution records when the report was written, never replay time.
    const r2 = await recoverDeferredReports(W1, { ...depsFor(w), now: () => NOW }, { now: NOW, windowMinutes: 240, limit: 3 });
    expect(r2.attached).toBe(3);
    const cand = [...w.cands.values()][0];
    const members = cand.members.map((m) => ({ conversation_id: m.conversationId, customer_id: m.customerId, added_at: m.addedAt }));
    expect(new Set(members.map((m) => m.added_at)).size).toBe(1);
    expect(members[0].added_at).toBe(old);
  });

  it("reprocessing does not duplicate attachments", async () => {
    const w = makeWorld();
    w.store.addMessage({ id: "m-1", conversationId: "c-1", customerId: "u-1", text: longText(1), createdAt: iso(10) });
    const d = { ...depsFor(w), now: () => NOW };
    await recoverDeferredReports(W1, d, { now: NOW });
    const r2 = await recoverDeferredReports(W1, d, { now: NOW });
    expect(r2).toMatchObject({ attempted: 0, attached: 0 });
    expect([...w.cands.values()][0].messages).toHaveLength(1);
  });

  it("concurrent sweeps cannot double-attach", async () => {
    const w = makeWorld();
    w.store.addMessage({ id: "m-1", conversationId: "c-1", customerId: "u-1", text: longText(1), createdAt: iso(10) });
    const d = { ...depsFor(w), now: () => NOW };
    const [a, b] = await Promise.all([
      recoverDeferredReports(W1, d, { now: NOW }),
      recoverDeferredReports(W1, d, { now: NOW }),
    ]);
    expect(a.attached + b.attached).toBe(1);
    expect(w.cands.size).toBe(1);
    expect([...w.cands.values()][0].messages).toHaveLength(1);
  });

  it("workspace isolation: other-workspace reports are untouched", async () => {
    const w = makeWorld();
    w.store.addMessage({ id: "m-x", conversationId: "cx", customerId: "ux", text: longText(9), createdAt: iso(10) });
    // Store is workspace-scoped by the caller: W1 sweep sees no W2 rows.
    const scoped = { ...w.store, listUnclusteredRecent: async () => [] as never[] };
    const r = await recoverDeferredReports(W2, { store: scoped, judge: tokenJudge(), listRecentExcerpts: async () => [] }, { now: NOW });
    expect(r).toMatchObject({ attempted: 0, attached: 0 });
    expect(w.cands.size).toBe(0);
  });
});

// ---- Live store seam: honest timestamps + unclustered listing (Neon) ----

const tracker = new FixtureTracker();
const SLUG = uniqueSlug("rec");
const EMAIL = uniqueEmail("rec");
const PW = "correct-horse-123";

afterAll(async () => {
  await tracker.cleanup();
});

describe("recovery store seam (live Neon)", () => {
  it("setup: workspace + customer + conversation", async () => {
    const { ensureOrganization, ensureWorkspace, addOrganizationMember } = await import("../db");
    const { organizationIdForSlug, workspaceIdForSlug } = await import("../tenant");
    const orgId = organizationIdForSlug(SLUG);
    const wsId = workspaceIdForSlug(SLUG);
    await ensureOrganization({ id: orgId, slug: SLUG, name: `Temp ${SLUG}` });
    await ensureWorkspace({ id: wsId, organizationId: orgId, slug: SLUG, name: `Temp ${SLUG}` });
    tracker.trackOrg(orgId);
    const { auth } = await import("../better-auth");
    const res = (await auth.api.signUpEmail({ body: { email: EMAIL, password: PW, name: "rec" }, headers: new Headers(), asResponse: true })) as unknown as Response;
    expect(res.headers.getSetCookie().some((c) => c.startsWith("meros.session_token="))).toBe(true);
    tracker.trackEmail(EMAIL);
    const { neon } = await import("@neondatabase/serverless");
    const { readFileSync } = await import("node:fs");
    const key = readFileSync(".env.local", "utf8").split("\n").map((l) => l.trim()).find((l) => l.startsWith("DATABASE_URL="))!.slice("DATABASE_URL=".length);
    const sql = neon(key);
    const rows = (await sql`select id from "user" where email = ${EMAIL} limit 1`) as unknown as { id: string }[];
    await addOrganizationMember({ organizationId: orgId, userId: rows[0].id, role: "owner" });
  }, 120_000);

  it("lists only unclustered messages and honors original timestamps", async () => {
    const { ensureAuthCustomer, getWorkspaceBySlug } = await import("../db");
    const { createConversation, addUserMessage } = await import("../support-ops");
    const { customerIdForAuth, workspaceIdForSlug } = await import("../tenant");
    const { createCandidate, addMessageToCandidate, messageAlreadyClustered, listUnclusteredRecentMessages } = await import("../issue-candidates");
    const ws = (await getWorkspaceBySlug(SLUG))!;
    const { neon } = await import("@neondatabase/serverless");
    const { readFileSync } = await import("node:fs");
    const key = readFileSync(".env.local", "utf8").split("\n").map((l) => l.trim()).find((l) => l.startsWith("DATABASE_URL="))!.slice("DATABASE_URL=".length);
    const sql = neon(key);
    const urows = (await sql`select id from "user" where email = ${EMAIL} limit 1`) as unknown as { id: string }[];
    const custId = customerIdForAuth(ws.id, urows[0].id);
    await ensureAuthCustomer({ id: custId, workspaceId: ws.id, authUserId: urows[0].id, displayName: "rec" });
    const { conversation } = await createConversation({ workspaceId: ws.id, customerId: custId, title: "recovery seam" });
    const stored = await addUserMessage({ conversationId: conversation.id, content: "My checkout keeps failing with HTTP 422 on every order today, please help urgently", clientId: "rec-1" });
    const since = new Date(Date.now() - 3600_000).toISOString();
    let listed = await listUnclusteredRecentMessages(ws.id, { sinceIso: since, limit: 5 });
    expect(listed.some((m) => m.messageId === stored.id)).toBe(true);
    expect(listed.find((m) => m.messageId === stored.id)?.createdAt).toBeTruthy();

    const cand = await createCandidate({ workspaceId: ws.id, title: "recovery seam", summary: "s", confidence: "high", rationale: "r" });
    const originalTs = new Date(Date.now() - 30 * 60_000).toISOString();
    const attached = await addMessageToCandidate({ candidateId: cand.id, workspaceId: ws.id, messageId: stored.id, conversationId: conversation.id, customerId: custId, addedAt: originalTs });
    expect(attached.messageAdded).toBe(true);
    const mrows = (await sql`select added_at from issue_candidate_messages where message_id = ${stored.id} limit 1`) as unknown as { added_at: string }[];
    expect(new Date(mrows[0].added_at).getTime()).toBe(new Date(originalTs).getTime());
    const crows = (await sql`select added_at from issue_candidate_members where candidate_id = ${cand.id} and conversation_id = ${conversation.id} limit 1`) as unknown as { added_at: string }[];
    expect(new Date(crows[0].added_at).getTime()).toBe(new Date(originalTs).getTime());

    // Clustered now: excluded from later sweeps, found by idempotency check.
    listed = await listUnclusteredRecentMessages(ws.id, { sinceIso: since, limit: 5 });
    expect(listed.some((m) => m.messageId === stored.id)).toBe(false);
    expect(await messageAlreadyClustered(ws.id, stored.id)).toMatchObject({ candidateId: cand.id });
  }, 180_000);
});
