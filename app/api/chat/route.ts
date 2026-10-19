import { NextResponse, after } from "next/server";
import {
  MAX_DISTANCE,
  RECALL_TOP_K,
  buildSystemInstruction,
  dropSupersededSharedHits,
  normalizeMemories,
  type MemoryItem,
} from "@/lib/chat-memory";
import { GeminiNotConfiguredError, generateSupportAnswer, getPrimaryModel, type ChatTurn } from "@/lib/gemini";
import { previewUserId } from "@/lib/identity";
import { buildRecallQuery, detectResolution } from "@/lib/support-memory";
import { identityError, resolveProductIdentity } from "@/lib/product-identity";
import type { AuthenticatedCustomer } from "@/lib/tenant-store";
import { generateFixCandidate } from "@/lib/fix-candidate";
import {
  addAssistantMessage,
  addUserMessage,
  createConversation,
  createPendingFixCard,
  getConversationForCustomer,
  listRecentTurns,
  resolveConversation,
  titleFromMessage,
  type FixCardRow,
} from "@/lib/support-ops";
import { CHAT_RECALL_TIMEOUT_MS, recallBounded } from "@/lib/walrus";
import { deriveKnowledgeNamespaceV2 } from "@/lib/tenant";
import { isWalrusConfigured, walrusBlocker } from "@/lib/env";
import {
  MAX_ATTACHMENTS,
  toAttachmentMeta,
  validateInboundAttachment,
  type AttachmentMeta,
  type AttachmentPayload,
} from "@/lib/attachments";

const MAX_HISTORY_TURNS = 12;

export type ProvenanceItem = {
  plane: "private" | "shared" | "knowledge";
  text: string;
  blobId: string;
  distance: number;
};

export async function POST(req: Request) {
  // Product identity is the Better Auth session. Client supplies only the
  // workspace route context — never customerId, accessCode, or namespaces.
  // conversationId (when present) is verified against that identity below.
  let body: { workspaceSlug?: unknown; message?: unknown; history?: unknown; conversationId?: unknown; clientMessageId?: unknown; answerClientId?: unknown; attachments?: unknown }; // NOTE: P7 product flow uses session auth (legacy /chat access-code path is dev-only).
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  // Server resolves the signed-in user + workspace customer and derives
  // BOTH v2 namespaces. Anonymous callers are rejected before any recall.
  // Session-required product identity. resolveProductIdentity throws 401
  // when anonymous; any accessCode present is never consulted.
  let tenant: AuthenticatedCustomer;
  try {
    tenant = await resolveProductIdentity(body);
  } catch (e) {
    const err = identityError(e);
    return NextResponse.json({ ok: false, error: err.message }, { status: err.status });
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  // Attachments are validated server-side and never trusted as presented:
  // re-check MIME family, size, and count here. Raw bytes live only for
  // this generation request — only metadata is ever persisted.
  const rawAttachments = Array.isArray(body.attachments) ? body.attachments.slice(0, MAX_ATTACHMENTS + 1) : [];
  if (rawAttachments.length > MAX_ATTACHMENTS)
    return NextResponse.json({ ok: false, error: `at most ${MAX_ATTACHMENTS} attachments per message` }, { status: 400 });
  const attachments: AttachmentPayload[] = [];
  const attachmentMetas: AttachmentMeta[] = [];
  for (const raw of rawAttachments) {
    const checked =
      raw !== null && typeof raw === "object"
        ? validateInboundAttachment(raw as Record<string, unknown>)
        : { ok: false as const, error: "malformed attachment" };
    if (!checked.ok)
      return NextResponse.json({ ok: false, error: checked.error }, { status: 400 });
    attachments.push({ ...checked.attachment, data: checked.data });
    attachmentMetas.push(toAttachmentMeta(checked.attachment));
  }
  if (!message && attachments.length === 0)
    return NextResponse.json({ ok: false, error: "message must not be empty" }, { status: 400 });
  if (message.length > 4000)
    return NextResponse.json({ ok: false, error: "message too long (max 4000)" }, { status: 400 });

  // Conversation lifecycle: verify ownership of a supplied thread, or open
  // a fresh persistent conversation (+ its primary OPEN issue) for this
  // exact workspace/customer. Client IDs are never trusted as authority.
  let conversationId: string;
  let conversationStatus: "open" | "resolved";
  try {
    if (typeof body.conversationId === "string" && body.conversationId) {
      const existing = await getConversationForCustomer(
        body.conversationId,
        tenant.workspaceId,
        tenant.customerId,
      );
      if (!existing) {
        return NextResponse.json({ ok: false, error: "conversation not found" }, { status: 404 });
      }
      conversationId = existing.id;
      conversationStatus = existing.status;
    } else {
      const created = await createConversation({
        workspaceId: tenant.workspaceId,
        customerId: tenant.customerId,
        title: titleFromMessage(message),
      });
      conversationId = created.conversation.id;
      conversationStatus = created.conversation.status;
    }
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "conversation unavailable" },
      { status: 503 },
    );
  }

  // Durability first: the USER complaint is persisted BEFORE any recall or
  // generation, so a model failure can never lose it. Idempotent on
  // clientMessageId — a retried send resumes instead of duplicating.
  let userMessageId: string | null = null;
  let userClientId: string | null = null;
  try {
    const stored = await addUserMessage({
      conversationId,
      content: message,
      clientId: typeof body.clientMessageId === "string" ? body.clientMessageId : null,
      attachments: attachmentMetas,
    });
    userMessageId = stored.id;
    userClientId = stored.clientId;
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "message persist failed", conversationId },
      { status: 503 },
    );
  }

  // Model context comes from the persisted Neon thread (bounded window),
  // never from a browser-supplied transcript. Walrus long-term memory stays
  // a separate, labelled input. The just-stored user turn is trailing in
  // the thread — drop it here because the model appends `message` itself.
  let history: ChatTurn[];
  try {
    const thread = await listRecentTurns(conversationId, MAX_HISTORY_TURNS + 1);
    const last = thread[thread.length - 1];
    history =
      last && last.role === "user" && last.text === message
        ? thread.slice(0, -1).slice(-MAX_HISTORY_TURNS)
        : thread.slice(-MAX_HISTORY_TURNS);
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "history unavailable", conversationId },
      { status: 503 },
    );
  }

  // Retry safety: the assistant reply carries its own idempotency key, so
  // a retried answer can never store twice. If an earlier attempt already
  // persisted the reply (ambiguous outcome — response lost, write kept),
  // resume it verbatim instead of regenerating.
  const rawAnswerKey = typeof body.answerClientId === "string" ? body.answerClientId.trim() : "";
  const answerClientId = /^[A-Za-z0-9:_-]{1,128}$/.test(rawAnswerKey)
    ? rawAnswerKey
    : `${userClientId}:answer`;
  try {
    const { findMessageByClientId } = await import("@/lib/support-ops");
    const prior = await findMessageByClientId(conversationId, answerClientId);
    if (prior && prior.role === "assistant" && prior.content) {
      const planes = new Set(prior.provenance.map((p) => p.plane));
      return NextResponse.json({
        ok: true,
        answer: prior.content,
        resumed: true,
        resolutionDetected: false,
        memoryStatus: { private: "resumed", shared: "resumed", knowledge: "resumed" },
        degradedMemory: false,
        userPreview: previewUserId(tenant.customerId),
        workspace: tenant.workspace,
        memoryUsed: {
          private: planes.has("private"),
          shared: planes.has("shared"),
          knowledge: planes.has("knowledge"),
        },
        provenance: prior.provenance,
        historyTurns: history.length,
        conversation: { id: conversationId, status: conversationStatus },
        issue: { status: conversationStatus === "resolved" ? "resolved" : "open" },
        fixCard: null,
        attachments: attachmentMetas,
      });
    }
  } catch (e) {
    console.log(`[chat] resume lookup failed (fail-open to fresh answer): ${e instanceof Error ? e.message : e}`);
  }
  const recallQuery = buildRecallQuery(message, history);

  // Dual-plane recall, each plane independently bounded. One stalled plane
  // can never hang the answer: we degrade with whatever actually returned.
  // (No namespaces, codes, or secrets are ever logged — plane + ms only.)
  if (!isWalrusConfigured()) {
    const blocker = walrusBlocker();
    return NextResponse.json(
      { ok: false, error: blocker.reason, needed: blocker.needed },
      { status: 503 },
    );
  }
  console.log(`[chat] recall start (timeout ${CHAT_RECALL_TIMEOUT_MS}ms/plane)`);
  const [p, s, k] = await Promise.all([
    recallBounded(tenant.privateNamespace, recallQuery, { topK: RECALL_TOP_K, maxDistance: MAX_DISTANCE })
      .then((r) => {
        console.log(`[chat] recall private ${r.status} in ${r.durationMs}ms (${r.total} hits)`);
        return r;
      }),
    recallBounded(tenant.sharedNamespace, recallQuery, { topK: RECALL_TOP_K, maxDistance: MAX_DISTANCE })
      .then((r) => {
        console.log(`[chat] recall shared ${r.status} in ${r.durationMs}ms (${r.total} hits)`);
        return r;
      }),
    recallBounded(deriveKnowledgeNamespaceV2(tenant.workspaceId), recallQuery, { topK: RECALL_TOP_K, maxDistance: MAX_DISTANCE })
      .then((r) => {
        console.log(`[chat] recall knowledge ${r.status} in ${r.durationMs}ms (${r.total} hits)`);
        return r;
      }),
  ]);
  const privateHits = p.results;
  // Shared supersession: the old (tainted) blob still recalls from immutable
  // Walrus storage — cross-check against Neon's active reviewed records and
  // drop superseded blob ids before building shared context. Workspace-
  // scoped; private/knowledge planes untouched. On lookup failure, fail open
  // (logged) rather than 503ing the whole conversation.
  let sharedHits = s.results;
  try {
    const { listSupersededSharedBlobs } = await import("@/lib/support-ops");
    const dead = await listSupersededSharedBlobs(tenant.workspaceId);
    if (dead.length > 0) {
      const before = sharedHits.length;
      sharedHits = dropSupersededSharedHits(sharedHits, dead);
      const dropped = before - sharedHits.length;
      if (dropped > 0) console.log(`[chat] recall shared: dropped ${dropped} superseded blob(s)`);
    }
  } catch (e) {
    console.log(`[chat] supersession lookup failed (fail-open): ${e instanceof Error ? e.message : e}`);
  }
  const knowledgeHits = k.results;
  const memoryStatus = { private: p.status, shared: s.status, knowledge: k.status } as const;
  const degradedMemory = p.status !== "ok" || s.status !== "ok" || k.status !== "ok";
  if (degradedMemory) {
    console.log(`[chat] recall degraded (private=${p.status} shared=${s.status} knowledge=${k.status}) — answering with available context`);
  }

  const used: MemoryItem[] = normalizeMemories(privateHits, sharedHits, knowledgeHits);

  let answer: string;
  try {
    console.log(`[chat] gemini start (${used.length} memories injected)`);
    const tGemini = Date.now();
    answer = await generateSupportAnswer({
      systemInstruction: buildSystemInstruction(used),
      history,
      message,
      attachments,
    });
    console.log(`[chat] gemini ok in ${Date.now() - tGemini}ms`);
  } catch (e) {
    // The user complaint is ALREADY persisted above: the conversation stays
    // open and nothing is lost. Provider detail stays server-side (logged);
    // the customer gets a friendly, retryable message — never raw errors.
    console.log(`[chat] answer generation failed (question persisted): ${e instanceof Error ? e.message : e}`);
    return NextResponse.json(
      {
        ok: false,
        error: "I couldn't answer just now. Your message is saved. Please retry.",
        code: "answer_failed",
        retryable: true,
        conversationId,
      },
      { status: 502 },
    );
  }

  // Provenance comes ONLY from memories actually injected into the model.
  const provenance: ProvenanceItem[] = used.map((m) => ({
    plane: m.plane,
    text: m.text,
    blobId: m.blobId,
    distance: m.distance,
  }));

  // Persist the successful answer + its provenance before responding.
  // Idempotent on the answer key: an ambiguous retry resumes (above) and
  // can never store a second assistant reply for the same turn.
  try {
    await addAssistantMessage({
      conversationId,
      content: answer,
      clientId: answerClientId,
      model: getPrimaryModel(),
      privateUsed: used.some((m) => m.plane === "private"),
      sharedUsed: used.some((m) => m.plane === "shared"),
      knowledgeUsed: used.some((m) => m.plane === "knowledge"),
      provenance,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "answer persist failed", conversationId },
      { status: 503 },
    );
  }

  // Explicit resolution only — never inferred from the assistant's prose.
  // On confirmation: resolve conversation + issue, then attempt a grounded
  // pending Fix Card. Card generation failure never blocks the resolution.
  const resolved = detectResolution(message);
  let issueStatus: "open" | "resolved" = conversationStatus === "resolved" ? "resolved" : "open";
  let fixCard: { id: string; status: FixCardRow["status"]; candidateText?: string } | null = null;
  if (resolved) {
    try {
      const issue = await resolveConversation(conversationId, message.slice(0, 500));
      issueStatus = issue.status;
      conversationStatus = "resolved";
      try {
        const transcript = await listRecentTurns(conversationId, MAX_HISTORY_TURNS);
        const generated = await generateFixCandidate(transcript);
        if (generated.status === "ready") {
          const card = await createPendingFixCard({
            workspaceId: tenant.workspaceId,
            customerId: tenant.customerId,
            conversationId,
            issueId: issue.id,
            candidateText: generated.text,
          });
          fixCard = { id: card.id, status: card.status, candidateText: generated.text };
        }
      } catch (e) {
        console.log(`[chat] fix card generation skipped: ${e instanceof Error ? e.message : e}`);
      }
    } catch (e) {
      return NextResponse.json(
        { ok: false, error: e instanceof Error ? e.message : "resolution failed", conversationId },
        { status: 503 },
      );
    }
  }

  console.log(`[chat] done (private=${p.status} shared=${s.status} knowledge=${k.status} provenance=${provenance.length})`);

  // S5 automatic issue detection, AFTER the support answer is secured.
  // Runs in the background via after(): zero added response latency, and
  // any detection failure is isolated here — it can never lose the
  // complaint, break the reply, or throw into this request. Skipped for
  // resolutions, empty turns, and when after() has no request scope.
  if (userMessageId && !resolved && message.trim()) {
    const detectCtx = {
      workspaceId: tenant.workspaceId,
      conversationId,
      customerId: tenant.customerId,
      messageId: userMessageId,
      text: message.slice(0, 2000),
    };
    try {
      after(() =>
        (async () => {
          try {
            const { detectFromChat, recentConversationExcerpts } = await import("@/lib/detection");
            const { geminiJudge } = await import("@/lib/detection-gemini");
            const { isGeminiConfigured } = await import("@/lib/env");
            if (!isGeminiConfigured()) {
              console.log("[chat] detection skipped (Gemini unconfigured — degrading without guessing)");
            } else {
              try {
                const outcome = await detectFromChat(detectCtx, {
                  judge: geminiJudge(),
                  listRecentExcerpts: recentConversationExcerpts,
                  store: await import("@/lib/issue-candidates"),
                });
                console.log(`[chat] detection ${outcome.action}` + ("candidateId" in outcome ? ` candidate=${outcome.candidateId}` : ""));
                // S15B Incident Radar: genuine new candidate membership →
                // evaluate the 3-customer/60-minute rule and alert ONLY
                // explicitly opted-in operators. Fully isolated: never
                // delays, breaks, or reclassifies anything in this chain.
                if (outcome.action === "joined" && outcome.newConversation) {
                  try {
                    const { maybeSendRadarAlert, realRadarDeps } = await import("@/lib/radar");
                    const radar = await maybeSendRadarAlert(
                      detectCtx.workspaceId,
                      outcome.candidateId,
                      await realRadarDeps(),
                    );
                    console.log(`[chat] radar ${outcome.candidateId.slice(0, 8)} ${radar.action}`);
                  } catch (e) {
                    console.log(`[chat] radar skipped safely: ${e instanceof Error ? e.message : e}`);
                  }
                }
              } catch (e) {
                console.log(`[chat] detection failed safely: ${e instanceof Error ? e.message : e}`);
              }
            }
            // S6: new report on a linked conversation refreshes that
            // incident's evidence brief (fingerprint-gated, non-blocking).
            // Independent of detection outcome so plain follow-ups still
            // refresh the brief; safe-skips when Gemini is unconfigured.
            try {
              const { listOpenIncidentIdsForConversation } = await import("@/lib/incidents");
              const linked = await listOpenIncidentIdsForConversation(detectCtx.conversationId);
              if (linked.length > 0) {
                const { isGeminiConfigured: isGeminiOn } = await import("@/lib/env");
                if (!isGeminiOn()) {
                  console.log("[chat] brief refresh skipped (Gemini unconfigured)");
                } else {
                  const { refreshBriefIfNeeded, realBriefStore } = await import("@/lib/evidence-brief");
                  const { geminiBriefJudge } = await import("@/lib/evidence-brief-gemini");
                  const store = await realBriefStore();
                  for (const incidentId of linked) {
                    const r = await refreshBriefIfNeeded(incidentId, detectCtx.workspaceId, {
                      store,
                      judge: geminiBriefJudge(),
                    });
                    console.log(`[chat] brief ${incidentId.slice(0, 8)} ${r.action}`);
                    // S8: brief rebuilt from new evidence → refresh fix-card
                    // matches (fingerprint-gated; no-op when unchanged).
                    if (r.action === "built") {
                      try {
                        const { refreshMatchesIfNeeded, realMatchDeps } = await import(
                          "@/lib/fix-matches"
                        );
                        const m = await refreshMatchesIfNeeded(
                          incidentId,
                          detectCtx.workspaceId,
                          await realMatchDeps(),
                        );
                        console.log(`[chat] matches ${incidentId.slice(0, 8)} ${m.action}`);
                      // S9: fresh evidence + matching context → draft a recovery
                      // proposal (fingerprint-gated; draft only, never approval).
                      if (m.action === "built" || m.action === "unchanged") {
                        try {
                          const { generatePlanIfNeeded, realPlanDeps } = await import(
                            "@/lib/recovery-plans"
                          );
                          const g = await generatePlanIfNeeded(
                            incidentId,
                            detectCtx.workspaceId,
                            null,
                            await realPlanDeps(),
                          );
                          console.log(`[chat] plan ${incidentId.slice(0, 8)} ${g.action}`);
                        } catch (e) {
                          console.log(`[chat] plan draft skipped safely: ${e instanceof Error ? e.message : e}`);
                        }
                      }
                      } catch (e) {
                        console.log(`[chat] match refresh skipped safely: ${e instanceof Error ? e.message : e}`);
                      }
                    }
                  }
                }
                // S11: new report on a linked conversation → note it on
                // every active Resolution Watch. Deterministic, message-id
                // deduped, bounded; runs with or without Gemini and never
                // executes or closes anything.
                try {
                  const { noteNewMessage } = await import("@/lib/resolution-watch");
                  const { realWatchDeps } = await import("@/lib/resolution-watch-store");
                  const wdeps = await realWatchDeps({ judge: false });
                  for (const incidentId of linked) {
                    try {
                      const n = await noteNewMessage(
                        incidentId,
                        detectCtx.workspaceId,
                        {
                          id: detectCtx.messageId,
                          conversationId: detectCtx.conversationId,
                          excerpt: detectCtx.text.slice(0, 500),
                          createdAt: new Date().toISOString(),
                        },
                        wdeps,
                      );
                      console.log(`[chat] watch ${incidentId.slice(0, 8)} ${n.action}+${n.action === "noted" ? n.added : 0}`);
                    } catch (e) {
                      console.log(`[chat] watch note skipped safely: ${e instanceof Error ? e.message : e}`);
                    }
                  }
                } catch (e) {
                  console.log(`[chat] watch note skipped safely: ${e instanceof Error ? e.message : e}`);
                }
              }
            } catch (e) {
              console.log(`[chat] brief refresh skipped safely: ${e instanceof Error ? e.message : e}`);
            }
          } catch (e) {
            console.log(`[chat] background intelligence failed safely: ${e instanceof Error ? e.message : e}`);
          }
        })(),
      );
    } catch {
      // after() outside request scope (tests, dev snippets): skip silently.
    }
  }

  return NextResponse.json({
    ok: true,
    answer,
    resolutionDetected: resolved,
    memoryStatus,
    degradedMemory,
    userPreview: previewUserId(tenant.customerId),
    workspace: tenant.workspace,
    memoryUsed: {
      private: used.some((m) => m.plane === "private"),
      shared: used.some((m) => m.plane === "shared"),
      knowledge: used.some((m) => m.plane === "knowledge"),
    },
    provenance,
    historyTurns: history.length,
    conversation: { id: conversationId, status: conversationStatus },
    issue: { status: issueStatus },
    fixCard,
    // Echo of what the model actually saw: metadata only, never content.
    attachments: attachmentMetas,
  });
}
