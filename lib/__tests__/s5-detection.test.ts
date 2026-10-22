import { describe, expect, it, afterAll, vi } from "vitest";
import { detectFromChat, type DetectDeps, type DetectInput, type JudgeResult } from "../detection";
import { validateJudgeOutput } from "../detection-gemini";
import { SURFACE_MIN_CONVERSATIONS } from "../issue-candidates";
import { addOrganizationMember, ensureOrganization, ensureWorkspace } from "../db";
import { organizationIdForSlug, workspaceIdForSlug } from "../tenant";

// next/headers has no request scope in tests: control the cookie jar here.
let cookieJar = "";
vi.mock("next/headers", () => ({
  headers: async () => new Headers(cookieJar ? { cookie: cookieJar } : {}),
}));

// ---- In-memory store replicating Neon unique semantics ----

type FakeMessage = { id: string; conversationId: string; customerId: string; text: string };
type FakeCandidate = {
  id: string;
  workspaceId: string;
  title: string;
  summary: string;
  status: "pending" | "accepted" | "dismissed";
  confidence: "low" | "medium" | "high";
  rationale: string;
  acceptedIncidentId: string | null;
  dismissalNote: string | null;
  members: Map<string, string>; // conversationId -> customerId
  messages: { messageId: string; conversationId: string; customerId: string }[];
};

function makeStore() {
  const convs = new Map<string, { customerId: string; workspaceId: string }>();
  const msgs = new Map<string, FakeMessage>();
  const cands = new Map<string, FakeCandidate>();
  let seq = 0;
  const nid = (p: string) => `${p}-${++seq}`;
  return {
    convs,
    msgs,
    cands,
    addConversation(id: string, workspaceId: string, customerId: string) {
      convs.set(id, { customerId, workspaceId });
    },
    addMessage(m: FakeMessage) {
      msgs.set(m.id, m);
    },
    store(): DetectDeps["store"] {
      return {
        messageAlreadyClustered: async (workspaceId, messageId) => {
          for (const c of cands.values()) {
            if (c.workspaceId !== workspaceId) continue;
            if (c.messages.some((m) => m.messageId === messageId)) return { candidateId: c.id };
          }
          return null;
        },
        pendingCandidatesForConversation: async (workspaceId, conversationId) => {
          const out = [];
          for (const c of cands.values()) {
            if (c.workspaceId === workspaceId && c.status === "pending" && c.members.has(conversationId)) {
              out.push({
                id: c.id, workspace_id: c.workspaceId, title: c.title, summary: c.summary, status: c.status,
                confidence: c.confidence, rationale: c.rationale, accepted_incident_id: c.acceptedIncidentId,
                dismissed_at: null, dismissed_by_user_id: null, dismissal_note: c.dismissalNote,
                first_seen_at: "", last_seen_at: "", updated_at: "", created_at: "",
                conversation_count: c.members.size,
                customer_count: new Set(c.members.values()).size,
                message_count: c.messages.length,
              });
            }
          }
          return out;
        },
        pendingCandidateContexts: async (workspaceId) => {
          const out = [];
          for (const c of cands.values()) {
            if (c.workspaceId !== workspaceId || c.status !== "pending") continue;
            out.push({
              id: c.id, title: c.title, summary: c.summary, confidence: c.confidence,
              excerpts: c.messages.slice(0, 3).map((m) => msgs.get(m.messageId)?.text ?? ""),
            });
          }
          return out;
        },
        dismissedCandidateTitles: async (workspaceId) => {
          const out = [];
          for (const c of cands.values()) if (c.workspaceId === workspaceId && c.status === "dismissed") out.push({ id: c.id, title: c.title });
          return out;
        },
        createCandidate: async (input) => {
          const id = nid("cand");
          cands.set(id, {
            id, workspaceId: input.workspaceId, title: input.title, summary: input.summary,
            status: "pending", confidence: input.confidence, rationale: input.rationale,
            acceptedIncidentId: null, dismissalNote: null, members: new Map(), messages: [],
          });
          return { id };
        },
        addMessageToCandidate: async (input) => {
          const c = cands.get(input.candidateId);
          if (!c || c.status !== "pending") return null;
          const m = msgs.get(input.messageId);
          if (!m || m.conversationId !== input.conversationId) return null;
          // Exclusive attribution: a message already clustered anywhere in
          // this workspace loses here; the winner is reported back.
          for (const other of cands.values()) {
            if (other.workspaceId !== input.workspaceId) continue;
            if (other.messages.some((x) => x.messageId === input.messageId)) {
              return { memberAdded: false, messageAdded: false, duplicateOf: other.id };
            }
          }
          const hadMember = c.members.has(input.conversationId);
          const hadMessage = c.messages.some((x) => x.messageId === input.messageId);
          if (!hadMessage) c.messages.push({ messageId: input.messageId, conversationId: input.conversationId, customerId: input.customerId });
          c.members.set(input.conversationId, input.customerId);
          return { memberAdded: !hadMember, messageAdded: !hadMessage, duplicateOf: null };
        },
        deleteCandidate: async (candidateId, workspaceId) => {
          const c = cands.get(candidateId);
          if (c && c.workspaceId === workspaceId) cands.delete(candidateId);
        },
      };
    },
  };
}

function depsFor(store: ReturnType<typeof makeStore>, judge: DetectDeps["judge"]): DetectDeps {
  return {
    judge,
    store: store.store(),
    listRecentExcerpts: async (workspaceId, excludeId) => {
      const out: { id: string; excerpt: string }[] = [];
      for (const [cid, c] of store.convs) {
        if (c.workspaceId !== workspaceId || cid === excludeId) continue;
        const last = [...store.msgs.values()].filter((m) => m.conversationId === cid).pop();
        if (last) out.push({ id: cid, excerpt: last.text.slice(0, 300) });
      }
      return out.slice(0, 10);
    },
  };
}

const W1 = "ws-1";
const W2 = "ws-2";

function inputFor(msg: FakeMessage): DetectInput {
  const conv = { conversationId: msg.conversationId, customerId: msg.customerId };
  return { workspaceId: W1, conversationId: conv.conversationId, customerId: conv.customerId, messageId: msg.id, text: msg.text };
}

// Judge that matches on shared specific tokens (deterministic stand-in for
// semantic judgment; the REAL prompt + model live behind geminiJudge()).
function tokenJudge(matchSets: string[][]): DetectDeps["judge"] {
  return async ({ message, candidates }) => {
    const toks = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !GENERIC.has(w)));
    const mt = toks(message);
    if ([...mt].length === 0) {
      return { isIssue: false, title: "", summary: "", matchCandidateId: null, dismissedMatchId: null, quality: "low", rationale: "no substance" };
    }
    let best: string | null = null;
    let bestOverlap = 0;
    for (const c of candidates) {
      const ct = new Set<string>();
      for (const t of [c.title, c.summary, ...c.excerpts]) for (const w of toks(t)) ct.add(w);
      let overlap = 0;
      for (const w of mt) if (ct.has(w)) overlap++;
      if (overlap > bestOverlap) { bestOverlap = overlap; best = c.id; }
    }
    // Require a call-specific match set to also fire (simulates the model
    // seeing the SAME specific problem, not just shared generic words).
    const fires = matchSets.some((set) => set.every((w) => mt.has(w)));
    if (!fires) {
      return { isIssue: true, title: [...mt].slice(0, 6).join(" "), summary: message.slice(0, 200), matchCandidateId: null, dismissedMatchId: null, quality: "medium", rationale: "new distinct report" };
    }
    if (best && bestOverlap >= 2) {
      return { isIssue: true, title: "", summary: "", matchCandidateId: best, dismissedMatchId: null, quality: "high", rationale: `shares specifics` };
    }
    return { isIssue: true, title: [...mt].slice(0, 6).join(" "), summary: message.slice(0, 200), matchCandidateId: null, dismissedMatchId: null, quality: "medium", rationale: "new pattern" };
  };
}
const GENERIC = new Set("payment,failed,fails,error,errors,please,thanks,issue,problem,account,money,transfer".split(","));

describe("detection orchestration (fakes)", () => {
  it("two wordings of the same issue form one surfaced candidate", async () => {
    const s = makeStore();
    s.addConversation("c1", W1, "cu1");
    s.addConversation("c2", W1, "cu2");
    const m1 = { id: "m1", conversationId: "c1", customerId: "cu1", text: "My Visa card payment keeps failing with checkout error 500 every time I try" };
    const m2 = { id: "m2", conversationId: "c2", customerId: "cu2", text: "Checkout blows up with a 500 server error whenever I pay with my Visa card" };
    s.addMessage(m1); s.addMessage(m2);
    const judge = tokenJudge([["visa", "checkout"]]);
    const deps = depsFor(s, judge);
    const r1 = await detectFromChat(inputFor(m1), deps);
    expect(r1.action).toBe("created");
    const r2 = await detectFromChat(inputFor(m2), deps);
    expect(r2.action).toBe("joined");
    expect(s.cands.size).toBe(1);
    const cand = [...s.cands.values()][0];
    expect(cand.members.size).toBe(2);
    expect(new Set(cand.members.values()).size).toBe(2);
  });

  it("two unrelated issues sharing generic words stay separate", async () => {
    const s = makeStore();
    s.addConversation("c1", W1, "cu1");
    s.addConversation("c2", W1, "cu2");
    const m1 = { id: "m1", conversationId: "c1", customerId: "cu1", text: "My Visa card payment keeps failing with checkout error 500" };
    const m2 = { id: "m2", conversationId: "c2", customerId: "cu2", text: "My bank transfer payment failed yesterday and the money has not arrived" };
    s.addMessage(m1); s.addMessage(m2);
    // tokenJudge requires the visa+checkout set to match: m2 will not match m1's cluster.
    const judge = tokenJudge([["visa", "checkout"]]);
    const deps = depsFor(s, judge);
    await detectFromChat(inputFor(m1), deps);
    // m2 mentions neither visa nor checkout specifics -> new candidate, no join.
    const r2 = await detectFromChat(inputFor(m2), deps);
    expect(r2.action).toBe("created");
    expect(s.cands.size).toBe(2);
  });

  it("one conversation with many complaints is a single non-surfaced candidate", async () => {
    const s = makeStore();
    s.addConversation("c1", W1, "cu1");
    const judge = tokenJudge([["visa"]]);
    const deps = depsFor(s, judge);
    for (let i = 0; i < 3; i++) {
      const m = { id: `m${i}`, conversationId: "c1", customerId: "cu1", text: `Visa checkout error 500 again, attempt number ${i} today and still failing badly` };
      s.addMessage(m);
      await detectFromChat(inputFor(m), deps);
    }
    expect(s.cands.size).toBe(1);
    const cand = [...s.cands.values()][0];
    expect(cand.members.size).toBe(1);
    expect(cand.messages.length).toBe(3);
  });

  it("short/greeting text is ignored without a model call", async () => {
    const s = makeStore();
    let calls = 0;
    const deps = depsFor(s, async () => { calls++; throw new Error("must not be called"); });
    expect(await detectFromChat({ workspaceId: W1, conversationId: "c", customerId: "u", messageId: "m", text: "hi" }, deps)).toEqual({ action: "ignored" });
    expect(calls).toBe(0);
  });

  it("retry of the same message dedupes", async () => {
    const s = makeStore();
    s.addConversation("c1", W1, "cu1");
    const m = { id: "m1", conversationId: "c1", customerId: "cu1", text: "Visa checkout error 500 blocks every single order I place today" };
    s.addMessage(m);
    const deps = depsFor(s, tokenJudge([["visa"]]));
    const r1 = await detectFromChat(inputFor(m), deps);
    expect(r1.action).toBe("created");
    const r2 = await detectFromChat(inputFor(m), deps);
    expect(r2.action).toBe("already_clustered");
    expect(s.cands.size).toBe(1);
  });

  it("failed attribution after create defers honestly instead of claiming created", async () => {
    const s = makeStore();
    s.addConversation("c1", W1, "cu1");
    const m = { id: "m1", conversationId: "c1", customerId: "cu1", text: "Visa checkout error 500 blocks every single order I place today" };
    s.addMessage(m);
    const base = depsFor(s, tokenJudge([["visa"]]));
    // Production 2026-10-22: candidate row written, attach failed (null).
    // Must NOT report created for an empty, unlinked candidate.
    const failing = { ...base, store: { ...base.store, addMessageToCandidate: async () => null } } as DetectDeps;
    const r1 = await detectFromChat(inputFor(m), failing);
    expect(r1.action).toBe("deferred");
    expect(s.cands.size).toBe(1);
    const orphan = [...s.cands.values()][0];
    expect(orphan.messages).toHaveLength(0);
    // A later genuine report can still join the pending orphan — no dupes.
    const m2 = { id: "m2", conversationId: "c1", customerId: "cu1", text: "Visa checkout error 500 again this morning, still blocked badly" };
    s.addMessage(m2);
    const r2 = await detectFromChat(inputFor(m2), depsFor(s, tokenJudge([["visa"]])));
    expect(r2.action).toBe("joined");
    expect(s.cands.size).toBe(1);
  });

  it("concurrent processing does not duplicate the first candidate", async () => {
    const s = makeStore();
    s.addConversation("c1", W1, "cu1");
    const m = { id: "m1", conversationId: "c1", customerId: "cu1", text: "Visa checkout error 500 blocks every single order I place today" };
    s.addMessage(m);
    const deps = depsFor(s, tokenJudge([["visa"]]));
    const [a, b] = await Promise.all([detectFromChat(inputFor(m), deps), detectFromChat(inputFor(m), deps)]);
    expect([a.action, b.action].sort()).toEqual(["already_clustered", "created"]);
    expect(s.cands.size).toBe(1);
  });

  it("cross-workspace isolation: same text, separate candidates", async () => {
    const s = makeStore();
    s.addConversation("c1", W1, "cu1");
    s.addConversation("c9", W2, "cu9");
    const m1 = { id: "m1", conversationId: "c1", customerId: "cu1", text: "Visa checkout error 500 blocks every single order I place today" };
    const m9 = { id: "m9", conversationId: "c9", customerId: "cu9", text: "Visa checkout error 500 blocks every single order I place today" };
    s.addMessage(m1); s.addMessage(m9);
    const deps = depsFor(s, tokenJudge([["visa"]]));
    await detectFromChat(inputFor(m1), deps);
    const r = await detectFromChat({ ...inputFor(m9), workspaceId: W2 }, deps);
    expect(r.action).toBe("created");
    expect(s.cands.size).toBe(2);
  });

  it("AI failure degrades without side effects", async () => {
    const s = makeStore();
    s.addConversation("c1", W1, "cu1");
    const m = { id: "m1", conversationId: "c1", customerId: "cu1", text: "Visa checkout error 500 blocks every single order I place today" };
    s.addMessage(m);
    const deps = depsFor(s, async () => { throw new Error("model down"); });
    expect(await detectFromChat(inputFor(m), deps)).toEqual({ action: "deferred" });
    expect(s.cands.size).toBe(0);
  });

  it("surfaced threshold requires two distinct conversations", async () => {
    expect(SURFACE_MIN_CONVERSATIONS).toBe(2);
    const s = makeStore();
    s.addConversation("c1", W1, "cu1");
    const m = { id: "m1", conversationId: "c1", customerId: "cu1", text: "Visa checkout error 500 blocks every single order I place today here" };
    s.addMessage(m);
    const deps = depsFor(s, tokenJudge([["visa"]]));
    await detectFromChat(inputFor(m), deps);
    const cand = [...s.cands.values()][0];
    expect(cand.members.size).toBe(1);
  });
});

describe("judge output validation (pure)", () => {
  const pending = new Set(["c1"]);
  const dismissed = new Set(["d1"]);
  it("accepts a well-formed match and nulls unknown ids", () => {
    const out = validateJudgeOutput({
      is_issue: true, title: "Visa 500s", summary: "Checkout fails", match_candidate_id: "c1",
      dismissed_match_id: "d9", quality: "high", rationale: "same error", evidence_quote: "500",
    }, pending, dismissed);
    expect(out).toMatchObject({ isIssue: true, matchCandidateId: "c1", dismissedMatchId: null, quality: "high" });
  });
  it("rejects empty titles and non-objects", () => {
    expect(validateJudgeOutput({ is_issue: true, title: "  ", summary: "x" }, pending, dismissed)).toBeNull();
    expect(validateJudgeOutput(null, pending, dismissed)).toBeNull();
    expect(validateJudgeOutput({ is_issue: "yes" }, pending, dismissed)).toBeNull();
  });
  it("not-issue short-circuits without title", () => {
    const out = validateJudgeOutput({ is_issue: false, rationale: "thanks" }, pending, dismissed)!;
    expect(out.isIssue).toBe(false);
    expect(out.matchCandidateId).toBeNull();
  });
  it("result type exposes all required fields", () => {
    const r: JudgeResult = {
      isIssue: true, title: "t", summary: "s", matchCandidateId: null,
      dismissedMatchId: "d1", quality: "low", rationale: "r",
    };
    expect(r.dismissedMatchId).toBe("d1");
  });
});

// ---- Live persistence: dedupe constraints + review flow on real Neon ----

const stamp = Date.now().toString(36);
const PW = "correct-horse-123";
const createdEmails: string[] = [];
const createdOrgIds: string[] = [];
const SLUG = `s5-ws-${stamp}`;

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

describe("candidate persistence + review (live Neon)", () => {
  it("setup: workspace, staffer, customer, two conversations", async () => {
    const orgId = organizationIdForSlug(SLUG);
    await ensureOrganization({ id: orgId, slug: SLUG, name: `Temp ${SLUG}` });
    await ensureWorkspace({ id: workspaceIdForSlug(SLUG), organizationId: orgId, slug: SLUG, name: `Temp ${SLUG}` });
    createdOrgIds.push(orgId);
    cookieJar = await signupSession(`s5-staff-${stamp}@example.test`);
    const { auth } = await import("../better-auth");
    void auth;
    const { neon } = await import("@neondatabase/serverless");
    const sql = neon(dbKey());
    const rows = (await sql`select id from "user" where email = ${`s5-staff-${stamp}@example.test`} limit 1`) as unknown as { id: string }[];
    await addOrganizationMember({ organizationId: orgId, userId: rows[0].id, role: "owner" });
  }, 120_000);

  it("persists a candidate, dedupes members, accepts into S4", async () => {
    const { ensureCustomer } = await import("../db");
    const { createConversation } = await import("../support-ops");
    const { createCandidate, addMessageToCandidate, messageAlreadyClustered, markCandidateAccepted, markCandidateDismissed, listCandidates } = await import("../issue-candidates");
    const { createIncident, addIncidentConversation, getIncidentForWorkspace } = await import("../incidents");
    const { createHash } = await import("node:crypto");
    const wsId = workspaceIdForSlug(SLUG);
    const mkCust = async (tag: string) => {
      const h = createHash("sha256").update(`${tag}-${stamp}`, "utf8").digest("hex");
      const { customerIdFor } = await import("../tenant");
      const cid = customerIdFor(wsId, h);
      await ensureCustomer({ id: cid, workspaceId: wsId, bootstrapHash: h });
      return cid;
    };
    const cu1 = await mkCust("a");
    const cu2 = await mkCust("b");
    const t1 = (await createConversation({ workspaceId: wsId, customerId: cu1, title: "T1" })).conversation;
    const t2 = (await createConversation({ workspaceId: wsId, customerId: cu2, title: "T2" })).conversation;
    const { addUserMessage } = await import("../support-ops");
    const mm1 = await addUserMessage({ conversationId: t1.id, content: "Visa checkout 500 error on every order attempt today", clientId: `s5-${stamp}-1` });
    const mm2 = await addUserMessage({ conversationId: t2.id, content: "Checkout fails with 500 for Visa cards repeatedly", clientId: `s5-${stamp}-2` });

    const cand = await createCandidate({ workspaceId: wsId, title: "Visa 500s", summary: "s", confidence: "high", rationale: "r" });
    expect((await listCandidates(wsId, { surfacedOnly: true })).length).toBe(0);
    await addMessageToCandidate({ candidateId: cand.id, workspaceId: wsId, messageId: mm1.id, conversationId: t1.id, customerId: cu1 });
    const dupe = await addMessageToCandidate({ candidateId: cand.id, workspaceId: wsId, messageId: mm1.id, conversationId: t1.id, customerId: cu1 });
    expect(dupe).toEqual({ memberAdded: false, messageAdded: false, duplicateOf: cand.id });
    await addMessageToCandidate({ candidateId: cand.id, workspaceId: wsId, messageId: mm2.id, conversationId: t2.id, customerId: cu2 });
    expect((await listCandidates(wsId, { surfacedOnly: true })).length).toBe(1);

    // Retry visibility: message known anywhere in workspace.
    expect(await messageAlreadyClustered(wsId, mm1.id)).toEqual({ candidateId: cand.id });

    // Accept into a real S4 incident: members wire through.
    const inc = await createIncident({ workspaceId: wsId, title: "Visa outage", createdByUserId: null });
    for (const convId of [t1.id, t2.id]) {
      await addIncidentConversation({ incidentId: inc.id, workspaceId: wsId, conversationId: convId });
    }
    await markCandidateAccepted({ candidateId: cand.id, workspaceId: wsId, incidentId: inc.id });
    const check = await getIncidentForWorkspace(wsId, inc.id);
    expect(check?.conversation_count).toBe(2);

    // Dismiss path on a second candidate + regen guard (no auto-recreate).
    const cand2 = await createCandidate({ workspaceId: wsId, title: "Other", summary: "s", confidence: "low", rationale: "r" });
    await markCandidateDismissed({ candidateId: cand2.id, workspaceId: wsId, note: "not reproducible" });
    expect((await listCandidates(wsId, { surfacedOnly: true })).length).toBe(0);
    expect((await listCandidates(wsId, {})).find((c) => c.id === cand2.id)?.status).toBe("dismissed");
  }, 120_000);
});
