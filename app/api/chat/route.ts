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

export type ChatDetectionSchedule = {
  workspaceId: string;
  workspaceSlug: string;
  conversationId: string;
  customerId: string;
  /** Persisted user message id — the same idempotent key across retries. */
  messageId: string | null;
  /** Message text (already bounded to 2000 chars by the caller). */
  text: string;
  resolved: boolean;
};

/**
 * S5 automatic issue detection scheduler — request-scoped, non-blocking.
 *
 * Called for EVERY successfully persisted customer message, whether the
 * support answer later succeeds or FAILS: detection keys off the persisted
 * user message (messageId), never off the generated answer, so a Gemini
 * outage can never silently drop a genuine incident report.
 *
 * Safe on retries, resumed answers, and concurrent sends: the store
 * collapses repeats onto the same message id (messageAlreadyClustered /
 * membership uniqueness) and Radar sends carry per-(candidate, operator)
 * idempotency keys. The Gemini-failure 502 reply below schedules this
 * BEFORE returning for exactly that reason.
 *
 * Skipped for explicit resolutions (they close issues, they are not new
 * reports), empty turns, and when after() has no request scope. Detection
 * itself runs in the background via after(): zero added response latency,
 * and any detection failure is isolated — it can never lose the complaint,
 * break the reply, or throw into the request.
 */
function scheduleDetectionFromChat(args: ChatDetectionSchedule): void {
  if (!args.messageId || args.resolved || !args.text.trim()) return;
  const detectCtx = {
    workspaceId: args.workspaceId,
    conversationId: args.conversationId,
    customerId: args.customerId,
    messageId: args.messageId,
    text: args.text,
  };
  const decisionWorkspaceSlug = args.workspaceSlug;
    try {
      after(() =>
        (async () => {
          try {
            const { detectFromChat, recentConversationExcerpts } = await import("@/lib/detection");
            const { geminiJudge } = await import("@/lib/detection-gemini");
            const { isGeminiConfigured } = await import("@/lib/env");
            const { logRadarDecision } = await import("@/lib/radar-decision");
            const emit = (
              fields: Omit<Parameters<typeof logRadarDecision>[0], "workspaceSlug">,
            ) => logRadarDecision({ ...fields, workspaceSlug: decisionWorkspaceSlug });
            if (!isGeminiConfigured()) {
              console.log("[chat] detection skipped (Gemini unconfigured — degrading without guessing)");
              emit({ outcome: "detection_skipped", candidateIdPrefix: "none", reason: "gemini_unconfigured" });
            } else {
              try {
                const outcome = await detectFromChat(detectCtx, {
                  judge: geminiJudge(),
                  listRecentExcerpts: recentConversationExcerpts,
                  store: await import("@/lib/issue-candidates"),
                });
                console.log(`[chat] detection ${outcome.action}` + ("candidateId" in outcome ? ` candidate=${outcome.candidateId}` : ""));
                const candPrefix =
                  "candidateId" in outcome && typeof outcome.candidateId === "string"
                    ? outcome.candidateId.slice(0, 8)
                    : "none";
                if (outcome.action === "created") {
                  emit({ outcome: "detection_created", candidateIdPrefix: candPrefix });
                } else if (outcome.action === "joined") {
                  emit({
                    outcome: "detection_joined",
                    candidateIdPrefix: candPrefix,
                    newConversation: outcome.newConversation,
                  });
                } else {
                  emit({ outcome: "detection_skipped", candidateIdPrefix: candPrefix, reason: outcome.action });
                }
                // S15B Incident Radar: genuine new candidate membership →
                // evaluate the 3-customer/60-minute rule and alert ONLY
                // explicitly opted-in operators. Shared with the deferred-
                // recovery sweep (lib/radar-evaluate) so recovered reports
                // alert exactly like live ones. Fully isolated: never
                // delays, breaks, or reclassifies anything in this chain.
                const { evaluateRadarForOutcome } = await import("@/lib/radar-evaluate");
                await evaluateRadarForOutcome({
                  workspaceId: detectCtx.workspaceId,
                  workspaceSlug: decisionWorkspaceSlug,
                  outcome,
                });
              } catch (e) {
                console.log(`[chat] detection failed safely: ${e instanceof Error ? e.message : e}`);
                emit({ outcome: "detection_skipped", candidateIdPrefix: "none", reason: "detection_failed" });
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
      // after() outside request scope (tests, dev snippets): one privacy-safe
      // decision record so the skip itself stays observable. Slug is already
      // normalized server-side; no ids, contents, or addresses are logged.
      try {
        const safeSlug = decisionWorkspaceSlug.replace(/[^a-zA-Z0-9-_]/g, "").slice(0, 80) || "unknown";
        console.log(
          `[radar-decision] ${JSON.stringify({ src: "radar-decision", outcome: "detection_skipped", workspace: safeSlug, candidate: "none", reason: "no_request_scope" })}`,
        );
      } catch {
        // Logging must never break the request path.
      }
    }
}

/**
 * Deferred-detection recovery scheduler — request-scoped, non-blocking.
 *
 * Piggybacks one bounded sweep on live chat traffic (no cron in this
 * deployment): recent persisted customer reports with no incident
 * attribution are re-run through the normal detectFromChat path with
 * their ORIGINAL timestamps, so Radar window math stays honest.
 * Idempotent by construction (messageAlreadyClustered + exclusive
 * attribution); stops at the first judge/store failure so an ongoing
 * outage can never turn into a retry storm.
 */
function scheduleDeferredRecovery(args: {
  workspaceId: string;
  workspaceSlug: string;
  excludeMessageIds: string[];
}): void {
  if (!args.workspaceId) return;
  try {
    after(() =>
      (async () => {
        try {
          const { recoverDeferredReports } = await import("@/lib/detection-recovery");
          const { geminiJudge } = await import("@/lib/detection-gemini");
          const { recentConversationExcerpts } = await import("@/lib/detection");
          const { isGeminiConfigured } = await import("@/lib/env");
          if (!isGeminiConfigured()) return;
          const store = await import("@/lib/issue-candidates");
          const res = await recoverDeferredReports(
            args.workspaceId,
            {
              store: {
                messageAlreadyClustered: store.messageAlreadyClustered,
                pendingCandidatesForConversation: store.pendingCandidatesForConversation,
                pendingCandidateContexts: store.pendingCandidateContexts,
                dismissedCandidateTitles: store.dismissedCandidateTitles,
                createCandidate: store.createCandidate,
                addMessageToCandidate: store.addMessageToCandidate,
                deleteCandidate: store.deleteCandidate,
                listUnclusteredRecent: (ws, input) =>
                  store.listUnclusteredRecentMessages(ws, input),
              },
              judge: geminiJudge(),
              listRecentExcerpts: recentConversationExcerpts,
            },
            { excludeMessageIds: args.excludeMessageIds },
          );
          // Recovered reports that complete a qualifying candidate go
          // through the SAME Radar evaluation as live reports.
          if (res.joinedNew.length > 0) {
            const { evaluateRadarForOutcome } = await import("@/lib/radar-evaluate");
            for (const candidateId of res.joinedNew) {
              await evaluateRadarForOutcome({
                workspaceId: args.workspaceId,
                workspaceSlug: args.workspaceSlug,
                outcome: { action: "joined", candidateId, newConversation: true },
              });
            }
          }
          if (res.attempted > 0 || res.deferred > 0) {
            console.log(
              `[chat] deferred recovery ${args.workspaceSlug} attempted=${res.attempted} attached=${res.attached} deferred=${res.deferred}${res.stoppedEarly ? " (paused — provider still down)" : ""}`,
            );
          }
        } catch (e) {
          console.log(`[chat] deferred recovery skipped safely: ${e instanceof Error ? e.message : e}`);
        }
      })(),
    );
  } catch {
    // after() outside request scope: skip silently (tests, dev snippets).
  }
}
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
        console.log(`[chat] recall private ${r.status}/${r.errorKind} in ${r.durationMs}ms (${r.total} hits)`);
        return r;
      }),
    recallBounded(tenant.sharedNamespace, recallQuery, { topK: RECALL_TOP_K, maxDistance: MAX_DISTANCE })
      .then((r) => {
        console.log(`[chat] recall shared ${r.status}/${r.errorKind} in ${r.durationMs}ms (${r.total} hits)`);
        return r;
      }),
    recallBounded(deriveKnowledgeNamespaceV2(tenant.workspaceId), recallQuery, { topK: RECALL_TOP_K, maxDistance: MAX_DISTANCE })
      .then((r) => {
        console.log(`[chat] recall knowledge ${r.status}/${r.errorKind} in ${r.durationMs}ms (${r.total} hits)`);
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
  // Privacy-safe failure taxonomy (no secrets/namespaces): lets operators
  // tell empty-namespace ok/empty apart from auth / outage / timeout.
  const memoryErrorKinds = { private: p.errorKind, shared: s.errorKind, knowledge: k.errorKind } as const;
  const degradedMemory = p.status !== "ok" || s.status !== "ok" || k.status !== "ok";
  if (degradedMemory) {
    console.log(`[chat] recall degraded (private=${p.status}/${p.errorKind} shared=${s.status}/${s.errorKind} knowledge=${k.status}/${k.errorKind}) — answering with available context`);
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
    // The complaint IS persisted: schedule detection even though no answer
    // was produced, so a model outage can never silently drop an incident.
    // Same idempotent helper as the success path (store collapses repeats
    // onto messageId; Radar sends carry per-(candidate, operator) keys).
    scheduleDetectionFromChat({
      workspaceId: tenant.workspaceId,
      workspaceSlug: tenant.workspace.slug,
      conversationId,
      customerId: tenant.customerId,
      messageId: userMessageId,
      text: message.slice(0, 2000),
      resolved: detectResolution(message),
    });
    // Same turn: sweep other recent unclustered reports (bounded, lazy).
    scheduleDeferredRecovery({
      workspaceId: tenant.workspaceId,
      workspaceSlug: tenant.workspace.slug,
      excludeMessageIds: userMessageId ? [userMessageId] : [],
    });
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

  console.log(`[chat] done (private=${p.status}/${p.errorKind} shared=${s.status}/${s.errorKind} knowledge=${k.status}/${k.errorKind} provenance=${provenance.length})`);

  // S5 automatic issue detection (see scheduleDetectionFromChat): one call
  // covers the persisted turn whether the answer below succeeds or fails —
  // the Gemini-failure return above schedules the same helper first.
  // Deferred recovery for OTHER recent unclustered reports rides the same
  // request scope (lazy, bounded, original timestamps preserved).
  scheduleDetectionFromChat({
    workspaceId: tenant.workspaceId,
    workspaceSlug: tenant.workspace.slug,
    conversationId,
    customerId: tenant.customerId,
    messageId: userMessageId,
    text: message.slice(0, 2000),
    resolved,
  });
  scheduleDeferredRecovery({
    workspaceId: tenant.workspaceId,
    workspaceSlug: tenant.workspace.slug,
    excludeMessageIds: userMessageId ? [userMessageId] : [],
  });

  return NextResponse.json({
    ok: true,
    answer,
    resolutionDetected: resolved,
    memoryStatus,
    memoryErrorKinds,
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
