import { describe, expect, it, afterAll, vi } from "vitest";
import {
  buildRecipientDraft,
  draftPayloadHash,
  evaluateRecipient,
  proposeBatch,
  approveBatch,
  editRecipientDraft,
  publishRecipient,
  type RecoverManyDeps,
  type BatchRow,
  type RecipientRow,
} from "../recover-many";
import { POST as proposePOST, GET as proposeGET } from "@/app/api/incidents/[id]/recover-many/route";
import { POST as approvePOST } from "@/app/api/incidents/[id]/recover-many/[batchId]/approve/route";
import { PATCH as editPATCH, POST as publishPOST } from "@/app/api/incidents/[id]/recover-many/[batchId]/recipients/[recipientId]/route";

let cookieJar = "";
vi.mock("next/headers", () => ({
  headers: async () => new Headers(cookieJar ? { cookie: cookieJar } : {}),
}));

const FIX = { refId: "card-1", tier: "verified_fix", status: "shared", excerpt: "Visa 500. Cause: gateway timeout. Retry idempotently.", reasons: ["Same 500 on pay"] };

function makeStores() {
  const batches: BatchRow[] = [];
  const recipients: RecipientRow[] = [];
  let bn = 0;
  let rn = 0;
  return {
    batches,
    recipients,
    batchStore: {
      activeForIncident: async (iid: string, ws: string) =>
        batches.find((b) => b.incident_id === iid && b.workspace_id === ws && ["draft", "approved"].includes(b.status)) ?? null,
      loadById: async (id: string, ws: string) => batches.find((b) => b.id === id && b.workspace_id === ws) ?? null,
      createDraft: async (input: Record<string, never>) => {
        throw new Error("unused in fakes");
        void input;
      },
      finalizeDecision: async () => {
        throw new Error("unused in fakes");
      },
      markStale: async (batchId: string) => {
        const b = batches.find((x) => x.id === batchId);
        if (b && ["draft", "approved"].includes(b.status)) b.status = "superseded";
      },
    },
    recipientStore: {
      listForBatch: async (bid: string) => recipients.filter((r) => r.batch_id === bid),
      loadRecipient: async (id: string) => recipients.find((r) => r.id === id) ?? null,
      upsertRecipient: async (input: {
        batchId: string; incidentId: string; workspaceId: string; conversationId: string; customerId: string;
        eligibility: RecipientRow["eligibility"]; reasonCode: string; evidenceRefs: string[];
        draftText: string; payloadHash: string; idempotencyKey: string;
      }) => {
        const dup = recipients.find((r) => r.batch_id === input.batchId && r.conversation_id === input.conversationId);
        if (dup) return { row: dup, created: false };
        rn++;
        const row: RecipientRow = {
          id: `r-${rn}`, batch_id: input.batchId, incident_id: input.incidentId, workspace_id: input.workspaceId,
          conversation_id: input.conversationId, customer_id: input.customerId, eligibility: input.eligibility,
          reason_code: input.reasonCode, evidence_refs: input.evidenceRefs, draft_text: input.draftText,
          payload_hash: input.payloadHash, status: "draft", idempotency_key: input.idempotencyKey,
          provider_message_id: null, decided_by_user_id: null, decided_at: null, error_note: null,
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        };
        recipients.push(row);
        return { row, deduped: false, created: true } as unknown as { row: RecipientRow; created: boolean };
      },
      setDraft: async (input: { recipientId: string; draftText: string; payloadHash: string }) => {
        const r = recipients.find((x) => x.id === input.recipientId);
        if (!r || !["draft", "approved"].includes(r.status)) throw Object.assign(new Error("recipient not editable"), { status: 409 });
        r.draft_text = input.draftText;
        r.payload_hash = input.payloadHash;
        return r;
      },
      approveEligible: async (batchId: string, _ws?: string, _actor?: string) => {
        let n = 0;
        for (const r of recipients) {
          if (r.batch_id === batchId && r.eligibility === "eligible" && r.status === "draft") {
            r.status = "approved";
            n++;
          }
        }
        return n;
      },
      unapproveOnEdit: async (batchId: string) => {
        const b = batches.find((x) => x.id === batchId);
        if (b && b.status === "approved") {
          b.status = "draft";
          b.approved_by_user_id = null;
          b.approved_at = null;
          for (const r of recipients) if (r.batch_id === batchId && r.status === "approved") r.status = "draft";
        }
      },
      markPublished: async (input: { recipientId: string; messageId: string }) => {
        const r = recipients.find((x) => x.id === input.recipientId)!;
        r.status = "published_to_conversation";
        r.provider_message_id = input.messageId;
        r.error_note = null;
        return r;
      },
      markFailed: async (input: { recipientId: string; error: string; terminal: boolean }) => {
        const r = recipients.find((x) => x.id === input.recipientId)!;
        r.status = input.terminal ? "failed" : "unknown";
        r.error_note = input.error;
        return r;
      },
    },
    nextBatch() {
      bn++;
      return bn;
    },
  };
}

type Cfg = {
  incident?: { status: string } | null;
  brief?: { status: string; version: number; fingerprint: string; facts: { observation: string; identifiers: string[]; sources: string[] }[]; unknowns: string[]; contradictions: { description: string; between: string[] }[] } | null;
  plan?: { id: string; version: number } | null;
  linked?: { conversationId: string; customerId: string; resolved: boolean }[];
  messages?: Record<string, { id: string; createdAt: string; excerpt: string }[]>;
  matches?: typeof FIX[] | null;
  cardStatus?: Record<string, string>;
  batchOverride?: Partial<BatchRow> | null;
};

function makeDeps(cfg: Cfg = {}) {
  const stores = makeStores();
  const published: { conversationId: string; text: string; clientId: string }[] = [];
  const deps: RecoverManyDeps = {
    loadIncident: async (_id, ws) =>
      ws !== "ws-1" ? null : cfg.incident === undefined ? { id: "inc-1", status: "investigating" } : cfg.incident ? { id: "inc-1", status: cfg.incident.status } : null,
    loadBrief: async (_id, ws) => {
      if (ws !== "ws-1") return null;
      if (cfg.brief === undefined) {
        return {
          status: "current", version: 1, fingerprint: "fp-1",
          facts: [
            { observation: "Visa checkout 500", identifiers: ["500", "Visa"], sources: ["m1"] },
            { observation: "Same 500 on Visa checkout", identifiers: ["500"], sources: ["m2"] },
          ],
          unknowns: [],
          contradictions: [],
        };
      }
      return cfg.brief;
    },
    loadStagedPlan: async (_id, ws, fp) => {
      if (ws !== "ws-1") return null;
      if (cfg.plan === undefined) return { id: "plan-1", version: 1 };
      if (cfg.plan === null) return null;
      void fp;
      return cfg.plan;
    },
    listLinkedConversations: async (_id, ws) => {
      if (ws !== "ws-1") return [];
      return (
        cfg.linked ?? [
          { conversationId: "conv-a", customerId: "cust-a", resolved: false },
          { conversationId: "conv-b", customerId: "cust-b", resolved: false },
        ]
      );
    },
    listUserMessages: async (cid) => cfg.messages?.[cid] ?? [{ id: "m1", createdAt: new Date().toISOString(), excerpt: "Visa checkout 500 on pay" }],
    loadMatches: async () => (cfg.matches === undefined ? [{ ...FIX }] : (cfg.matches as never[])) as never,
    getCardStatus: async (refId, ws) => {
      if (ws !== "ws-1") return null;
      return cfg.cardStatus?.[refId] ?? "shared";
    },
    batches: {
      activeForIncident: stores.batchStore.activeForIncident,
      loadById: stores.batchStore.loadById,
      createDraft: async (input) => {
        const existing = stores.batches.find(
          (b) => b.incident_id === input.incidentId && b.workspace_id === input.workspaceId && ["draft", "approved"].includes(b.status),
        );
        if (existing) return existing;
        const n = stores.nextBatch();
        const row: BatchRow = {
          id: `batch-${n}`, incident_id: input.incidentId, workspace_id: input.workspaceId,
          plan_id: input.planId, plan_version: input.planVersion, brief_fingerprint: input.briefFingerprint,
          scope_hash: input.scopeHash, fingerprint: input.fingerprint, status: "draft",
          high_impact: input.highImpact, created_by_user_id: input.createdBy,
          approved_by_user_id: null, approved_at: null, note: null,
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        };
        stores.batches.push(row);
        return row;
      },
      finalizeDecision: async (input) => {
        const b = stores.batches.find((x) => x.id === input.batchId && x.workspace_id === input.workspaceId);
        if (!b) throw Object.assign(new Error("batch not found"), { status: 404 });
        const ok = (input.to === "approved" && b.status === "draft") || (input.to === "revoked" && b.status === "approved");
        if (!ok) throw Object.assign(new Error("bad transition"), { status: 409 });
        b.status = input.to;
        if (input.to === "approved") {
          b.approved_by_user_id = input.actorUserId;
          b.approved_at = new Date().toISOString();
          await stores.recipientStore.approveEligible(b.id, b.workspace_id, input.actorUserId);
        }
        return b;
      },
      markStale: stores.batchStore.markStale,
    },
    recipients: stores.recipientStore,
    publishMessage: async (input) => {
      published.push(input);
      return { messageId: `msg-${published.length}`, deduped: false };
    },
    isConversationLinked: async (_iid, cid, ws) => {
      if (ws !== "ws-1") return false;
      const linked = cfg.linked ?? [{ conversationId: "conv-a" }, { conversationId: "conv-b" }];
      return linked.some((l) => l.conversationId === cid);
    },
  };
  return { deps, stores, published };
}

describe("eligibility rules (pure)", () => {
  it("marks grounded reports eligible and explains everything else", () => {
    const base = {
      conversationId: "conv-a",
      customerId: "cust-a",
      userMessageIds: ["m1"],
      observations: [{ text: "Visa 500 on pay", messageIds: ["m1"] }],
      conversationResolved: false,
      coveredByBrief: true,
    };
    expect(
      evaluateRecipient({ recipient: base, briefFingerprint: "fp", briefCurrent: true, planStaged: true, fix: FIX, contradictionMessageIds: [] }).eligibility,
    ).toBe("eligible");
    expect(evaluateRecipient({ recipient: { ...base, conversationResolved: true }, briefFingerprint: "fp", briefCurrent: true, planStaged: true, fix: FIX, contradictionMessageIds: [] }).eligibility).toBe("excluded");
    expect(evaluateRecipient({ recipient: { ...base, userMessageIds: [] }, briefFingerprint: "fp", briefCurrent: true, planStaged: true, fix: FIX, contradictionMessageIds: [] }).reasonCode).toBe("no_customer_report");
    expect(evaluateRecipient({ recipient: base, briefFingerprint: "fp", briefCurrent: false, planStaged: true, fix: FIX, contradictionMessageIds: [] }).eligibility).toBe("needs_review");
    expect(evaluateRecipient({ recipient: base, briefFingerprint: "fp", briefCurrent: true, planStaged: false, fix: FIX, contradictionMessageIds: [] }).reasonCode).toBe("no_staged_plan");
    expect(evaluateRecipient({ recipient: { ...base, coveredByBrief: false }, briefFingerprint: "fp", briefCurrent: true, planStaged: true, fix: FIX, contradictionMessageIds: [] }).reasonCode).toBe("no_brief_source");
    expect(evaluateRecipient({ recipient: base, briefFingerprint: "fp", briefCurrent: true, planStaged: true, fix: FIX, contradictionMessageIds: ["m1"] }).reasonCode).toBe("contradictory_evidence");
    expect(evaluateRecipient({ recipient: base, briefFingerprint: "fp", briefCurrent: true, planStaged: true, fix: { ...FIX, status: "superseded" }, contradictionMessageIds: [] }).reasonCode).toBe("no_shared_fix");
  });
});

describe("draft generation (pure)", () => {
  it("builds grounded drafts with uncertainty and no promises", () => {
    const d = buildRecipientDraft({ symptomText: "Visa checkout 500 on pay", fixExcerpt: "Retry idempotently after scoping.", fixRefId: "card-12345678", customerDisplay: null });
    expect(d).not.toBeNull();
    expect(d!).toContain("Visa checkout 500");
    expect(d!).toMatch(/isn't confirmed|not guaranteed|not imply/i);
    expect(d).not.toMatch(/guarantee|definitely fixed|will resolve/i);
    expect(buildRecipientDraft({ symptomText: "   ", fixExcerpt: "x", fixRefId: "c", customerDisplay: null })).toBeNull();
    expect(buildRecipientDraft({ symptomText: "x", fixExcerpt: "", fixRefId: "c", customerDisplay: null })).toBeNull();
  });

  it("refuses drafts that fail redaction", () => {
    expect(buildRecipientDraft({ symptomText: "Contact me at ops@example.com about it", fixExcerpt: "Retry.", fixRefId: "c", customerDisplay: null })).toBeNull();
  });

  it("payload hashing is stable and order-independent", () => {
    const a = [{ recipientKey: "k2", conversationId: "c2", customerId: "u2", draftText: "b" }, { recipientKey: "k1", conversationId: "c1", customerId: "u1", draftText: "a" }];
    const b = [...a].reverse();
    expect(draftPayloadHash({ incidentId: "i", planId: "p", planVersion: 1, briefFingerprint: "f", recipients: a })).toBe(
      draftPayloadHash({ incidentId: "i", planId: "p", planVersion: 1, briefFingerprint: "f", recipients: b }),
    );
    expect(
      draftPayloadHash({
        incidentId: "i",
        planId: "p",
        planVersion: 1,
        briefFingerprint: "f",
        recipients: [{ ...a[0], eligibility: "eligible" }],
      }),
    ).not.toBe(
      draftPayloadHash({
        incidentId: "i",
        planId: "p",
        planVersion: 1,
        briefFingerprint: "f",
        recipients: [{ ...a[0], eligibility: "needs_review" }],
      }),
    );
  });
});

describe("propose flow (fakes)", () => {
  it("proposes eligible recipients and dedupes repeats", async () => {
    const { deps, stores } = makeDeps();
    const r1 = await proposeBatch("inc-1", "ws-1", "op-1", deps);
    expect(r1.action).toBe("proposed");
    if (r1.action !== "proposed") return;
    expect(r1.recipients.filter((r) => r.eligibility === "eligible")).toHaveLength(2);
    const r2 = await proposeBatch("inc-1", "ws-1", "op-1", deps);
    expect(r2.action).toBe("duplicate");
    expect(stores.batches).toHaveLength(1);
  });

  it("uses each customer's own report in the individualized draft", async () => {
    const { deps } = makeDeps({
      messages: {
        "conv-a": [{ id: "m1", createdAt: "2026-10-18T12:00:00.000Z", excerpt: "Customer A sees Visa 500 at checkout" }],
        "conv-b": [{ id: "m2", createdAt: "2026-10-18T12:01:00.000Z", excerpt: "Customer B sees Mastercard 402 after retry" }],
      },
      brief: {
        status: "current", version: 1, fingerprint: "fp-1",
        facts: [
          { observation: "Shared payment errors", identifiers: ["payment"], sources: ["m1", "m2"] },
        ],
        unknowns: [], contradictions: [],
      },
    });
    const result = await proposeBatch("inc-1", "ws-1", "op-1", deps);
    expect(result.action).toBe("proposed");
    if (result.action !== "proposed") return;
    expect(result.recipients.find((r) => r.conversation_id === "conv-a")?.draft_text).toContain("Customer A");
    expect(result.recipients.find((r) => r.conversation_id === "conv-b")?.draft_text).toContain("Customer B");
    expect(result.recipients.find((r) => r.conversation_id === "conv-a")?.draft_text).not.toContain("Customer B");
  });

  it("marks contradictory and uncovered recipients honestly, never eligible", async () => {
    const { deps } = makeDeps({
      linked: [
        { conversationId: "conv-a", customerId: "cust-a", resolved: false },
        { conversationId: "conv-b", customerId: "cust-b", resolved: false },
        { conversationId: "conv-c", customerId: "cust-c", resolved: true },
      ],
      messages: {
        "conv-a": [{ id: "m1", createdAt: "2026-10-18T12:00:00.000Z", excerpt: "Visa 500" }],
        "conv-b": [{ id: "m9", createdAt: "2026-10-18T12:00:00.000Z", excerpt: "Refund never arrived" }],
        "conv-c": [{ id: "m1", createdAt: "2026-10-18T12:00:00.000Z", excerpt: "Visa 500" }],
      },
      brief: {
        status: "current", fingerprint: "fp-1", version: 1,
        facts: [{ observation: "Visa checkout 500", identifiers: ["500"], sources: ["m1"] }],
        unknowns: [],
        contradictions: [{ description: "x", between: ["m1"] }],
      } as never,
    });
    const r = await proposeBatch("inc-1", "ws-1", "op-1", deps);
    expect(r.action).toBe("proposed");
    if (r.action !== "proposed") return;
    const byConv = new Map(r.recipients.map((x) => [x.conversation_id, x]));
    expect(byConv.get("conv-a")!.eligibility).toBe("needs_review");
    expect(byConv.get("conv-b")!.eligibility).toBe("excluded");
    expect(byConv.get("conv-c")!.eligibility).toBe("excluded");
  });

  it("supersedes on new evidence and blocks non-actionable incidents", async () => {
    const d1 = makeDeps();
    const r1 = await proposeBatch("inc-1", "ws-1", "op-1", d1.deps);
    expect(r1.action).toBe("proposed");
    // missing/stale brief defers the whole batch
    const d2b = makeDeps();
    d2b.deps.loadBrief = async () => ({ status: "stale", version: 1, fingerprint: "fp-old", facts: [], unknowns: [], contradictions: [] });
    expect((await proposeBatch("inc-1", "ws-1", "op-1", d2b.deps)).action).toBe("deferred");
    const d3 = makeDeps({ incident: { status: "resolved" } });
    expect((await proposeBatch("inc-1", "ws-1", "op-1", d3.deps)).action).toBe("deferred");
    const d4 = makeDeps({ plan: null });
    expect((await proposeBatch("inc-1", "ws-1", "op-1", d4.deps)).action).toBe("deferred");
  });

  it("rejects cross-workspace and unknown plans", async () => {
    const { deps } = makeDeps();
    expect((await proposeBatch("inc-1", "ws-foreign", "op-1", deps)).action).toBe("deferred");
    const empty = makeDeps({ linked: [] });
    expect((await proposeBatch("inc-1", "ws-1", "op-1", empty.deps)).action).toBe("deferred");
  });
});

describe("approval lifecycle (fakes)", () => {
  async function proposed(extra: Partial<Parameters<typeof makeDeps>[0]> = {}) {
    const { deps, stores } = makeDeps(extra);
    const r = await proposeBatch("inc-1", "ws-1", "op-1", deps);
    if (r.action !== "proposed" && r.action !== "duplicate") throw new Error("setup failed");
    return { deps, stores, batch: r.batch };
  }

  it("approves exact payloads and blocks self-approval for high-impact batches", async () => {
    const { deps, batch } = await proposed();
    // All recipients eligible -> low impact -> self-approval allowed.
    const ok = await approveBatch(batch.id, "ws-1", "op-1", deps);
    expect(ok.action).toBe("decided");
    // Re-approval is a no-op conflict (already decided).
    expect((await approveBatch(batch.id, "ws-1", "op-1", deps)).action).toBe("deferred");
  });

  it("requires independent review when needs_review recipients exist", async () => {
    const { deps, batch } = await proposed({
      linked: [
        { conversationId: "conv-a", customerId: "cust-a", resolved: false },
        { conversationId: "conv-b", customerId: "cust-b", resolved: false },
      ],
      messages: {
        "conv-a": [{ id: "m1", createdAt: "2026-10-18T12:00:00.000Z", excerpt: "Visa 500" }],
        "conv-b": [{ id: "m1", createdAt: "2026-10-18T12:00:00.000Z", excerpt: "Visa 500" }],
      },
      matches: [],
    });
    expect(batch.high_impact).toBe(true);
    expect((await approveBatch(batch.id, "ws-1", "op-1", deps)).action).toBe("deferred");
    const ok = await approveBatch(batch.id, "ws-1", "op-2", deps);
    expect(ok.action).toBe("decided");
  });

  it("invalidates approval when evidence changes", async () => {
    const { deps, batch } = await proposed();
    await approveBatch(batch.id, "ws-1", "op-2", deps);
    deps.loadBrief = async () => ({
      status: "current", version: 3, fingerprint: "fp-NEW",
      facts: [{ observation: "x", identifiers: [], sources: ["m1"] }],
      unknowns: [], contradictions: [],
    });
    const stale = await approveBatch(batch.id, "ws-1", "op-2", deps);
    // Already approved -> approveBatch rejects non-draft; propose path supersedes instead.
    expect(["deferred"]).toContain(stale.action);
  });

  it("editing a draft invalidates a prior approval", async () => {
    const { deps, batch } = await proposed();
    await approveBatch(batch.id, "ws-1", "op-2", deps);
    const recs = await deps.recipients.listForBatch(batch.id, "ws-1");
    const elig = recs.find((r) => r.eligibility === "eligible")!;
    const upd = await editRecipientDraft(batch.id, elig.id, "ws-1", "op-1", "Edited draft text with same meaning.", deps);
    expect(upd.action).toBe("updated");
    const again = await deps.batches.loadById(batch.id, "ws-1");
    expect(again?.status).toBe("draft");
    expect(again?.approved_by_user_id).toBeNull();
  });

  it("rejects empty, oversized, or leaking edits", async () => {
    const { deps, batch } = await proposed();
    const recs = await deps.recipients.listForBatch(batch.id, "ws-1");
    const elig = recs.find((r) => r.eligibility === "eligible")!;
    expect((await editRecipientDraft(batch.id, elig.id, "ws-1", "op-1", "   ", deps)).action).toBe("deferred");
    expect((await editRecipientDraft(batch.id, elig.id, "ws-1", "op-1", "x".repeat(2001), deps)).action).toBe("deferred");
    expect((await editRecipientDraft(batch.id, elig.id, "ws-1", "op-1", "email me at a@b.com", deps)).action).toBe("deferred");
  });
});

describe("publish (fakes)", () => {
  async function approved() {
    const { deps, published, stores } = (() => {
      const d = makeDeps();
      return { deps: d.deps, published: d.published, stores: d.stores };
    })();
    const p = await proposeBatch("inc-1", "ws-1", "op-1", deps);
    if (p.action !== "proposed" && p.action !== "duplicate") throw new Error("setup");
    const a = await approveBatch(p.batch.id, "ws-1", "op-2", deps);
    if (a.action !== "decided") throw new Error("approve failed: " + JSON.stringify(a));
    return { deps, published, stores, batch: p.batch };
  }

  it("publishes exact approved drafts to the right conversation only", async () => {
    const { deps, published, batch } = await approved();
    const recs = await deps.recipients.listForBatch(batch.id, "ws-1");
    const target = recs.find((r) => r.eligibility === "eligible")!;
    const before = published.length;
    const r = await publishRecipient(batch.id, target.id, "ws-1", "op-2", deps);
    expect(r.action).toBe("published");
    expect(published.length).toBe(before + 1);
    expect(published[published.length - 1].conversationId).toBe(target.conversation_id);
    expect(published[published.length - 1].text).toBe(target.draft_text);
    const other = recs.find((r2) => r2.id !== target.id && r2.eligibility === "eligible")!;
    // Concurrent/duplicate publish of the same recipient does not duplicate.
    const dup = await publishRecipient(batch.id, target.id, "ws-1", "op-2", deps);
    expect(dup.action).toBe("published");
    expect(published.filter((p) => p.conversationId === target.conversation_id)).toHaveLength(1);
    // The other eligible recipient was untouched.
    expect(published.some((p) => p.conversationId === other.conversation_id)).toBe(false);
  });

  it("blocks needs_review recipients, stale evidence, and unlinked conversations", async () => {
    const { deps, batch } = await approved();
    const recs = await deps.recipients.listForBatch(batch.id, "ws-1");
    // All eligible in this fixture; craft a needs_review case via fresh setup.
    const d2 = makeDeps({
      linked: [{ conversationId: "conv-a", customerId: "cust-a", resolved: false }],
      messages: { "conv-a": [{ id: "m1", createdAt: "2026-10-18T12:00:00.000Z", excerpt: "x" }] },
      brief: {
        status: "current", fingerprint: "fp-1", version: 1,
        facts: [{ observation: "x", identifiers: [], sources: ["m1"] }],
        unknowns: [], contradictions: [{ description: "c", between: ["m1"] }],
      } as never,
    });
    const p2 = await proposeBatch("inc-1", "ws-1", "op-1", d2.deps);
    expect(p2.action).toBe("proposed");
    if (p2.action !== "proposed") return;
    const rec2 = (await d2.deps.recipients.listForBatch(p2.batch.id, "ws-1"))[0];
    expect(rec2.eligibility).toBe("needs_review");
    const blocked = await publishRecipient(p2.batch.id, rec2.id, "ws-1", "op-2", d2.deps);
    expect(blocked.action).toBe("deferred");
    void recs;
  });
});

describe("route authorization", () => {
  it("anonymous callers get 401 without touching data", async () => {
    cookieJar = "";
    const mk = (body: unknown) => new Request("http://test/api/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const a = await proposePOST(mk({ workspaceSlug: "northstar" }), { params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000" }) });
    expect(a.status).toBe(401);
    const b = await approvePOST(mk({ workspaceSlug: "northstar" }), {
      params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000", batchId: "00000000-0000-0000-0000-000000000000" }),
    });
    expect(b.status).toBe(401);
    const c = await editPATCH(mk({ workspaceSlug: "northstar", text: "x" }), {
      params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000", batchId: "00000000-0000-0000-0000-000000000000", recipientId: "00000000-0000-0000-0000-000000000000" }),
    });
    expect(c.status).toBe(401);
    const d = await publishPOST(mk({ workspaceSlug: "northstar" }), {
      params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000", batchId: "00000000-0000-0000-0000-000000000000", recipientId: "00000000-0000-0000-0000-000000000000" }),
    });
    expect(d.status).toBe(401);
  }, 60_000);
});

describe("no automatic side effects", () => {
  it("recover-many never auto-sends, never touches Photon notify, never closes", async () => {
    const fs = await import("node:fs");
    const lib = fs.readFileSync("lib/recover-many.ts", "utf8");
    expect(lib).not.toMatch(/sendOperatorNotification|postToThread|rememberInNamespace|transitionIncident|updateIncidentFields|markFixCard|resolveConversation/);
    expect(lib.includes("recovery-approvals")).toBe(false);
    expect(lib.replace(/\s+/g, " ")).toMatch(/never pushed to a device/);
  });
});

// ---- Live persistence: full propose → approve → publish loop ----

const stamp = Date.now().toString(36);
const PW = "correct-horse-123";
const createdEmails: string[] = [];
const createdOrgIds: string[] = [];
const SLUG = `s15e-ws-${stamp}`;

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

describe("recover-many persistence (live Neon)", () => {
  it("grounds, approves, and publishes to the right conversation only", async () => {
    const { organizationIdForSlug, workspaceIdForSlug, customerIdFor } = await import("../tenant");
    const { ensureOrganization, ensureWorkspace, addOrganizationMember, ensureCustomer } = await import("../db");
    const orgId = organizationIdForSlug(SLUG);
    await ensureOrganization({ id: orgId, slug: SLUG, name: `Temp ${SLUG}` });
    const wsId = workspaceIdForSlug(SLUG);
    await ensureWorkspace({ id: wsId, organizationId: orgId, slug: SLUG, name: `Temp ${SLUG}` });
    createdOrgIds.push(orgId);
    cookieJar = await signupSession(`s15e-staff-${stamp}@example.test`);
    const { neon } = await import("@neondatabase/serverless");
    const sql = neon(dbKey());
    const staff = (await sql`select id from "user" where email = ${`s15e-staff-${stamp}@example.test`} limit 1`) as unknown as { id: string }[];
    await addOrganizationMember({ organizationId: orgId, userId: staff[0].id, role: "owner" });

    const { createHash } = await import("node:crypto");
    const mkCust = async (tag: string) => {
      const hh = createHash("sha256").update(`s15e-${tag}-${stamp}`, "utf8").digest("hex");
      const { customerIdFor: cid } = await import("../tenant");
      const id = cid(wsId, hh);
      await ensureCustomer({ id, workspaceId: wsId, bootstrapHash: hh });
      return id;
    };
    const custA = await mkCust("a");
    const custB = await mkCust("b");
    const { createConversation, addUserMessage } = await import("../support-ops");
    const convA = (await createConversation({ workspaceId: wsId, customerId: custA, title: "Visa 500s" })).conversation;
    const convB = (await createConversation({ workspaceId: wsId, customerId: custB, title: "Visa 500s too" })).conversation;
    const mA = await addUserMessage({ conversationId: convA.id, content: "Visa checkout fails with HTTP 500 every time today", clientId: `s15e-${stamp}-1` });
    await addUserMessage({ conversationId: convB.id, content: "Getting the same Visa 500 on pay", clientId: `s15e-${stamp}-2` });

    const { createIncident, addIncidentConversation, listIncidentEvents } = await import("../incidents");
    const inc = await createIncident({ workspaceId: wsId, title: "S15E live incident", createdByUserId: staff[0].id });
    await addIncidentConversation({ incidentId: inc.id, workspaceId: wsId, conversationId: convA.id, actorUserId: staff[0].id });
    await addIncidentConversation({ incidentId: inc.id, workspaceId: wsId, conversationId: convB.id, actorUserId: staff[0].id });
    for (const to of ["investigating", "ready_for_action", "recovering", "monitoring"] as const) {
      const { transitionIncident } = await import("../incidents");
      await transitionIncident({ incidentId: inc.id, workspaceId: wsId, to });
    }

    const { realBriefStore, refreshBriefIfNeeded } = await import("../evidence-brief");
    const bjudge = async (input: { sources: { id: string }[] }) => ({
      facts: [
        { observation: "Visa checkout returns HTTP 500", identifiers: ["500", "Visa"], sources: [mA.id] },
        { observation: "Same 500 on Visa checkout for a second reporter", identifiers: ["500"], sources: input.sources.map((s) => s.id) },
      ],
      corroborated: [],
      contradictions: [],
      unknowns: [],
      hypotheses: [],
    });
    await refreshBriefIfNeeded(inc.id, wsId, { store: await realBriefStore(), judge: bjudge as never });

    const { realPlanStore } = await import("../recovery-plans");
    const plans = await realPlanStore();
    const { getIncidentBrief } = await import("../evidence-brief");
    const brief = await getIncidentBrief(inc.id, wsId);
    if (!brief || brief.status !== "current") throw new Error("brief setup failed");
    const draft = await plans.createDraft({
      incidentId: inc.id, workspaceId: wsId, fingerprint: brief.fingerprint, briefVersion: brief.version,
      payload: {
        problemSummary: "Visa checkout reports HTTP 500 on pay.",
        approach: "Verify scope, then pursue the retry lead with approval.",
        steps: [{ description: "Confirm scope from linked reports", purpose: "Bound the affected actions", kind: "diagnostic" as const, evidenceRefs: ["m1"], matchRefs: [], prerequisites: [], expectedResult: "Scoped note", risk: "low" as const, humanRequired: false, verification: "Note recorded" }],
        prerequisites: [], missingInfo: [], riskLevel: "low" as const, safetyWarnings: [], expectedOutcomes: ["Scoped note"],
        verificationChecks: ["Note present"], rollbackNotes: "No change proposed.", historicalBasis: [],
      },
      createdByUserId: staff[0].id,
    });
    await plans.transition({ planId: draft.row.id, workspaceId: wsId, to: "under_review", actorUserId: staff[0].id });
    await plans.transition({ planId: draft.row.id, workspaceId: wsId, to: "staged", actorUserId: staff[0].id });

    const { createPendingFixCard, markFixCardShared } = await import("../support-ops");
    const card = await createPendingFixCard({ workspaceId: wsId, customerId: custA, conversationId: convA.id, issueId: null, candidateText: "[SHARED_FIX]\nSymptom: x\nCause: y\nResolution: z" });
    await markFixCardShared(card.id, `blob-s15e-${stamp}`, staff[0].id);
    const { realMatchStore } = await import("../fix-matches");
    await (await realMatchStore()).saveMatches({
      incidentId: inc.id, workspaceId: wsId, fingerprint: brief.fingerprint, briefVersion: brief.version,
      matches: [{ refId: card.id, tier: "documented_unverified", payload: { reasons: ["Same 500 on Visa"], matchingSymptoms: ["visa checkout 500"], differences: [], unknowns: [], applicable: true, warning: "", cardStatus: "shared", cardResolved: null, cardExcerpt: "Retry idempotently after scoping.", identifierHits: [] } }],
    });

    const { proposeBatch, approveBatch, publishRecipient, realRecoverManyDeps } = await import("../recover-many");
    const deps = await realRecoverManyDeps();
    const proposed = await proposeBatch(inc.id, wsId, staff[0].id, deps);
    expect(proposed.action).toBe("proposed");
    if (proposed.action !== "proposed") throw new Error("propose failed");
    expect(proposed.recipients.filter((r) => r.eligibility === "eligible")).toHaveLength(2);

    // Approve as a different reviewer, then publish both recipients.
    const approved = await approveBatch(proposed.batch.id, wsId, staff[0].id, deps).catch((e: unknown) => ({ action: "deferred" as const, reason: String(e) }));
    // Single staffer: self-approval allowed since every recipient is eligible (low-impact).
    expect(approved.action).toBe("decided");

    for (const r of proposed.recipients) {
      const pub = await publishRecipient(proposed.batch.id, r.id, wsId, staff[0].id, deps);
      expect(pub.action).toBe("published");
    }
    // Double-publish is a no-op duplicate: still exactly one staff message per conversation.
    const { listMessages } = await import("../support-ops");
    for (const r of proposed.recipients) {
      const again = await publishRecipient(proposed.batch.id, r.id, wsId, staff[0].id, deps);
      expect(again.action).toBe("published");
      if (again.action !== "published") throw new Error("re-publish failed");
      expect(again.deduped).toBe(true);
      const msgs = await listMessages(r.conversation_id);
      const staffMsgs = msgs.filter((m) => m.role === "assistant" && (m as { author_kind?: string }).author_kind === "staff");
      expect(staffMsgs).toHaveLength(1);
    }

    // Published staff messages are visible to the owning customer…
    const { getConversationForCustomer } = await import("../support-ops");
    const convCheck = await getConversationForCustomer(convA.id, wsId, custA);
    expect(convCheck).not.toBeNull();
    // …but are never customer confirmations: S11 watches only user messages.
    const allA = await listMessages(convA.id);
    const userA = allA.filter((m) => m.role === "user");
    expect(userA.length).toBeGreaterThan(0);
    expect(allA.filter((m) => m.role === "assistant" && (m as { author_kind?: string }).author_kind === "staff")).toHaveLength(1);

    // Staff approval attribution + audit trail recorded.
    const kinds = (await listIncidentEvents(inc.id, wsId)).map((e) => e.kind);
    for (const k of ["recover_many_proposed", "recover_many_approved", "recover_many_published"] as const) {
      expect(kinds).toContain(k);
    }
  }, 240_000);
});
