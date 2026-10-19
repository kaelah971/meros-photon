// Photon S1 operator orchestration: inbound iMessage -> workspace stats reply.
// Pure orchestration with injected dependencies so the exact dedupe +
// authorization decisions are unit-testable without Neon or Photon.
// Production wiring lives in lib/photon/bot.ts (real deps) and the only
// side effects are: persist history rows + post ONE reply via the adapter.

import type { InvestigateReads } from "./investigate";
import type { ConversePlan, ConverseTurn, PhraseInput } from "./converse";

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
  /**
   * S15C read-only investigation surface. Optional so older callers keep
   * working: when absent, investigation commands reply unavailable.
   * Production always provides it (see bot.ts realDeps).
   */
  investigate?: InvestigateReads;
  /**
   * S15C.1 conversational layer. Optional so older callers keep the exact
   * legacy usage reply: when absent, unmatched text still gets USAGE_TEXT.
   * Production always provides it (see bot.ts realDeps).
   */
  converse?: ConverseDeps;
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
  | { action: "converse"; replyText: string }
  | { action: "denied"; replyText: string }
  | { action: "unknown-workspace"; replyText: string }
  | { action: "choose-workspace"; replyText: string }
  | { action: "degraded"; replyText: string }
  | { action: "help"; replyText: string }
  | { action: "incidents"; replyText: string }
  | { action: "alerts"; replyText: string }
  | { action: "show"; replyText: string }
  | { action: "investigate"; replyText: string }
  | { action: "evidence"; replyText: string }
  | { action: "matches"; replyText: string }
  | { action: "decisions"; replyText: string }
  | { action: "clarify"; replyText: string }
  | { action: "at-menu"; replyText: string }
  | { action: "at-memory"; replyText: string }
  | { action: "unavailable"; replyText: string };

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

export type AtIntent =
  | { kind: "menu" }
  | { kind: "status" }
  | { kind: "alerts" }
  | { kind: "incidents" }
  | { kind: "reviews" }
  | { kind: "memory" };

/** `@` shortcut intent (`@`, `@status`, `@alerts`, …). Pure. Null when no `@` prefix. */
export function parseAtIntent(text: string): AtIntent | null {
  const t = text.trim();
  if (!t.startsWith("@")) return null;
  const sub = t.slice(1).trim().toLowerCase().replace(/\s+/g, "");
  switch (sub) {
    case "":
    case "help":
    case "menu":
      return { kind: "menu" };
    case "status":
      return { kind: "status" };
    case "alerts":
      return { kind: "alerts" };
    case "incidents":
      return { kind: "incidents" };
    case "reviews":
    case "decisions":
    case "todo":
      return { kind: "reviews" };
    case "memory":
    case "fixes":
      return { kind: "memory" };
    default:
      return { kind: "menu" };
  }
}

export const AT_MENU_TEXT =
  `Meros shortcuts \u2014 or just ask in plain words, I understand those too:\n` +
  `@status \u2014 workspace overview\n` +
  `@alerts \u2014 possible recurring problems\n` +
  `@incidents \u2014 active incidents\n` +
  `@reviews \u2014 pending operator decisions\n` +
  `@memory \u2014 historical fixes\n` +
  `@help \u2014 show this menu`;

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
  `Meros commands: \`incidents\` \`alerts\` \`show me\` \`investigate <ref>\` ` +
  `\`evidence <ref>\` \`matches <ref>\` \`decisions\` \`stats\` — or \`help\`.`;

export const PAIR_FAILED_TEXT =
  `Meros: that pairing code didn't match (it may have expired or was already used). ` +
  `Ask your workspace admin for a fresh code, then reply \`pair XXXX-XXXX-XXXX\`.`;

export const DENIED_TEXT =
  `Meros: this sender is paired, but the linked operator no longer has staff ` +
  `access to that workspace. Ask your workspace admin to re-pair you.`;

export const DEGRADED_TEXT =
  `Meros Photon is temporarily unavailable (workspace state unreachable). ` +
  `Nothing was recorded — please resend shortly; retries are deduped.`;

export type ConverseDeps = {
  loadHistory: (workspaceId: string, bindingId: string) => Promise<ConverseTurn[]>;
  classify: (text: string, history: ConverseTurn[]) => Promise<ConversePlan>;
  phrase: (input: PhraseInput) => Promise<string>;
};

export const INVESTIGATE_UNAVAILABLE_TEXT =
  `Investigation commands are unavailable right now (workspace state unreachable). ` +
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

  // `@` shortcuts ride the same authenticated router: binding + staff gate
  // apply inside handleAtIntent, exactly like the investigate path.
  const at = parseAtIntent(text);
  if (at) {
    return handleAtIntent(deps, ctx, binding, at);
  }

  const stats = parseStatsIntent(text);
  if (!stats) {
    const { parseRouterIntent } = await import("./investigate");
    const intent = parseRouterIntent(text);
    if (intent) {
      return handleInvestigateIntent(deps, ctx, binding, intent);
    }
    // S15C.1: natural language falls through to the conversational layer.
    // Exact commands above are untouched; without converse configured the
    // legacy usage reply is preserved exactly.
    return handleConversational(deps, ctx, binding, text);
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

/**
 * S15C read-only investigation dispatch. Investigation always runs in the
 * BINDING's workspace (paired context) with a staff re-check — unknown or
 * revoked operators never reach the read models. Every branch answers from
 * persisted records with links; failures return an honest unavailable
 * notice without claiming a slot, so a redelivery can retry the read.
 */
async function handleInvestigateIntent(
  deps: OperatorDeps,
  ctx: { inboundId: string; workspaceId: string | null; bindingId: string | null; threadId: string | null },
  binding: OperatorBinding,
  intent: import("./investigate").RouterIntent,
): Promise<OperatorResult> {
  const reads = deps.investigate;
  if (!reads) {
    return { action: "unavailable", replyText: INVESTIGATE_UNAVAILABLE_TEXT };
  }
  try {
    await deps.checkStaff(binding.operatorUserId, binding.workspaceId);
  } catch {
    await replyOnce(deps, { ...ctx, workspaceId: binding.workspaceId }, DENIED_TEXT, "rejected");
    return { action: "denied", replyText: DENIED_TEXT };
  }
  const ws = binding.workspaceId;
  const linkCtx = { ...ctx, workspaceId: ws, bindingId: binding.id };
  const slug = await reads.workspaceSlug(ws).catch(() => null);
  if (!slug) return { action: "unavailable", replyText: INVESTIGATE_UNAVAILABLE_TEXT };
  try {
    const inv = await import("./investigate");
    switch (intent.kind) {
      case "help": {
        const replyText = inv.helpText();
        await replyOnce(deps, linkCtx, replyText, "replied");
        return { action: "help", replyText };
      }
      case "incidents": {
        const rows = await reads.listActiveIncidents(ws);
        const replyText = inv.incidentsReply(slug, rows);
        await replyOnce(deps, linkCtx, replyText, "replied");
        return { action: "incidents", replyText };
      }
      case "alerts": {
        const rows = await reads.listReviewCandidates(ws);
        const replyText = inv.alertsReply(slug, rows);
        await replyOnce(deps, linkCtx, replyText, "replied");
        return { action: "alerts", replyText };
      }
      case "show":
        return showMe(deps, linkCtx, ws, slug, reads, binding.operatorUserId);
      case "investigate":
        return investigateRef(deps, linkCtx, ws, slug, reads, intent.ref);
      case "evidence":
        return evidenceRef(deps, linkCtx, ws, slug, reads, intent.ref);
      case "matches":
        return matchesRef(deps, linkCtx, ws, slug, reads, intent.ref);
      case "decisions": {
        const items = await reads.listDecisions(ws);
        const replyText = inv.decisionsReply(slug, items);
        await replyOnce(deps, linkCtx, replyText, "replied");
        return { action: "decisions", replyText };
      }
    }
  } catch (e) {
    if (e instanceof Error && e.message === "photon send failed") throw e;
    return { action: "unavailable", replyText: INVESTIGATE_UNAVAILABLE_TEXT };
  }
}

/**
 * S15C.2 `@` shortcuts: a lightweight secondary interface inside the
 * existing router. Binding is already resolved by the caller; staff is
 * re-checked here before any workspace read, exactly like the investigate
 * and conversational paths. Aliases delegate to handleInvestigateIntent
 * (same read models, same replies); `@memory` points at the authenticated
 * Fix Cards library instead of inventing results. Read-only: nothing here
 * mutates, approves, publishes, or closes anything.
 */
async function handleAtIntent(
  deps: OperatorDeps,
  ctx: { inboundId: string; workspaceId: string | null; bindingId: string | null; threadId: string | null },
  binding: OperatorBinding,
  at: AtIntent,
): Promise<OperatorResult> {
  try {
    await deps.checkStaff(binding.operatorUserId, binding.workspaceId);
  } catch {
    await replyOnce(deps, { ...ctx, workspaceId: binding.workspaceId }, DENIED_TEXT, "rejected");
    return { action: "denied", replyText: DENIED_TEXT };
  }
  const ws = binding.workspaceId;
  const linkCtx = { ...ctx, workspaceId: ws, bindingId: binding.id };
  if (at.kind === "alerts") return handleInvestigateIntent(deps, ctx, binding, { kind: "alerts" });
  if (at.kind === "incidents") return handleInvestigateIntent(deps, ctx, binding, { kind: "incidents" });
  if (at.kind === "reviews") return handleInvestigateIntent(deps, ctx, binding, { kind: "decisions" });
  if (at.kind === "status") {
    let snapshot: StatsSnapshot;
    let displayName = "workspace";
    try {
      snapshot = await deps.readStats(ws);
      const mine = await deps.listWorkspaces(binding.operatorUserId);
      displayName = mine.find((w) => w.id === ws)?.name ?? displayName;
    } catch {
      return { action: "degraded", replyText: DEGRADED_TEXT };
    }
    const replyText = formatStatsReply(displayName, snapshot);
    await replyOnce(deps, linkCtx, replyText, "replied");
    return { action: "stats", replyText };
  }
  if (at.kind === "memory") {
    const slug = await deps.investigate?.workspaceSlug(ws).catch(() => null);
    if (!slug) return { action: "unavailable", replyText: INVESTIGATE_UNAVAILABLE_TEXT };
    const replyText =
      `Past fixes the team verified live in your Fix Cards library \u2014 open it here (staff sign-in):\n` +
      `/app/workspaces/${slug}/fix-cards\n` +
      `I can't list private customer history in chat, but anything verified is saved there.`;
    await replyOnce(deps, linkCtx, replyText, "replied");
    return { action: "at-memory", replyText };
  }
  await replyOnce(deps, linkCtx, AT_MENU_TEXT, "replied");
  return { action: "at-menu", replyText: AT_MENU_TEXT };
}

/**
 * S15C.1 conversational fallback for text no exact command matched.
 * Authorization runs BEFORE any intelligence read: revoked/non-staff
 * operators are denied with zero workspace data, exactly like the router
 * path. History, stats, and investigation reads are all scoped to the
 * binding's workspace; the model only ever phrases verified records and
 * its output is validated against the read-only allowlist. Read-only:
 * nothing here mutates, approves, publishes, or closes anything.
 */
async function handleConversational(
  deps: OperatorDeps,
  ctx: { inboundId: string; workspaceId: string | null; bindingId: string | null; threadId: string | null },
  binding: OperatorBinding,
  text: string,
): Promise<OperatorResult> {
  const converse = deps.converse;
  const reads = deps.investigate;
  if (!converse || !reads) {
    await replyOnce(deps, { ...ctx, workspaceId: binding.workspaceId }, USAGE_TEXT, "rejected");
    return { action: "usage", replyText: USAGE_TEXT };
  }
  try {
    await deps.checkStaff(binding.operatorUserId, binding.workspaceId);
  } catch {
    await replyOnce(deps, { ...ctx, workspaceId: binding.workspaceId }, DENIED_TEXT, "rejected");
    return { action: "denied", replyText: DENIED_TEXT };
  }
  const ws = binding.workspaceId;
  const linkCtx = { ...ctx, workspaceId: ws, bindingId: binding.id };
  const slug = await reads.workspaceSlug(ws).catch(() => null);
  if (!slug) return { action: "unavailable", replyText: INVESTIGATE_UNAVAILABLE_TEXT };
  let workspaceName = "your workspace";
  try {
    const mine = await deps.listWorkspaces(binding.operatorUserId);
    workspaceName = mine.find((w) => w.id === ws)?.name ?? workspaceName;
  } catch {
    // Display name is best-effort; the reply still sends.
  }
  // Bounded recent context scoped to this binding; failure degrades to
  // no-context rather than failing the turn.
  let history: ConverseTurn[] = [];
  try {
    history = await converse.loadHistory(ws, binding.id);
  } catch {
    history = [];
  }
  // Stats are best-effort here: status-family turns require them (the
  // converse layer degrades honestly without), detail turns do not.
  let stats: StatsSnapshot | null = null;
  try {
    stats = await deps.readStats(ws);
  } catch {
    stats = null;
  }
  try {
    const { runConversational } = await import("./converse");
    const { replyText } = await runConversational({
      text,
      history,
      workspaceId: ws,
      operatorUserId: binding.operatorUserId,
      workspaceName,
      slug,
      stats,
      reads,
      classify: converse.classify,
      phrase: converse.phrase,
    });
    await replyOnce(deps, linkCtx, replyText, "replied");
    return { action: "converse", replyText };
  } catch (e) {
    if (e instanceof Error && e.message === "photon send failed") throw e;
    return { action: "unavailable", replyText: INVESTIGATE_UNAVAILABLE_TEXT };
  }
}

type LinkCtx = { inboundId: string; workspaceId: string | null; bindingId: string | null; threadId: string | null };

async function showMe(
  deps: OperatorDeps,
  ctx: LinkCtx,
  ws: string,
  slug: string,
  reads: import("./investigate").InvestigateReads,
  operatorUserId: string,
): Promise<OperatorResult> {
  const inv = await import("./investigate");
  const alerts = await reads.recentRadarAlerts(ws, operatorUserId);
  if (alerts.length === 0) {
    const replyText = "No Radar alert in the last 24 hours for this workspace. Reply `alerts` to see reviewable candidates.";
    await replyOnce(deps, ctx, replyText, "replied");
    return { action: "show", replyText };
  }
  const seen = new Set<string>();
  const live: { candidateId: string }[] = [];
  for (const a of alerts) {
    if (seen.has(a.candidateId)) continue;
    seen.add(a.candidateId);
    const c = await reads.getCandidate(a.candidateId, ws).catch(() => null);
    if (c) live.push({ candidateId: a.candidateId });
  }
  if (live.length === 0) {
    const replyText = "Your recent alert's candidate is no longer available. Reply `alerts` to see reviewable candidates.";
    await replyOnce(deps, ctx, replyText, "replied");
    return { action: "show", replyText };
  }
  if (live.length > 1) {
    const options: { kind: "candidate" | "incident"; id: string; title: string }[] = [];
    for (const l of live.slice(0, 5)) {
      const c = await reads.getCandidate(l.candidateId, ws).catch(() => null);
      if (c) options.push({ kind: "candidate", id: c.id, title: c.title });
    }
    const replyText = inv.ambiguousReply("your recent alerts", options);
    await replyOnce(deps, ctx, replyText, "replied");
    return { action: "clarify", replyText };
  }
  const c = await reads.getCandidate(live[0].candidateId, ws);
  if (!c) {
    const replyText = "Your recent alert's candidate is no longer available. Reply `alerts` to see reviewable candidates.";
    await replyOnce(deps, ctx, replyText, "replied");
    return { action: "show", replyText };
  }
  if (c.status === "accepted" && c.acceptedIncidentId) {
    const replyText = [
      `That alert was accepted \u2014 now incident: ${c.title.slice(0, 100)}`,
      `Open: ${inv.incidentLink(slug, c.acceptedIncidentId)}`,
    ].join("\n");
    await replyOnce(deps, ctx, replyText, "replied");
    return { action: "show", replyText };
  }
  if (c.status === "dismissed") {
    const replyText = [
      `That alert was dismissed by staff review \u2014 no incident was opened.`,
      `Candidates: ${inv.candidateLink(slug, c.id)}`,
    ].join("\n");
    await replyOnce(deps, ctx, replyText, "replied");
    return { action: "show", replyText };
  }
  const replyText = inv.candidateSummaryReply(slug, c, true);
  await replyOnce(deps, ctx, replyText, "replied");
  return { action: "show", replyText };
}

async function resolveForRef(
  reads: import("./investigate").InvestigateReads,
  ws: string,
  ref: string,
): Promise<import("./investigate").RefTarget> {
  const inv = await import("./investigate");
  if (/^[0-9a-f-]{36}$/i.test(ref.trim())) {
    const [c, i] = await Promise.all([
      reads.getCandidate(ref.trim(), ws).catch(() => null),
      reads.getIncident(ref.trim(), ws).catch(() => null),
    ]);
    if (c) return { kind: "candidate", id: c.id, title: c.title };
    if (i) return { kind: "incident", id: i.id, title: i.title };
    return { kind: "unknown" };
  }
  const [cands, incs] = await Promise.all([reads.listReviewCandidates(ws), reads.listActiveIncidents(ws)]);
  return inv.resolveReference(
    ref,
    cands.map((c) => ({ id: c.id, title: c.title })),
    incs.map((i) => ({ id: i.id, title: i.title })),
  );
}

async function investigateRef(
  deps: OperatorDeps,
  ctx: LinkCtx,
  ws: string,
  slug: string,
  reads: import("./investigate").InvestigateReads,
  ref: string,
): Promise<OperatorResult> {
  const inv = await import("./investigate");
  const target = await resolveForRef(reads, ws, ref);
  if (target.kind === "unknown") {
    const replyText = inv.unknownRefReply(ref);
    await replyOnce(deps, ctx, replyText, "replied");
    return { action: "clarify", replyText };
  }
  if (target.kind === "ambiguous") {
    const replyText = inv.ambiguousReply(ref, target.options);
    await replyOnce(deps, ctx, replyText, "replied");
    return { action: "clarify", replyText };
  }
  if (target.kind === "candidate") {
    const c = await reads.getCandidate(target.id, ws).catch(() => null);
    if (!c) {
      const replyText = inv.unknownRefReply(ref);
      await replyOnce(deps, ctx, replyText, "replied");
      return { action: "clarify", replyText };
    }
    if (c.status === "accepted" && c.acceptedIncidentId) {
      const replyText = [
        `Candidate accepted \u2014 now incident: ${c.title.slice(0, 100)}`,
        `Open: ${inv.incidentLink(slug, c.acceptedIncidentId)}`,
      ].join("\n");
      await replyOnce(deps, ctx, replyText, "replied");
      return { action: "investigate", replyText };
    }
    if (c.status === "dismissed") {
      const replyText = `Candidate dismissed by staff review \u2014 no incident was opened.`;
      await replyOnce(deps, ctx, replyText, "replied");
      return { action: "investigate", replyText };
    }
    const replyText = inv.candidateSummaryReply(slug, c, false);
    await replyOnce(deps, ctx, replyText, "replied");
    return { action: "investigate", replyText };
  }
  const i = await reads.getIncident(target.id, ws).catch(() => null);
  if (!i) {
    const replyText = inv.unknownRefReply(ref);
    await replyOnce(deps, ctx, replyText, "replied");
    return { action: "clarify", replyText };
  }
  const [brief, matches] = await Promise.all([
    reads.getBrief(i.id, ws).catch(() => null),
    reads.getMatches(i.id, ws).catch(() => ({ current: false, fingerprint: null as string | null, rows: [] })),
  ]);
  const replyText = inv.incidentSummaryReply(slug, i, brief, matches.rows.length);
  await replyOnce(deps, ctx, replyText, "replied");
  return { action: "investigate", replyText };
}

async function evidenceRef(
  deps: OperatorDeps,
  ctx: LinkCtx,
  ws: string,
  slug: string,
  reads: import("./investigate").InvestigateReads,
  ref: string,
): Promise<OperatorResult> {
  const inv = await import("./investigate");
  const target = await resolveForRef(reads, ws, ref);
  if (target.kind !== "incident") {
    const replyText =
      target.kind === "ambiguous"
        ? inv.ambiguousReply(ref, target.options)
        : `Evidence briefs cover confirmed incidents \u2014 "${ref.slice(0, 32)}" is ${target.kind === "candidate" ? "a candidate (UNCONFIRMED)" : "unknown here"}. Reply \`investigate ${ref.slice(0, 32)}\` for the candidate, or use an incident reference.`;
    await replyOnce(deps, ctx, replyText, "replied");
    return { action: "clarify", replyText };
  }
  const [i, brief] = await Promise.all([
    reads.getIncident(target.id, ws).catch(() => null),
    reads.getBrief(target.id, ws).catch(() => null),
  ]);
  if (!i) {
    const replyText = inv.unknownRefReply(ref);
    await replyOnce(deps, ctx, replyText, "replied");
    return { action: "clarify", replyText };
  }
  const replyText = inv.evidenceReply(slug, i.id, i.title, brief);
  await replyOnce(deps, ctx, replyText, "replied");
  return { action: "evidence", replyText };
}

async function matchesRef(
  deps: OperatorDeps,
  ctx: LinkCtx,
  ws: string,
  slug: string,
  reads: import("./investigate").InvestigateReads,
  ref: string,
): Promise<OperatorResult> {
  const inv = await import("./investigate");
  const target = await resolveForRef(reads, ws, ref);
  if (target.kind !== "incident") {
    const replyText =
      target.kind === "ambiguous"
        ? inv.ambiguousReply(ref, target.options)
        : `Historical matches attach to confirmed incidents \u2014 "${ref.slice(0, 32)}" is ${target.kind === "candidate" ? "a candidate (UNCONFIRMED)" : "unknown here"}. Reply \`investigate ${ref.slice(0, 32)}\` for the candidate, or use an incident reference.`;
    await replyOnce(deps, ctx, replyText, "replied");
    return { action: "clarify", replyText };
  }
  const [i, m] = await Promise.all([
    reads.getIncident(target.id, ws).catch(() => null),
    reads.getMatches(target.id, ws).catch(() => ({ current: false, fingerprint: null as string | null, rows: [] as never[] })),
  ]);
  if (!i) {
    const replyText = inv.unknownRefReply(ref);
    await replyOnce(deps, ctx, replyText, "replied");
    return { action: "clarify", replyText };
  }
  const rows = m.rows ?? [];
  const replyText = inv.matchesReply(slug, i.id, i.title, m.current, m.fingerprint, rows);
  await replyOnce(deps, ctx, replyText, "replied");
  return { action: "matches", replyText };
}
