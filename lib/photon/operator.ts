// Photon S1 operator orchestration: inbound iMessage -> workspace stats reply.
// Pure orchestration with injected dependencies so the exact dedupe +
// authorization decisions are unit-testable without Neon or Photon.
// Production wiring lives in lib/photon/bot.ts (real deps) and the only
// side effects are: persist history rows + post ONE reply via the adapter.

export type StatsSnapshot = {
  openIssues: number;
  customers: number;
  conversations: number;
  pendingFixCards: number;
  sharedFixes: number;
};

export type OperatorBinding = {
  id: string;
  workspaceId: string;
  operatorUserId: string;
  threadId: string | null;
};

export type OperatorWorkspace = {
  id: string;
  slug: string;
  name: string;
};

export type OperatorDeps = {
  findBinding: (senderHash: string) => Promise<OperatorBinding | null>;
  claimPairing: (code: string, senderHash: string) => Promise<OperatorBinding | null>;
  /**
   * Record the inbound thread as the binding's durable conversation address
   * (S2 proactive sends). Best-effort: failures never block the reply.
   */
  noteThread: (bindingId: string, threadId: string | null) => Promise<void>;
  checkStaff: (userId: string, workspaceId: string) => Promise<void>;
  readStats: (workspaceId: string) => Promise<StatsSnapshot>;
  findWorkspaceBySlug: (slug: string) => Promise<OperatorWorkspace | null>;
  listWorkspaces: (userId: string) => Promise<OperatorWorkspace[]>;
  recordInbound: (input: {
    providerMessageId: string | null;
    threadId: string | null;
    senderHash: string;
    text: string;
  }) => Promise<{ id: string; status: string; deduped: boolean }>;
  claimReply: (input: {
    inboundId: string;
    workspaceId: string | null;
    bindingId: string | null;
    threadId: string | null;
    replyText: string;
  }) => Promise<{ id: string } | null>;
  markSent: (outboundId: string, providerId?: string | null) => Promise<void>;
  releaseSlot: (outboundId: string) => Promise<void>;
  markReplied: (
    inboundId: string,
    workspaceId: string | null,
    bindingId: string | null,
  ) => Promise<void>;
  markRejected: (
    inboundId: string,
    workspaceId: string | null,
    bindingId: string | null,
  ) => Promise<void>;
  post: (text: string) => Promise<{ providerId?: string | null }>;
};

export type OperatorInput = {
  providerMessageId: string | null;
  threadId: string | null;
  senderHash: string;
  text: string;
  isBot: boolean;
};

export type OperatorResult =
  | { action: "ignored" }
  | { action: "deduped" }
  | { action: "stats"; replyText: string }
  | { action: "paired"; replyText: string }
  | { action: "pairing-required"; replyText: string }
  | { action: "pair-failed"; replyText: string }
  | { action: "usage"; replyText: string }
  | { action: "denied"; replyText: string }
  | { action: "unknown-workspace"; replyText: string }
  | { action: "choose-workspace"; replyText: string }
  | { action: "degraded"; replyText: string };

const STATS_RE = /^\s*stats(?:\s+([A-Za-z0-9-]{2,32}))?\s*$/i;
const PAIR_RE = /^\s*pair\s+([A-Za-z0-9-]{4,32})\s*$/i;

/** Narrow S1 intent: `stats` or `stats <workspace-slug>`. Pure. */
export function parseStatsIntent(text: string): { slug: string | null } | null {
  const m = STATS_RE.exec(text);
  if (!m) return null;
  return { slug: m[1] ? m[1].toLowerCase() : null };
}

/** `pair <CODE>` intent. Pure. */
export function parsePairIntent(text: string): { code: string } | null {
  const m = PAIR_RE.exec(text);
  if (!m) return null;
  return { code: m[1].toUpperCase() };
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Exact S1 reply body from LIVE stats. Pure — never hardcoded demo numbers. */
export function formatStatsReply(workspaceName: string, s: StatsSnapshot): string {
  return [
    `Meros — ${workspaceName} right now:`,
    ``,
    plural(s.conversations, "conversation", "conversations"),
    plural(s.customers, "customer", "customers"),
    plural(s.openIssues, "open issue", "open issues"),
    plural(s.pendingFixCards, "Fix Card waiting for review", "Fix Cards waiting for review"),
    plural(s.sharedFixes, "shared fix", "shared fixes"),
    ``,
    `Nothing urgent is being inferred yet — this is just the live workspace proof.`,
  ].join("\n");
}

export const PAIRING_REQUIRED_TEXT =
  `Meros: this iMessage sender isn't paired to a Meros operator yet. ` +
  `Ask your workspace admin for a pairing code, then reply \`pair XXXX-XXXX-XXXX\`. ` +
  `No workspace data is shown until pairing succeeds.`;

export const USAGE_TEXT =
  `Meros S1 proof supports one command for now: \`stats\` (your workspace) ` +
  `or \`stats <workspace-slug>\`.`;

export const PAIR_FAILED_TEXT =
  `Meros: that pairing code didn't match (it may have expired or was already used). ` +
  `Ask your workspace admin for a fresh code, then reply \`pair XXXX-XXXX-XXXX\`.`;

export const DENIED_TEXT =
  `Meros: this sender is paired, but the linked operator no longer has staff ` +
  `access to that workspace. Ask your workspace admin to re-pair you.`;

export const DEGRADED_TEXT =
  `Meros Photon is temporarily unavailable (workspace state unreachable). ` +
  `Nothing was recorded — please resend shortly; retries are deduped.`;

/**
 * Post exactly one reply for an inbound row: claim the unique reply slot,
 * send via the adapter, then finalize. Losing the slot race (or finding the
 * inbound already replied) means do NOT send. A failed send releases the
 * slot so a Spectrum redelivery can reclaim it.
 */
async function replyOnce(
  deps: OperatorDeps,
  ctx: { inboundId: string; workspaceId: string | null; bindingId: string | null; threadId: string | null },
  replyText: string,
  terminal: "replied" | "rejected",
): Promise<{ replyText: string }> {
  const slot = await deps.claimReply({ ...ctx, replyText });
  if (!slot) return { replyText };
  try {
    const sent = await deps.post(replyText);
    await deps.markSent(slot.id, sent.providerId ?? null);
  } catch {
    await deps.releaseSlot(slot.id);
    throw new Error("photon send failed");
  }
  if (terminal === "replied") {
    await deps.markReplied(ctx.inboundId, ctx.workspaceId, ctx.bindingId);
  } else {
    await deps.markRejected(ctx.inboundId, ctx.workspaceId, ctx.bindingId);
  }
  return { replyText };
}

export async function handleOperatorMessage(
  input: OperatorInput,
  deps: OperatorDeps,
): Promise<OperatorResult> {
  if (input.isBot) return { action: "ignored" };
  const text = input.text.trim();

  let inbound: { id: string; status: string; deduped: boolean };
  try {
    inbound = await deps.recordInbound({
      providerMessageId: input.providerMessageId,
      threadId: input.threadId,
      senderHash: input.senderHash,
      text,
    });
  } catch {
    // Neon unreachable: persist nothing, send nothing with history. Best
    // effort honest notice (no slot to claim, so a retry may repeat THIS
    // notice only — never a stats reply).
    try {
      await deps.post(DEGRADED_TEXT);
    } catch {
      // Adapter also down — Spectrum will retry; stay honest and quiet.
    }
    return { action: "degraded", replyText: DEGRADED_TEXT };
  }
  // Redelivery of an already-answered message: absolute no-op.
  if (inbound.deduped && inbound.status === "replied") return { action: "deduped" };
  if (inbound.deduped && inbound.status === "rejected") return { action: "deduped" };

  const ctx = {
    inboundId: inbound.id,
    workspaceId: null as string | null,
    bindingId: null as string | null,
    threadId: input.threadId,
  };

  // Pairing claims work WITHOUT an existing binding (that is the point).
  const pair = parsePairIntent(text);
  if (pair) {
    let claimed: OperatorBinding | null = null;
    try {
      claimed = await deps.claimPairing(pair.code, input.senderHash);
    } catch {
      return { action: "degraded", replyText: DEGRADED_TEXT };
    }
    if (!claimed) {
      await replyOnce(deps, ctx, PAIR_FAILED_TEXT, "rejected");
      return { action: "pair-failed", replyText: PAIR_FAILED_TEXT };
    }
    let ws: OperatorWorkspace | null = null;
    try {
      const all = await deps.listWorkspaces(claimed.operatorUserId);
      ws = all.find((w) => w.id === claimed!.workspaceId) ?? null;
    } catch {
      // Non-fatal: confirm pairing without the display name.
    }
    const replyText =
      `Meros: paired — this sender is now linked to ` +
      `${ws ? ws.name : "your workspace"}. Send \`stats\` to read live workspace state.`;
    try {
      await deps.noteThread(claimed.id, input.threadId);
    } catch {
      // Address recording is best-effort; the pairing reply still sends.
    }
    await replyOnce(
      deps,
      { ...ctx, workspaceId: claimed.workspaceId, bindingId: claimed.id },
      replyText,
      "replied",
    );
    return { action: "paired", replyText };
  }

  // Every other intent requires an ACTIVE binding. Unknown senders learn
  // ONLY how to pair — never workspace/customer data.
  let binding: OperatorBinding | null = null;
  try {
    binding = await deps.findBinding(input.senderHash);
  } catch {
    return { action: "degraded", replyText: DEGRADED_TEXT };
  }
  if (!binding) {
    await replyOnce(deps, ctx, PAIRING_REQUIRED_TEXT, "rejected");
    return { action: "pairing-required", replyText: PAIRING_REQUIRED_TEXT };
  }
  ctx.bindingId = binding.id;
  try {
    await deps.noteThread(binding.id, input.threadId);
  } catch {
    // Address recording is best-effort; the command reply still sends.
  }

  const stats = parseStatsIntent(text);
  if (!stats) {
    await replyOnce(deps, { ...ctx, workspaceId: binding.workspaceId }, USAGE_TEXT, "rejected");
    return { action: "usage", replyText: USAGE_TEXT };
  }

  // Resolve WHICH workspace: explicit slug, or the operator's single
  // workspace, or a membership-filtered chooser. Never trust client input
  // beyond the slug string — membership is re-checked below regardless.
  let workspaceId = binding.workspaceId;
  let workspace: OperatorWorkspace | null = null;
  try {
    if (stats.slug) {
      workspace = await deps.findWorkspaceBySlug(stats.slug);
      if (!workspace) {
        const replyText =
          `Meros: I don't have access to a workspace called \u201c${stats.slug}\u201d. ` +
          `Send \`stats\` to use your paired workspace.`;
        await replyOnce(deps, { ...ctx, workspaceId: binding.workspaceId }, replyText, "rejected");
        return { action: "unknown-workspace", replyText };
      }
      workspaceId = workspace.id;
    } else {
      const mine = await deps.listWorkspaces(binding.operatorUserId);
      const bound = mine.find((w) => w.id === binding!.workspaceId) ?? null;
      if (bound) {
        workspace = bound;
      } else if (mine.length === 1) {
        workspace = mine[0];
        workspaceId = mine[0].id;
      } else if (mine.length > 1) {
        const replyText =
          `Meros: you're staff on several workspaces — reply with one:\n` +
          mine.map((w) => `\`stats ${w.slug}\``).join("\n");
        await replyOnce(deps, { ...ctx, workspaceId: binding.workspaceId }, replyText, "rejected");
        return { action: "choose-workspace", replyText };
      } else {
        await replyOnce(deps, { ...ctx, workspaceId: binding.workspaceId }, DENIED_TEXT, "rejected");
        return { action: "denied", replyText: DENIED_TEXT };
      }
    }
  } catch (e) {
    if (e instanceof Error && e.message === "photon send failed") throw e;
    return { action: "degraded", replyText: DEGRADED_TEXT };
  }

  // Staff gate on the RESOLVED workspace (not the binding's): explicit-slug
  // requests for foreign workspaces die here with zero stats leaked.
  try {
    await deps.checkStaff(binding.operatorUserId, workspaceId);
  } catch {
    await replyOnce(deps, { ...ctx, workspaceId }, DENIED_TEXT, "rejected");
    return { action: "denied", replyText: DENIED_TEXT };
  }

  let snapshot: StatsSnapshot;
  let displayName = workspace?.name ?? "workspace";
  try {
    snapshot = await deps.readStats(workspaceId);
    if (!workspace) {
      const mine = await deps.listWorkspaces(binding.operatorUserId);
      displayName = mine.find((w) => w.id === workspaceId)?.name ?? displayName;
    }
  } catch {
    return { action: "degraded", replyText: DEGRADED_TEXT };
  }

  const replyText = formatStatsReply(displayName, snapshot);
  await replyOnce(deps, { ...ctx, workspaceId, bindingId: binding.id }, replyText, "replied");
  return { action: "stats", replyText };
}
