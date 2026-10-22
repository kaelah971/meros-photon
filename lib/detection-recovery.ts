import type { DetectInput, DetectResult, Judge } from "./detection";
import type { DetectStore } from "./detection";
import type { UnclusteredMessage } from "./issue-candidates";

/**
 * Durable recovery for deferred detection — lazy, bounded, honest.
 *
 * WHY LAZY: this deployment runs no cron/scheduler (and adding one is
 * heavier than the problem). Recovery piggybacks on live chat traffic:
 * every persisted customer turn schedules one bounded sweep in the
 * request-scoped background chain that already runs detection. No
 * traffic → no recovery pressure needed (nothing new to classify).
 *
 * HONEST TIMESTAMPS: replays pass each message's ORIGINAL persisted
 * created_at through to attribution, so Radar's 60-minute eligibility
 * window math cannot mistake replay time for report time. Expired
 * reports are still classified for incident visibility, but they can
 * never look fresh to Radar.
 *
 * BOUNDED: one indexed listing (≤10 rows read, ≤3 attempted by
 * default) per sweep; the first judge/store failure stops the sweep
 * (provider still down → try again on later traffic, never a storm).
 * Concurrency collapses onto existing idempotency: messageAlreadyClustered
 * pre-checks, exclusive-attribution unique constraints, and
 * already_clustered re-reads — two workers can never double-attach.
 */

export const RECOVERY_WINDOW_MINUTES = 60;
export const RECOVERY_MAX_ATTEMPTS = 3;

export type RecoveryStore = Pick<
  DetectStore,
  | "messageAlreadyClustered"
  | "pendingCandidatesForConversation"
  | "pendingCandidateContexts"
  | "dismissedCandidateTitles"
  | "createCandidate"
  | "addMessageToCandidate"
  | "deleteCandidate"
> & {
  listUnclusteredRecent: (
    workspaceId: string,
    input: { sinceIso: string; excludeMessageIds?: readonly string[]; limit?: number },
  ) => Promise<UnclusteredMessage[]>;
};

export type RecoveryDeps = {
  store: RecoveryStore;
  judge: Judge;
  listRecentExcerpts: (workspaceId: string, excludeConversationId: string, limit: number) => Promise<{ id: string; excerpt: string }[]>;
  now?: () => Date;
};

export type RecoveryResult = {
  /** Messages examined (listed and passed to detection). */
  attempted: number;
  /** Messages newly attached to a candidate (created or joined). */
  attached: number;
  /** Messages that ended deferred/not_issue/ignored (provider down or no substance). */
  deferred: number;
  /** Stopped early on first judge/store failure to avoid a retry storm. */
  stoppedEarly: boolean;
  candidateIds: string[];
  /**
   * Candidates gained by a genuinely NEW conversation in this sweep.
   * The caller runs these through the existing Radar evaluation so a
   * recovered report that completes a qualifying candidate alerts
   * exactly like a live one.
   */
  joinedNew: string[];
};

export async function recoverDeferredReports(
  workspaceId: string,
  deps: RecoveryDeps,
  opts?: {
    excludeMessageIds?: readonly string[];
    limit?: number;
    windowMinutes?: number;
    now?: Date;
  },
): Promise<RecoveryResult> {
  const now = opts?.now ?? deps.now?.() ?? new Date();
  const windowMinutes = opts?.windowMinutes ?? RECOVERY_WINDOW_MINUTES;
  const limit = Math.min(Math.max(opts?.limit ?? RECOVERY_MAX_ATTEMPTS, 1), 10);
  const sinceIso = new Date(now.getTime() - windowMinutes * 60_000).toISOString();
  const out: RecoveryResult = { attempted: 0, attached: 0, deferred: 0, stoppedEarly: false, candidateIds: [], joinedNew: [] };

  let pending: UnclusteredMessage[];
  try {
    pending = await deps.store.listUnclusteredRecent(workspaceId, {
      sinceIso,
      excludeMessageIds: opts?.excludeMessageIds,
      limit,
    });
  } catch {
    return { ...out, stoppedEarly: true };
  }
  if (pending.length === 0) return out;

  const { detectFromChat } = await import("./detection");
  for (const m of pending) {
    const input: DetectInput = {
      workspaceId,
      conversationId: m.conversationId,
      customerId: m.customerId,
      messageId: m.messageId,
      text: m.text,
      createdAt: m.createdAt,
    };
    let result: DetectResult;
    try {
      result = await detectFromChat(input, {
        judge: deps.judge,
        store: deps.store,
        listRecentExcerpts: deps.listRecentExcerpts,
      });
    } catch {
      out.stoppedEarly = true;
      break;
    }
    out.attempted++;
    if (result.action === "created" || result.action === "joined") {
      out.attached++;
      if (!out.candidateIds.includes(result.candidateId)) out.candidateIds.push(result.candidateId);
      if (result.action === "joined" && result.newConversation && !out.joinedNew.includes(result.candidateId)) {
        out.joinedNew.push(result.candidateId);
      }
    } else if (result.action === "deferred") {
      // Judge or store failed (provider likely still down): stop the
      // sweep here — later traffic retries. Bounded, never a storm.
      out.deferred++;
      out.stoppedEarly = true;
      break;
    } else {
      // already_clustered (raced), ignored, not_issue, suppressed_dismissed:
      // settled states, keep sweeping the rest.
      out.deferred++;
    }
  }
  return out;
}
