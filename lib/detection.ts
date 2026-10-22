import "server-only";

type Sql = <T = Record<string, unknown>[]>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<T>;

async function getSql(): Promise<Sql | null> {
  const { dbAvailable } = await import("./db");
  if (!(await dbAvailable())) return null;
  const { neon } = await import("@neondatabase/serverless");
  const url = process.env.DATABASE_URL!.trim();
  return neon(url) as unknown as Sql;
}

/**
 * Bounded recent excerpts for judge context: latest user message per
 * conversation (excluding the current one), newest first. Pure reads,
 * truncated excerpts — never full transcripts.
 */
export async function recentConversationExcerpts(
  workspaceId: string,
  excludeConversationId: string,
  limit: number,
): Promise<{ id: string; excerpt: string }[]> {
  const sql = await getSql();
  if (!sql) return [];
  const convs = (await sql`
    select id from conversations
    where workspace_id = ${workspaceId} and id != ${excludeConversationId}
    order by coalesce(last_message_at, created_at) desc limit ${Math.min(Math.max(limit, 1), 10)}
  `) as unknown as { id: string }[];
  const out: { id: string; excerpt: string }[] = [];
  for (const c of convs) {
    const msgs = (await sql`
      select content from messages
      where conversation_id = ${c.id} and role = 'user'
      order by created_at desc limit 1
    `) as unknown as { content: string }[];
    const text = (msgs[0]?.content ?? "").replace(/\s+/g, " ").trim();
    if (text) out.push({ id: c.id, excerpt: text.slice(0, 300) });
  }
  return out;
}

// S5 automatic issue detection: hooks into the real customer-message path
// (see app/api/chat/route.ts). Pure orchestration with an injected judge so
// every decision is unit-testable without AI. Production judge lives in
// ./detection-gemini and is the ONLY network-touching piece.
//
// Guarantees:
// - never blocks or breaks the support reply (callers isolate failures)
// - never invents customers/messages/causes (all ids verified server-side)
// - retries and concurrent deliveries dedupe on persisted rows
// - AI absence/failure degrades to "no candidate", never to a guess

import type {
  CandidateConfidence,
  CandidateSummary,
} from "./issue-candidates";

export type JudgeCandidateInput = {
  id: string;
  title: string;
  summary: string;
  excerpts: string[];
};

export type JudgeResult = {
  /** False for greetings, thanks, follow-ups without new substance. */
  isIssue: boolean;
  title: string;
  summary: string;
  /** Pending candidate this report joins (must be one of the inputs). */
  matchCandidateId: string | null;
  /** Dismissed candidate this resembles (regen guard — no new candidate). */
  dismissedMatchId: string | null;
  quality: CandidateConfidence;
  /** Why the reports are (or are not) the same problem, in plain words. */
  rationale: string;
};

export type Judge = (input: {
  message: string;
  candidates: JudgeCandidateInput[];
  dismissed: { id: string; title: string }[];
  recentConversations: { id: string; excerpt: string }[];
}) => Promise<JudgeResult>;

export type DetectInput = {
  workspaceId: string;
  conversationId: string;
  customerId: string;
  messageId: string;
  text: string;
};

export type DetectStore = {
  messageAlreadyClustered: (workspaceId: string, messageId: string) => Promise<{ candidateId: string } | null>;
  pendingCandidatesForConversation: (workspaceId: string, conversationId: string) => Promise<CandidateSummary[]>;
  pendingCandidateContexts: (workspaceId: string, limit: number) => Promise<
    { id: string; title: string; summary: string; confidence: CandidateConfidence; excerpts: string[] }[]
  >;
  dismissedCandidateTitles: (workspaceId: string) => Promise<{ id: string; title: string }[]>;
  createCandidate: (input: {
    workspaceId: string;
    title: string;
    summary: string;
    confidence: CandidateConfidence;
    rationale: string;
  }) => Promise<{ id: string }>;
  addMessageToCandidate: (input: {
    candidateId: string;
    workspaceId: string;
    messageId: string;
    conversationId: string;
    customerId: string;
  }) => Promise<{ memberAdded: boolean; messageAdded: boolean; duplicateOf: string | null } | null>;
  deleteCandidate: (candidateId: string, workspaceId: string) => Promise<void>;
};

export type DetectDeps = {
  judge: Judge;
  store: DetectStore;
  listRecentExcerpts: (workspaceId: string, excludeConversationId: string, limit: number) => Promise<{ id: string; excerpt: string }[]>;
  onNoIssue?: () => void;
};

export type DetectResult =
  | { action: "ignored" }
  | { action: "not_issue" }
  | { action: "already_clustered"; candidateId: string }
  | { action: "deferred" }
  | { action: "joined"; candidateId: string; newConversation: boolean }
  | { action: "suppressed_dismissed"; candidateId: string }
  | { action: "created"; candidateId: string };

const MIN_REPORT_CHARS = 24;
const MAX_MESSAGE_CHARS = 2000;
const MAX_RECENT_CONVERSATIONS = 10;

function excerptOf(text: string, max = 300): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max) : clean;
}

export async function detectFromChat(
  input: DetectInput,
  deps: DetectDeps,
): Promise<DetectResult> {
  const text = input.text.trim();
  // Cheap gates first: never spend model calls on trivial turns.
  if (text.length < MIN_REPORT_CHARS) return { action: "ignored" };

  // Retry/idempotency: the same persisted message never clusters twice.
  const clustered = await deps.store.messageAlreadyClustered(input.workspaceId, input.messageId).catch(() => null);
  if (clustered) return { action: "already_clustered", candidateId: clustered.candidateId };

  // Sticky home: a conversation already in a pending candidate keeps its
  // messages attributed there unless the judge finds no issue at all.
  const homes = await deps.store.pendingCandidatesForConversation(input.workspaceId, input.conversationId).catch(() => []);
  const home = homes[0] ?? null;

  let recent: { id: string; excerpt: string }[] = [];
  try {
    recent = await deps.listRecentExcerpts(input.workspaceId, input.conversationId, MAX_RECENT_CONVERSATIONS);
  } catch {
    return { action: "deferred" };
  }
  let candidates: JudgeCandidateInput[] = [];
  let dismissed: { id: string; title: string }[] = [];
  try {
    candidates = await deps.store.pendingCandidateContexts(input.workspaceId, MAX_RECENT_CONVERSATIONS);
    dismissed = await deps.store.dismissedCandidateTitles(input.workspaceId);
  } catch {
    return { action: "deferred" };
  }

  let judged: JudgeResult;
  try {
    judged = await deps.judge({
      message: text.slice(0, MAX_MESSAGE_CHARS),
      candidates: candidates.map((c) => ({
        id: c.id,
        title: c.title,
        summary: c.summary,
        excerpts: c.excerpts.map((e) => excerptOf(e)),
      })),
      dismissed,
      recentConversations: recent.map((r) => ({ id: r.id, excerpt: excerptOf(r.excerpt) })),
    });
  } catch {
    // AI unavailable or malformed output: degrade silently, never guess.
    return { action: "deferred" };
  }
  if (!judged.isIssue) {
    deps.onNoIssue?.();
    return { action: "not_issue" };
  }

  // Defensive: the judge may only reference candidates it was actually shown.
  const knownPending = new Set(candidates.map((c) => c.id));
  const matchId = judged.matchCandidateId && knownPending.has(judged.matchCandidateId) ? judged.matchCandidateId : null;
  const knownDismissed = new Set(dismissed.map((d) => d.id));
  const dismissedId = judged.dismissedMatchId && knownDismissed.has(judged.dismissedMatchId) ? judged.dismissedMatchId : null;

  const targetId = matchId ?? home?.id ?? null;
  if (targetId) {
    const added = await deps.store.addMessageToCandidate({
      candidateId: targetId,
      workspaceId: input.workspaceId,
      messageId: input.messageId,
      conversationId: input.conversationId,
      customerId: input.customerId,
    }).catch(() => null);
    if (!added) return { action: "deferred" };
    if (added.duplicateOf && added.duplicateOf !== targetId) {
      return { action: "already_clustered", candidateId: added.duplicateOf };
    }
    return { action: "joined", candidateId: targetId, newConversation: added.memberAdded };
  }

  // Regen guard: unchanged evidence matching a dismissed candidate stays buried.
  if (dismissedId) return { action: "suppressed_dismissed", candidateId: dismissedId };

  const created = await deps.store.createCandidate({
    workspaceId: input.workspaceId,
    title: judged.title,
    summary: judged.summary,
    confidence: judged.quality,
    rationale: judged.rationale,
  }).catch(() => null);
  if (!created) {
    // Lost a creation race with a concurrent delivery of the same message:
    // re-read instead of duplicating.
    const raced = await deps.store.messageAlreadyClustered(input.workspaceId, input.messageId).catch(() => null);
    if (raced) return { action: "already_clustered", candidateId: raced.candidateId };
    return { action: "deferred" };
  }
  const attached = await deps.store.addMessageToCandidate({
    candidateId: created.id,
    workspaceId: input.workspaceId,
    messageId: input.messageId,
    conversationId: input.conversationId,
    customerId: input.customerId,
  }).catch(() => null);
  // Lost the exclusive-attribution race: drop the orphan we just made and
  // report the winner instead of duplicating the candidate.
  if (attached && attached.duplicateOf && attached.duplicateOf !== created.id) {
    await deps.store.deleteCandidate(created.id, input.workspaceId).catch(() => null);
    return { action: "already_clustered", candidateId: attached.duplicateOf };
  }
  if (!attached || !attached.messageAdded) {
    // The candidate row exists but the report was NOT linked (transient
    // store failure or verification mismatch). Claiming "created" here
    // would strand an empty candidate while the report stays invisible
    // to Radar. Defer honestly instead: a later genuine report can still
    // join this pending candidate; nothing is duplicated or invented.
    return { action: "deferred" };
  }
  return { action: "created", candidateId: created.id };
}
