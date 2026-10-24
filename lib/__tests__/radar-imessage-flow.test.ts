import { describe, expect, it } from "vitest";
import { detectFromChat, type DetectDeps, type DetectStore } from "../detection";
import { maybeSendRadarAlert, shouldEvaluateRadar } from "../radar";
import { sendOperatorNotification, type NotifyDeps } from "../photon/notify";
import { resolveReference } from "../photon/investigate";

// End-to-end automatic Radar → iMessage flow with fakes ONLY at the
// persistence/transport edges. Every orchestration layer is real:
// detectFromChat → shouldEvaluateRadar → maybeSendRadarAlert →
// sendOperatorNotification → resolveReference. No DB, no network,
// no real outbound messages.

// ---- Candidate store with production uniqueness semantics ----
type FakeCand = {
  id: string;
  workspaceId: string;
  status: "pending";
  title: string;
  summary: string;
  members: { conversationId: string; customerId: string; addedAt: string }[];
  messages: string[];
};
function makeCandidateStore() {
  const cands = new Map<string, FakeCand>();
  let seq = 0;
  const store: DetectStore = {
    messageAlreadyClustered: async (workspaceId, messageId) => {
      for (const c of cands.values()) {
        if (c.workspaceId === workspaceId && c.messages.includes(messageId)) return { candidateId: c.id };
      }
      return null;
    },
    pendingCandidatesForConversation: async () => [],
    pendingCandidateContexts: async (workspaceId) => {
      const out = [];
      for (const c of cands.values()) {
        if (c.workspaceId === workspaceId && c.status === "pending") {
          out.push({ id: c.id, title: c.title, summary: c.summary, confidence: "high" as const, excerpts: [] });
        }
      }
      return out;
    },
    dismissedCandidateTitles: async () => [],
    createCandidate: async (input) => {
      const id = `cand-${++seq}`;
      cands.set(id, { id, workspaceId: input.workspaceId, status: "pending", title: input.title, summary: input.summary, members: [], messages: [] });
      return { id };
    },
    addMessageToCandidate: async (input) => {
      for (const other of cands.values()) {
        if (other.workspaceId === input.workspaceId && other.messages.includes(input.messageId)) {
          return { memberAdded: false, messageAdded: false, duplicateOf: other.id };
        }
      }
      const c = cands.get(input.candidateId);
      if (!c) return null;
      const memberAdded = !c.members.some((m) => m.conversationId === input.conversationId);
      c.members.push({ conversationId: input.conversationId, customerId: input.customerId, addedAt: new Date().toISOString() });
      c.messages.push(input.messageId);
      return { memberAdded, messageAdded: true, duplicateOf: null };
    },
    deleteCandidate: async (candidateId) => {
      cands.delete(candidateId);
    },
  };
  return { cands, store };
}

// ---- Notify edge fakes replicating Neon unique semantics ----
type FakeBinding = { id: string; workspaceId: string; operatorUserId: string; threadId: string | null };
type FakeOutbound = { id: string; status: string; providerMessageId: string | null; idempotencyKey: string | null };
function makeNotifyFakes(bindings: FakeBinding[], opts?: { proactive?: boolean; staff?: boolean; quietAllDay?: boolean; failPost?: boolean }) {
  const outbounds: FakeOutbound[] = [];
  const sends: { threadId: string; text: string }[] = [];
  let seq = 0;
  const deps: NotifyDeps = {
    findBindingForOperator: async (ws, user) => {
      const b = bindings.find((x) => x.workspaceId === ws && x.operatorUserId === user);
      return b ? { id: b.id, workspaceId: b.workspaceId, operatorUserId: b.operatorUserId, threadId: b.threadId } : null;
    },
    checkStaff: async () => {
      if (opts?.staff === false) throw new Error("not staff");
    },
    getPreferences: async () => ({
      proactiveEnabled: opts?.proactive ?? true,
      quietHoursEnabled: opts?.quietAllDay ?? false,
      quietStart: "00:00",
      quietEnd: "23:59",
      timezone: "Africa/Lagos",
      malformed: false,
    }),
    claimProactive: async (input) => {
      const existing = outbounds.find((m) => m.idempotencyKey === input.idempotencyKey);
      if (existing) return { id: existing.id, status: existing.status, providerMessageId: existing.providerMessageId, deduped: true };
      const id = `out-${seq++}`;
      outbounds.push({ id, status: "received", providerMessageId: null, idempotencyKey: input.idempotencyKey });
      return { id, status: "received", providerMessageId: null, deduped: false };
    },
    markSent: async (id, pid) => {
      const m = outbounds.find((x) => x.id === id);
      if (m) { m.status = "sent"; m.providerMessageId = pid ?? null; }
    },
    markFailed: async (id) => {
      const m = outbounds.find((x) => x.id === id);
      if (m) m.status = "failed";
    },
    postToThread: async (threadId, text) => {
      if (opts?.failPost) throw new Error("spectrum unavailable");
      sends.push({ threadId, text });
      return { providerId: "prov-1" };
    },
  };
  return { deps, outbounds, sends };
}

const WS = "ws-nova";
const judge = () => async (input: { message: string; candidates: { id: string }[] }) => ({
  isIssue: true,
  title: "Checkout fails with HTTP 422",
  summary: "checkout fails across several customers",
  matchCandidateId: input.candidates.length > 0 ? input.candidates[0].id : null,
  dismissedMatchId: null,
  quality: "high" as const,
  rationale: "same symptom",
});
const detectInput = (n: number, cust: string, conv: string) => ({
  workspaceId: WS,
  conversationId: conv,
  customerId: cust,
  messageId: `msg-${n}`,
  text: "My checkout keeps failing with HTTP 422 every time I try to pay with my card in this store.",
});

describe("automatic Radar → iMessage flow (real orchestration, edge fakes)", () => {
  it("3 qualifying customers trigger exactly one outbound per operator with provider acceptance recorded", async () => {
    const { cands, store } = makeCandidateStore();
    const outcomes = [];
    for (const [n, cust, conv] of [[1, "cu-1", "cv-1"], [2, "cu-2", "cv-2"], [3, "cu-3", "cv-3"]] as const) {
      outcomes.push(await detectFromChat(detectInput(n, cust, conv), { judge: judge(), store, listRecentExcerpts: async () => [] }));
    }
    expect(outcomes.map((o) => o.action)).toEqual(["created", "joined", "joined"]);
    expect(outcomes.map((o) => shouldEvaluateRadar(o))).toEqual([false, true, true]);
    const candId = (outcomes[0] as { candidateId: string }).candidateId;
    expect(cands.get(candId)!.members).toHaveLength(3);

    // Second member joins but threshold unmet → evaluated, honestly ineligible.
    const { deps, outbounds, sends } = makeNotifyFakes([{ id: "b-1", workspaceId: WS, operatorUserId: "op-1", threadId: "thread-1" }]);
    const radarDeps = {
      loadCandidate: async (id: string, ws: string) => {
        const c = cands.get(id);
        return c && c.workspaceId === ws ? { id: c.id, status: c.status, title: c.title, summary: c.summary, updated_at: new Date().toISOString() } : null;
      },
      listMembers: async (id: string, ws: string) =>
        (cands.get(id)?.workspaceId === ws ? cands.get(id)!.members.map((m) => ({ conversation_id: m.conversationId, customer_id: m.customerId, added_at: m.addedAt })) : []),
      countMessages: async (id: string) => cands.get(id)?.messages.length ?? 0,
      listOptedIn: async () => ["op-1"],
      resolveRecipient: async (ws: string, user: string) =>
        ws === WS && user === "op-1" ? { operatorUserId: user, bindingId: "b-1", threadId: "thread-1" } : null,
      workspaceSlug: async () => "novacart-support",
      notify: async (input: { workspaceId: string; operatorUserId: string; bindingId: string; threadId: string; body: string; idempotencyKey: string }) =>
        sendOperatorNotification(
          { workspaceId: input.workspaceId, operatorUserId: input.operatorUserId, type: "incident_detected", body: input.body, idempotencyKey: input.idempotencyKey, isTest: false },
          deps,
        ).then((r) => {
          if (r.ok) return r.deduped ? { sent: false, deduped: true, reason: "already attempted for this key" } : { sent: true, deduped: false, reason: "accepted by provider — handset delivery not confirmed" };
          return { sent: false, deduped: false, reason: r.message };
        }),
    };
    const result = await maybeSendRadarAlert(WS, candId, radarDeps);
    expect(result).toMatchObject({ action: "alerted", sent: 1, deduped: 0, suppressed: 0 });
    expect(sends).toHaveLength(1);
    expect(sends[0].threadId).toBe("thread-1");
    expect(sends[0].text).toContain("MEROS / INCIDENT RADAR");
    expect(sends[0].text).not.toMatch(/cu-1|msg-1|422 Wester/);
    // Provider acceptance recorded honestly with provider id.
    expect(outbounds).toHaveLength(1);
    expect(outbounds[0]).toMatchObject({ status: "sent", providerMessageId: "prov-1" });

    // Rerun (retry/duplicate evaluation) → deduped, never resent.
    const again = await maybeSendRadarAlert(WS, candId, radarDeps);
    expect(again).toMatchObject({ action: "alerted", sent: 0, deduped: 1 });
    expect(sends).toHaveLength(1);
  });

  it("operator without an active binding is suppressed without leaking or sending", async () => {
    const { cands, store } = makeCandidateStore();
    for (const [n, cust, conv] of [[1, "cu-1", "cv-1"], [2, "cu-2", "cv-2"], [3, "cu-3", "cv-3"]] as const) {
      await detectFromChat(detectInput(n, cust, conv), { judge: judge(), store, listRecentExcerpts: async () => [] });
    }
    const candId = [...cands.keys()][0];
    const { deps, sends } = makeNotifyFakes([]);
    const res = await sendOperatorNotification(
      { workspaceId: WS, operatorUserId: "op-ghost", type: "incident_detected", body: "MEROS / INCIDENT RADAR\n\nPossible recurring issue", idempotencyKey: "radar:cand:op-ghost", isTest: false },
      deps,
    );
    expect(res).toMatchObject({ ok: false, code: "no_binding" });
    expect(sends).toHaveLength(0);
    expect(cands.get(candId)!.members).toHaveLength(3);
  });

  it("foreign workspace candidate defers with zero sends and zero disclosure", async () => {
    const { cands, store } = makeCandidateStore();
    for (const [n, cust, conv] of [[1, "cu-1", "cv-1"], [2, "cu-2", "cv-2"], [3, "cu-3", "cv-3"]] as const) {
      await detectFromChat(detectInput(n, cust, conv), { judge: judge(), store, listRecentExcerpts: async () => [] });
    }
    const candId = [...cands.keys()][0];
    const sent: unknown[] = [];
    const res = await maybeSendRadarAlert(
      "ws-other",
      candId,
      {
        loadCandidate: async (id: string, ws: string) => {
          const c = cands.get(id);
          return c && c.workspaceId === ws ? { id: c.id, status: c.status, title: c.title, summary: c.summary, updated_at: new Date().toISOString() } : null;
        },
        listMembers: async () => [],
        countMessages: async () => 0,
        listOptedIn: async () => ["op-1"],
        resolveRecipient: async () => null,
        workspaceSlug: async () => null,
        notify: async () => { sent.push(1); return { sent: true, deduped: false, reason: "x" }; },
      },
    );
    expect(res).toMatchObject({ action: "deferred" });
    expect(sent).toHaveLength(0);
  });

  it("investigate <ref> resolves own records and stays unknown for foreign refs", () => {
    const own = "9d643921-35e1-4fdc-89f5-b98a11d0df0d";
    const cands = [{ id: own, title: "Checkout fails" }];
    const incs: { id: string; title: string }[] = [];
    expect(resolveReference(own, cands, incs)).toMatchObject({ kind: "candidate", id: own });
    expect(resolveReference(own.slice(0, 8), cands, incs)).toMatchObject({ kind: "candidate", id: own });
    expect(resolveReference("aaaaaaaa-1111-2222-3333-444444444444", cands, incs)).toEqual({ kind: "unknown" });
    expect(resolveReference("!!!", cands, incs)).toEqual({ kind: "unknown" });
  });
});

describe("Radar regression seams (no rule weakening, failures observable)", () => {
  const radarDepsFor = (
    cands: Map<string, FakeCand>,
    candId: string,
    notify: (input: { workspaceId: string; operatorUserId: string; bindingId: string; threadId: string; body: string; idempotencyKey: string }) => Promise<{ sent: boolean; deduped: boolean; reason: string }>,
    status = "pending",
  ) => ({
    loadCandidate: async (id: string, ws: string) => {
      const c = cands.get(id);
      return c && c.workspaceId === ws
        ? { id: c.id, status, title: c.title, summary: c.summary, updated_at: new Date().toISOString() }
        : null;
    },
    listMembers: async (id: string, ws: string) =>
      cands.get(id)?.workspaceId === ws
        ? cands.get(id)!.members.map((m) => ({ conversation_id: m.conversationId, customer_id: m.customerId, added_at: m.addedAt }))
        : [],
    countMessages: async (id: string) => cands.get(id)?.messages.length ?? 0,
    listOptedIn: async () => ["op-1"],
    resolveRecipient: async (ws: string, user: string) =>
      ws === WS && user === "op-1" ? { operatorUserId: user, bindingId: "b-1", threadId: "thread-1" } : null,
    workspaceSlug: async () => "novacart-support",
    notify,
  });

  const qualifyThree = async (store: DetectStore) => {
    for (const [n, cust, conv] of [[1, "cu-1", "cv-1"], [2, "cu-2", "cv-2"], [3, "cu-3", "cv-3"]] as const) {
      await detectFromChat(detectInput(n, cust, conv), { judge: judge(), store, listRecentExcerpts: async () => [] });
    }
  };

  it("two customers stay ineligible: evaluated, zero sends, honest reason", async () => {
    const { cands, store } = makeCandidateStore();
    const o1 = await detectFromChat(detectInput(1, "cu-1", "cv-1"), { judge: judge(), store, listRecentExcerpts: async () => [] });
    const o2 = await detectFromChat(detectInput(2, "cu-2", "cv-2"), { judge: judge(), store, listRecentExcerpts: async () => [] });
    expect(o1.action).toBe("created");
    expect(o2.action).toBe("joined");
    expect(shouldEvaluateRadar(o2)).toBe(true); // evaluated on genuine join…
    const candId = (o1 as { candidateId: string }).candidateId;
    let calls = 0;
    const res = await maybeSendRadarAlert(WS, candId, radarDepsFor(cands, candId, async () => { calls++; return { sent: true, deduped: false, reason: "x" }; }));
    expect(res).toMatchObject({ action: "ineligible" }); // …but threshold unmet
    expect(calls).toBe(0);
  });

  it("duplicate report clusters without re-evaluation", async () => {
    const { store } = makeCandidateStore();
    const deps = { judge: judge(), store, listRecentExcerpts: async () => [] };
    const first = await detectFromChat(detectInput(1, "cu-1", "cv-1"), deps);
    expect(first.action).toBe("created");
    const dup = await detectFromChat(detectInput(1, "cu-1", "cv-1"), deps);
    expect(dup.action).toBe("already_clustered");
    expect(shouldEvaluateRadar(dup)).toBe(false);
  });

  it("concurrent same-key sends deliver once: one accepted, one deduped", async () => {
    const { deps, outbounds, sends } = makeNotifyFakes([{ id: "b-1", workspaceId: WS, operatorUserId: "op-1", threadId: "thread-1" }]);
    const input = { workspaceId: WS, operatorUserId: "op-1", type: "incident_detected" as const, body: "MEROS / INCIDENT RADAR\n\nPossible recurring issue", idempotencyKey: "radar:race:op-1", isTest: false };
    const [a, b] = await Promise.all([sendOperatorNotification(input, deps), sendOperatorNotification(input, deps)]);
    const sent = [a, b].filter((r) => r.ok && !r.deduped);
    // The in-flight second claim sees the first attempt's unconfirmed slot
    // and reports already_attempted — never a double send. (A completed
    // prior send would instead dedupe ok.) Either way exactly one post.
    const other = [a, b].find((r) => !(r.ok && !r.deduped));
    expect(sent).toHaveLength(1);
    expect(other).toMatchObject({ ok: false, code: "already_attempted" });
    expect(sends).toHaveLength(1);
    expect(outbounds).toHaveLength(1); // prod concurrency relies on the Neon unique slot in claimProactiveSlot
  });

  it("opted-out operator is suppressed before any slot is claimed", async () => {
    const { deps, outbounds, sends } = makeNotifyFakes(
      [{ id: "b-1", workspaceId: WS, operatorUserId: "op-1", threadId: "thread-1" }],
      { proactive: false },
    );
    const res = await sendOperatorNotification(
      { workspaceId: WS, operatorUserId: "op-1", type: "incident_detected", body: "MEROS / INCIDENT RADAR\n\nPossible recurring issue", idempotencyKey: "radar:optout:op-1", isTest: false },
      deps,
    );
    expect(res).toMatchObject({ ok: false, code: "suppressed_disabled", suppressed: true });
    expect(sends).toHaveLength(0);
    expect(outbounds).toHaveLength(0);
  });

  it("quiet hours hold the alert without consuming a key", async () => {
    const { deps, outbounds, sends } = makeNotifyFakes(
      [{ id: "b-1", workspaceId: WS, operatorUserId: "op-1", threadId: "thread-1" }],
      { quietAllDay: true },
    );
    const res = await sendOperatorNotification(
      { workspaceId: WS, operatorUserId: "op-1", type: "incident_detected", body: "MEROS / INCIDENT RADAR\n\nPossible recurring issue", idempotencyKey: "radar:quiet:op-1", isTest: false },
      deps,
    );
    expect(res).toMatchObject({ ok: false, code: "suppressed_quiet_hours", suppressed: true });
    expect(sends).toHaveLength(0);
    expect(outbounds).toHaveLength(0);
  });

  it("provider failure is recorded and never retried with a fresh Radar key", async () => {
    const { cands, store } = makeCandidateStore();
    await qualifyThree(store);
    const candId = [...cands.keys()][0];
    const { deps, outbounds, sends } = makeNotifyFakes(
      [{ id: "b-1", workspaceId: WS, operatorUserId: "op-1", threadId: "thread-1" }],
      { failPost: true },
    );
    const notify = (input: { workspaceId: string; operatorUserId: string; idempotencyKey: string }) =>
      sendOperatorNotification(
        { workspaceId: input.workspaceId, operatorUserId: input.operatorUserId, type: "incident_detected", body: "MEROS / INCIDENT RADAR\n\nPossible recurring issue", idempotencyKey: input.idempotencyKey, isTest: false },
        deps,
      ).then((r) => {
        if (r.ok) return r.deduped ? { sent: false, deduped: true, reason: "already attempted for this key" } : { sent: true, deduped: false, reason: "accepted by provider — handset delivery not confirmed" };
        return { sent: false, deduped: false, reason: r.message };
      });
    const res = await maybeSendRadarAlert(WS, candId, radarDepsFor(cands, candId, notify));
    expect(res).toMatchObject({ action: "alerted", sent: 0, suppressed: 1 });
    expect(sends).toHaveLength(0);
    expect(outbounds[0].status).toBe("failed");
    const retry = await sendOperatorNotification(
      { workspaceId: WS, operatorUserId: "op-1", type: "incident_detected", body: "MEROS / INCIDENT RADAR\n\nPossible recurring issue", idempotencyKey: `radar:${candId}:op-1`, isTest: false },
      deps,
    );
    // Same key after a failed attempt is reported, never silently resent.
    expect(retry).toMatchObject({ ok: false, code: "already_attempted" });
    expect(sends).toHaveLength(0);
  });

  it("classification failure defers honestly and the next genuine report still recovers", async () => {
    const { cands, store } = makeCandidateStore();
    const failing = { judge: (async () => { throw new Error("judge down"); }) as unknown as DetectDeps["judge"], store, listRecentExcerpts: async () => [] };
    const outcome = await detectFromChat(detectInput(1, "cu-1", "cv-1"), failing);
    expect(outcome.action).toBe("deferred");
    expect(cands.size).toBe(0);
    expect(shouldEvaluateRadar(outcome)).toBe(false);
    // Genuine later report recovers the flow (plus the lazy sweep in detection-recovery.ts, covered by detection-recovery.test.ts).
    const recovered = await detectFromChat(detectInput(2, "cu-1", "cv-1"), { judge: judge(), store, listRecentExcerpts: async () => [] });
    expect(recovered.action).toBe("created");
  });

  it("accepted incident is no longer pending: ineligible, zero sends", async () => {
    const { cands, store } = makeCandidateStore();
    await qualifyThree(store);
    const candId = [...cands.keys()][0];
    let calls = 0;
    const res = await maybeSendRadarAlert(WS, candId, radarDepsFor(cands, candId, async () => { calls++; return { sent: true, deduped: false, reason: "x" }; }, "accepted"));
    expect(res).toMatchObject({ action: "ineligible" });
    expect((res as { reason: string }).reason).toMatch(/not pending/);
    expect(calls).toBe(0);
  });
});
