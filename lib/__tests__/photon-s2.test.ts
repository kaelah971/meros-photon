import { describe, expect, it } from "vitest";
import {
  CONNECTIVITY_TEST_BODY,
  sendOperatorNotification,
  type NotifyDeps,
} from "../photon/notify";

// S2 tests: server-initiated notifications through injected fakes that
// replicate the Neon unique semantics (proactive idempotency slot +
// active-only binding resolution). Zero DB, zero network. The fake post
// watches the single authorized thread — never a raw recipient.

const WS_A = "ws-a";
const WS_B = "ws-b";
const USER = "user-1";
const THREAD = "thread-imessage-1";

type FakeBinding = { id: string; workspaceId: string; operatorUserId: string; threadId: string | null; status: "active" | "revoked" | "pending" };
type FakeMsg = { id: string; direction: "inbound" | "outbound"; status: string; providerMessageId: string | null; idempotencyKey: string | null; threadId: string | null; bindingId: string | null; workspaceId: string | null };

function makeNotifyFakes(overrides: Partial<NotifyDeps> = {}, shared?: { bindings: Map<string, FakeBinding>; msgs: FakeMsg[]; sends: { threadId: string; text: string }[]; seq: { n: number } }) {
  const bindings = shared?.bindings ?? new Map<string, FakeBinding>();
  if (!shared) {
    bindings.set("bind-1", { id: "bind-1", workspaceId: WS_A, operatorUserId: USER, threadId: THREAD, status: "active" });
  }
  const msgs: FakeMsg[] = shared?.msgs ?? [];
  const sends: { threadId: string; text: string }[] = shared?.sends ?? [];
  const seq = shared?.seq ?? { n: 0 };
  const base: NotifyDeps = {
    findBindingForOperator: async (workspaceId, operatorUserId) => {
      for (const b of bindings.values()) {
        if (b.workspaceId === workspaceId && b.operatorUserId === operatorUserId && b.status === "active") {
          return { id: b.id, workspaceId: b.workspaceId, operatorUserId: b.operatorUserId, threadId: b.threadId };
        }
      }
      return null;
    },
    checkStaff: async () => {},
  getPreferences: async () => ({
    proactiveEnabled: true,
    quietHoursEnabled: false,
    quietStart: "22:00",
    quietEnd: "07:00",
    timezone: "Africa/Lagos",
    malformed: false,
  }),
    claimProactive: async (input) => {
      const existing = input.idempotencyKey
        ? msgs.find((m) => m.direction === "outbound" && m.idempotencyKey === input.idempotencyKey)
        : undefined;
      if (existing) {
        return { id: existing.id, status: existing.status, providerMessageId: existing.providerMessageId, deduped: true };
      }
      const id = `out-${seq.n++}`;
      msgs.push({ id, direction: "outbound", status: "received", providerMessageId: null, idempotencyKey: input.idempotencyKey || null, threadId: input.threadId, bindingId: input.bindingId, workspaceId: input.workspaceId });
      return { id, status: "received", providerMessageId: null, deduped: false };
    },
    markSent: async (outboundId, providerId) => {
      const m = msgs.find((x) => x.id === outboundId);
      if (m) { m.status = "sent"; m.providerMessageId = providerId ?? null; }
    },
    markFailed: async (outboundId) => {
      const m = msgs.find((x) => x.id === outboundId);
      if (m) m.status = "failed";
    },
    postToThread: async (threadId, text) => {
      sends.push({ threadId, text });
      return { providerId: `prov-${sends.length}` };
    },
  };
  const deps = { ...base, ...overrides } as NotifyDeps;
  return { deps, bindings, msgs, sends };
}

const INPUT = {
  workspaceId: WS_A,
  operatorUserId: USER,
  type: "connectivity_test" as const,
  body: CONNECTIVITY_TEST_BODY,
  idempotencyKey: "key-1",
  isTest: false,
};

describe("active binding resolution", () => {
  it("sends to the active binding thread and persists provider id", async () => {
    const { deps, sends, msgs } = makeNotifyFakes();
    const res = await sendOperatorNotification(INPUT, deps);
    expect(res).toEqual({ ok: true, deduped: false, providerId: "prov-1", messageId: "out-0" });
    expect(sends).toHaveLength(1);
    expect(sends[0].threadId).toBe(THREAD);
    expect(sends[0].text).toBe(CONNECTIVITY_TEST_BODY);
    expect(msgs[0].status).toBe("sent");
    expect(msgs[0].providerMessageId).toBe("prov-1");
  });

  it("revoked bindings never resolve (revocation stops outbound)", async () => {
    // Null lookup = what resolveActiveBindingForOperator returns for
    // revoked/pending rows: the notify layer cannot see them at all.
    const f = makeNotifyFakes({
      findBindingForOperator: async () => null,
    });
    const res = await sendOperatorNotification(INPUT, f.deps);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("no_binding");
    expect(f.sends).toHaveLength(0);
  });

  it("unpaired sender is rejected without sending", async () => {
    const { deps, sends } = makeNotifyFakes({ findBindingForOperator: async () => null });
    const res = await sendOperatorNotification(INPUT, deps);
    expect(res).toEqual(expect.objectContaining({ ok: false, code: "no_binding", recoverable: true }));
    expect(sends).toHaveLength(0);
  });

  it("workspace isolation: binding from another workspace never sends", async () => {
    const { deps, sends } = makeNotifyFakes();
    const res = await sendOperatorNotification({ ...INPUT, workspaceId: WS_B }, deps);
    // findBindingForOperator is scoped to (workspace, operator): no row.
    expect(res.ok).toBe(false);
    if (!res.ok) expect(["no_binding", "workspace_mismatch"]).toContain(res.code);
    expect(sends).toHaveLength(0);
  });

  it("staff gate blocks removed operators without sending", async () => {
    const { deps, sends } = makeNotifyFakes({
      checkStaff: async () => { throw Object.assign(new Error("staff access required"), { status: 403 }); },
    });
    const res = await sendOperatorNotification(INPUT, deps);
    expect(res).toEqual(expect.objectContaining({ ok: false, code: "not_staff" }));
    expect(sends).toHaveLength(0);
  });
});

describe("conversation address", () => {
  it("missing thread returns a recoverable error and never sends", async () => {
    const { deps, sends } = makeNotifyFakes({
      findBindingForOperator: async () => ({ id: "bind-1", workspaceId: WS_A, operatorUserId: USER, threadId: null }),
    });
    const res = await sendOperatorNotification(INPUT, deps);
    expect(res).toEqual(expect.objectContaining({ ok: false, code: "no_conversation", recoverable: true }));
    expect(sends).toHaveLength(0);
  });
});

describe("provider failure honesty", () => {
  it("failed send is recorded failed and reported without fake success", async () => {
    const { deps, sends, msgs } = makeNotifyFakes({
      postToThread: async () => { throw new Error("spectrum unavailable"); },
    });
    const res = await sendOperatorNotification(INPUT, deps);
    expect(res).toEqual(expect.objectContaining({ ok: false, code: "provider_failed", recoverable: true }));
    expect(sends).toHaveLength(0);
    expect(msgs[0].status).toBe("failed");
  });
});

describe("idempotent proactive sends", () => {
  it("same key twice sends once; second returns the deduped receipt", async () => {
    const { deps, sends } = makeNotifyFakes();
    const first = await sendOperatorNotification(INPUT, deps);
    expect(first.ok).toBe(true);
    const second = await sendOperatorNotification(INPUT, deps);
    expect(second).toEqual({ ok: true, deduped: true, providerId: "prov-1", messageId: "out-0" });
    expect(sends).toHaveLength(1);
  });

  it("same key after a failure reports already_attempted without resending", async () => {
    let failOnce = true;
    const f = makeNotifyFakes({
      postToThread: async (threadId, text) => {
        if (failOnce) { failOnce = false; throw new Error("spectrum unavailable"); }
        return { providerId: "prov-late" };
      },
    });
    const first = await sendOperatorNotification(INPUT, f.deps);
    expect(first.ok).toBe(false);
    const second = await sendOperatorNotification(INPUT, f.deps);
    expect(second).toEqual(expect.objectContaining({ ok: false, code: "already_attempted", recoverable: true }));
    // No second post: the failed attempt is surfaced, never silently retried.
    expect(f.sends).toHaveLength(0);
  });
});

describe("cold-start recovery", () => {
  it("independent dep instances over one durable store dedupe across restarts", async () => {
    // One shared durable store (= Neon), two independently constructed dep
    // objects (= two cold-started serverless invocations, zero shared memory).
    const shared = {
      bindings: new Map<string, FakeBinding>([
        ["bind-1", { id: "bind-1", workspaceId: WS_A, operatorUserId: USER, threadId: THREAD, status: "active" as const }],
      ]),
      msgs: [] as FakeMsg[],
      sends: [] as { threadId: string; text: string }[],
      seq: { n: 0 },
    };
    const first = makeNotifyFakes({}, shared);
    const second = makeNotifyFakes({}, shared);
    const r1 = await sendOperatorNotification(INPUT, first.deps);
    expect(r1).toEqual({ ok: true, deduped: false, providerId: "prov-1", messageId: "out-0" });
    // A redelivery after a restart with the SAME key must not resend,
    // even though the second dep object never saw the first send.
    const r2 = await sendOperatorNotification(INPUT, second.deps);
    expect(r2).toEqual({ ok: true, deduped: true, providerId: "prov-1", messageId: "out-0" });
    expect(shared.sends).toHaveLength(1);
  });
});

describe("durable history shape", () => {
  it("proactive attempts persist direction/status/key for later retrieval", async () => {
    const { deps, msgs } = makeNotifyFakes();
    await sendOperatorNotification(INPUT, deps);
    await sendOperatorNotification({ ...INPUT, idempotencyKey: "key-2", body: "Second." }, deps);
    expect(msgs).toHaveLength(2);
    expect(msgs.map((m) => [m.direction, m.status, m.idempotencyKey])).toEqual([
      ["outbound", "sent", "key-1"],
      ["outbound", "sent", "key-2"],
    ]);
    for (const m of msgs) {
      expect(m.workspaceId).toBe(WS_A);
      expect(m.bindingId).toBe("bind-1");
      expect(m.threadId).toBe(THREAD);
    }
  });
});
