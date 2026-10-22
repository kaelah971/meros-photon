import "server-only";

// S15C.1 conversational Muse — natural-language understanding over the
// read-only S15C investigation surface.
//
// Safety contract (mirrors investigate.ts):
// - Deterministic command parsing ALWAYS runs first (operator.ts). This
//   module only handles text no exact command matched.
// - Model output is UNTRUSTED: it maps through a validated allowlist of
//   read-only intents. Model-generated IDs never touch the database —
//   references resolve only against bounded workspace-scoped record lists
//   via resolveReference/inferSelectedRef (exact UUID or unique prefix).
// - Every number, status, and fact comes from persisted records. Gemini may
//   phrase and explain, but never invent. Stale/missing/uncertain evidence
//   is labeled, never smoothed over.
// - Read-only: this module cannot approve, publish, execute, close, or
//   change anything. Action requests get console guidance + a link.
// - Bounded: capped history turns, truncated facts, wall-clock ceilings on
//   every model call, deterministic fallback on any model failure.

import type { InvestigateReads } from "./investigate";
import { candidateLink, formatMessageBody, incidentLink, publicLink, truncateClean } from "./investigate";
import type { StatsSnapshot } from "./operator";

export const CONVERSE_NORMAL_MAX = 500;
export const CONVERSE_DETAILED_MAX = 1500;
const CLASSIFY_TIMEOUT_MS = 9_000;
const PHRASE_TIMEOUT_MS = 25_000;
const MAX_HISTORY_TURNS = 10;
const MAX_TURN_CHARS = 300;

export type ConverseKind =
  | "greeting"
  | "status"
  | "worry"
  | "attention"
  | "latest"
  | "why_related"
  | "sofar"
  | "seen_before"
  | "next_steps"
  | "explain"
  | "other"
  | "action_request"
  | "unknown";

export const CONVERSE_KINDS: readonly ConverseKind[] = [
  "greeting",
  "status",
  "worry",
  "attention",
  "latest",
  "why_related",
  "sofar",
  "seen_before",
  "next_steps",
  "explain",
  "other",
  "action_request",
  "unknown",
];

const DETAILED_KINDS: ReadonlySet<ConverseKind> = new Set([
  "why_related",
  "sofar",
  "seen_before",
]);

export type ConversePlan = {
  kind: ConverseKind;
  /** Raw user-typed reference hint (prefix or UUID). Never trusted as an ID. */
  refHint: string | null;
  /** Short topic for action_request (what was asked). Truncated, never executed. */
  topic: string | null;
};

export type ConverseTurn = { role: "user" | "assistant"; text: string };

export type PhraseInput = {
  text: string;
  history: ConverseTurn[];
  facts: string;
  kind: ConverseKind;
  detailed: boolean;
};

export function capFor(kind: ConverseKind): number {
  return DETAILED_KINDS.has(kind) ? CONVERSE_DETAILED_MAX : CONVERSE_NORMAL_MAX;
}

/** Strict allowlist validation for model output. Pure — unit-testable. */
export function validateConversePlan(raw: unknown): ConversePlan | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.kind !== "string" || !(CONVERSE_KINDS as readonly string[]).includes(r.kind)) return null;
  let refHint: string | null = null;
  if (typeof r.refHint === "string" && /^[A-Za-z0-9-]{1,64}$/.test(r.refHint.trim())) {
    refHint = r.refHint.trim();
  }
  let topic: string | null = null;
  if (typeof r.topic === "string" && r.topic.trim()) {
    topic = r.topic.replace(/\s+/g, " ").trim().slice(0, 120);
  }
  return { kind: r.kind as ConverseKind, refHint, topic };
}

export function unknownPlan(): ConversePlan {
  return { kind: "unknown", refHint: null, topic: null };
}

// ---- Deterministic fast paths (no model needed for the core phrases) ----

const RE = {
  action:
    /\b(approv\w*|publish\w*|send\b.{0,30}\b(update|message|customers?|follow-?up)|execut\w*|run (the |this )?fix|deploy\w*|fix it|fix this|change (my |the )?(preference|setting|notification)|accept (the |this )?candidate|dismiss (the |this )?(candidate|alert)|close (the |this )?incident|resolv\w* (the |this )?(incident|issue)|update (the )?card|edit (the )?card|unpair|revoke|pair me)\b/i,
  whyRelated:
    /\bwhy\b.{0,40}\b(related|grouped|together|same (issue|candidate|cluster))\b|\bwhy\b.{0,20}\bthose\b.{0,20}\breports?\b/i,
  seenBefore:
    /\b(seen|happened) (this |that )?before\b|\bhave we seen\b|\bis this new\b|\bhappened before\b|\bhistory of this\b|\bseen (it|that) before\b/i,
  sofar:
    /\bwhat do we know\b|\bwhat.*\bso far\b|\b(know|summary|status) (so far|of (this|that|the))\b|\bbring me up to (date|speed)\b|\brecap\b/i,
  nextSteps:
    /\bwhat should we do\b|\bwhat('s| is) next\b|\bnext steps?\b|\bwhat do you (suggest|recommend)\b|\bhow (should|do) (we|i) (handle|proceed|fix)\b|\bwhat now\b/i,
  latest:
    /\blatest\b|\bmost recent\b|\bnewest\b/i,
  worry:
    /\bworry\b|\bworried\b|\banything wrong\b|\ball (good|quiet|ok|okay|calm)\b|\bshould i be\b/i,
  attention:
    /\battention\b|\bneeds?\b.{0,20}\b(review|work|triage)\b|\btodo\b|\boutstanding\b|\bwaiting (on|for) (me|review|us)\b/i,
  problems:
    /\bcustomers?\b.{0,30}\b(reporting|having|seeing|experiencing|hitting)\b|\bany\b.{0,20}\b(problems|issues|complaints|reports)\b|\bwhat('s| is) (happening|going on|broken)\b|\bhappening today\b|\bhow('s| is) (it|things|everything)\b/i,
  other:
    /\bother (incident|candidate|one|issue)\b|\bsecond one\b|\bthe other\b/i,
  more: /\btell me more\b|\bmore (detail|details|info|context)\b|\bgo on\b|\bwhat happened next\b|\band then\b/i,
  explain:
    /\bexplain\b|\bwhat does that mean\b|\bi don'?t (understand|get it)\b|\bwhat do you mean\b|\bsay that (again|differently)\b/i,
  bareWhy: /^\s*why\??\s*$/i,
  bareHuh: /^\s*(huh|what)\??\s*$/i,
  greeting:
    /^\s*(hey|hi|hello|hey there|hello there|yo|howdy|good ?(morning|afternoon|evening))(\s+meros)?[!.?]*\s*$/i,
  customerDetail: /\bthat customer\b|\bthe customer\b|\bwhich customer\b/i,
};

function hasRefToken(text: string): boolean {
  return /[0-9a-f]{8}(?:-[0-9a-f]{4}){0,4}/i.test(text);
}

/**
 * Deterministic intent fast path. Returns a plan, or null when the text
 * needs model classification. Pure — unit-testable. Never matches exact
 * S1/S15C commands (those run before this module is consulted).
 */
export function fastClassify(text: string): ConversePlan | null {
  const t = text.trim();
  if (!t) return { kind: "greeting", refHint: null, topic: null };
  if (RE.action.test(t)) return { kind: "action_request", refHint: null, topic: t.slice(0, 120) };
  if (RE.whyRelated.test(t)) return { kind: "why_related", refHint: null, topic: null };
  if (RE.seenBefore.test(t)) return { kind: "seen_before", refHint: null, topic: null };
  if (RE.sofar.test(t)) return { kind: "sofar", refHint: null, topic: null };
  if (RE.nextSteps.test(t)) return { kind: "next_steps", refHint: null, topic: null };
  if (RE.latest.test(t)) return { kind: "latest", refHint: null, topic: null };
  if (RE.worry.test(t)) return { kind: "worry", refHint: null, topic: null };
  if (RE.attention.test(t)) return { kind: "attention", refHint: null, topic: null };
  if (RE.problems.test(t)) return { kind: "status", refHint: null, topic: null };
  if (RE.other.test(t)) return { kind: "other", refHint: null, topic: null };
  if (RE.more.test(t) || RE.customerDetail.test(t)) return { kind: "sofar", refHint: null, topic: null };
  if (RE.explain.test(t) || RE.bareWhy.test(t) || RE.bareHuh.test(t)) {
    return { kind: "explain", refHint: null, topic: null };
  }
  if (RE.greeting.test(t)) return { kind: "greeting", refHint: null, topic: null };
  if (hasRefToken(t)) return { kind: "sofar", refHint: null, topic: null };
  return null;
}

// ---- Conversation context (validated history only, no new storage) ----

export type LiveOption = { kind: "candidate" | "incident"; id: string; title: string };

const REF_TOKEN_RE = /[0-9a-f]{8}(?:-[0-9a-f]{4}){0,4}/gi;

/**
 * Track the selected incident/candidate from previous VALIDATED conversation
 * context: scan assistant (bot-authored) turns newest-first for reference
 * tokens that match actual workspace-authorized records. Anything that does
 * not match a live record is ignored — never guessed.
 */
export function inferSelectedRef(
  history: ConverseTurn[],
  candidates: LiveOption[],
  incidents: LiveOption[],
): LiveOption | null {
  const all = [...incidents, ...candidates];
  if (all.length === 0) return null;
  const byId = new Map(all.map((o) => [o.id.toLowerCase(), o]));
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (h.role !== "assistant") continue;
    const toks = h.text.match(REF_TOKEN_RE) ?? [];
    toks.sort((a, b) => b.length - a.length);
    for (const tok of toks) {
      const low = tok.toLowerCase();
      const exact = byId.get(low);
      if (exact) return exact;
      const prefixed = all.filter((o) => o.id.toLowerCase().startsWith(low));
      if (prefixed.length === 1) return prefixed[0];
    }
  }
  return null;
}

/** Last bot-authored turn, for explain-style follow-ups. */
export function lastAssistantTurn(history: ConverseTurn[]): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "assistant" && history[i].text.trim()) return history[i].text;
  }
  return null;
}

export function boundHistory(history: ConverseTurn[]): ConverseTurn[] {
  return history
    .slice(-MAX_HISTORY_TURNS)
    .map((h) => ({
      role: h.role === "assistant" ? ("assistant" as const) : ("user" as const),
      text: h.text.replace(/\s+/g, " ").trim().slice(0, MAX_TURN_CHARS),
    }))
    .filter((h) => h.text.length > 0);
}

// ---- Model-backed classification (bounded, validated, never throws) ----

const CLASSIFY_SYSTEM = `You route an operator's iMessage to Meros support telemetry. The operator speaks naturally; map their message to ONE read-only intent.

Return JSON with EXACTLY these keys: {"kind": string, "refHint": string|null, "topic": string|null}

kind must be exactly one of:
- "greeting" — hello / hey / small talk with no question
- "status" — what's happening today, any customer problems, general pulse
- "worry" — anything to worry about, is everything ok
- "attention" — what needs review, outstanding work, todo
- "latest" — the latest / most recent incident or alert
- "why_related" — why reports were grouped together
- "sofar" — what do we know, recap, tell me more, what happened, per-customer detail
- "seen_before" — have we seen this before, is this new, history
- "next_steps" — what should we do, what now, recommendations
- "explain" — explain that, what do you mean, why (bare), huh
- "other" — what about the other incident / the second one
- "action_request" — approve, publish or send customer messages, execute fixes, change preferences, accept/dismiss/close anything, change pairing
- "unknown" — anything else

Rules:
- refHint: copy a reference token ONLY if the operator typed an explicit id or #short-ref. Otherwise null. Never invent ids. Follow-ups like "that one" get null (context resolves them).
- topic: for "action_request" only — a few words on what was asked (e.g. "approve recovery"). Otherwise null.
- A request to DO something (approve, send, fix, close, change) is ALWAYS "action_request", even if phrased politely.
- Output JSON only, no prose. Keep topic under 20 words.`;

/** Production classifier: fast path first, then one bounded Gemini JSON call. Never throws. */
export async function defaultClassify(text: string, history: ConverseTurn[]): Promise<ConversePlan> {
  const fast = fastClassify(text);
  if (fast) return fast;
  try {
    const { isGeminiConfigured } = await import("../env");
    if (!isGeminiConfigured()) return unknownPlan();
    const { generateJson } = await import("../gemini");
    const { settleWithTimeout } = await import("../retry");
    const ctx = boundHistory(history)
      .slice(-6)
      .map((h) => `${h.role.toUpperCase()}: ${h.text}`)
      .join("\n");
    const userText = [
      ctx ? `RECENT OPERATOR CHAT (operator-authored, for context only):\n${ctx}` : `RECENT OPERATOR CHAT: (none)`,
      ``,
      `CURRENT MESSAGE: "${text.replace(/\s+/g, " ").trim().slice(0, 500)}"`,
    ].join("\n");
    const settled = await settleWithTimeout(
      generateJson({ systemInstruction: CLASSIFY_SYSTEM, userText }),
      CLASSIFY_TIMEOUT_MS,
    );
    if (settled.status !== "ok") return unknownPlan();
    return validateConversePlan(settled.value) ?? unknownPlan();
  } catch {
    return unknownPlan();
  }
}

// ---- Model-backed phrasing (grounded, bounded, throws so caller falls back) ----

const PHRASE_SYSTEM = `You are Meros, a warm, capable support teammate texting an operator on iMessage. Warm, conversational, observant, clear, concise, context-aware, calm under pressure.

You receive FACTS verified from the workspace database plus the operator's question. Rules:
- Use ONLY the facts given. Never invent numbers, statuses, customer counts, causes, fixes, or outcomes. If FACTS say evidence is stale/missing/uncertain, say so plainly (e.g. "that brief is stale", "no past cases stored").
- Keep it iMessage-sized: short paragraphs, plain words, no JSON, no robotic command menus, no corporate chatbot language. No fake urgency, no unsupported reassurance ("all fixed!" is forbidden unless FACTS say resolved).
- When a SHORT REF like #a1b2c3d4 is given, include it so follow-ups work.
- Do NOT invent links or URLs — a console link is appended separately when relevant.
- Answer the question directly, add one line on why it matters when useful, and at most ONE useful next step. A compound question (what happened + what is unknown + what next) must answer every part — use the labeled KNOWN / UNKNOWN / NEXT STEPS facts when given. When NEXT STEPS facts are given, always end with that recommended next step. Do not end every reply with a question.
- An action the operator asked to perform (approve, send, fix, close, change) was NOT performed: explain briefly it needs the staff console.
- Shape every reply the same way: direct answer first, then relevant context on its own paragraph (one blank line between paragraphs), then at most ONE useful next step. Short sentences, everyday words.
- Operator-friendly words: say "possible recurring problem" not "candidate", "things needing review" not "pending decisions", "your team inbox" not "workspace", "looks like" not "inferred". Still quote exact stored states (investigating, pending) verbatim when giving them.
- Never claim everything is running smoothly, all problems are fixed, every customer is happy, or that silence means the product is healthy. Never promise future automatic alerts unless FACTS confirm a recent Radar alert. Keep verified, suspected, unknown, stale, and historical evidence distinct.
- If FACTS say the workspace is empty, say so warmly: no active incidents, no customer reports to investigate yet. Never imply analysis ran on records that do not exist. Never mention Radar unless FACTS mention a Radar alert.`;

export async function defaultPhrase(input: PhraseInput): Promise<string> {
  const { generateSupportAnswer } = await import("../gemini");
  const { settleWithTimeout } = await import("../retry");
  const cap = input.detailed ? CONVERSE_DETAILED_MAX : CONVERSE_NORMAL_MAX;
  const history = boundHistory(input.history).slice(-4).map((h) => ({ role: h.role, text: h.text }));
  const message = [
    `FACTS (verified, complete — do not add or infer beyond these):`,
    input.facts.slice(0, 2200),
    ``,
    `OPERATOR ASKED: "${input.text.replace(/\s+/g, " ").trim().slice(0, 500)}"`,
    ``,
    `Reply in ${cap} characters or fewer.`,
  ].join("\n");
  const settled = await settleWithTimeout(
    (async () => {
      // Caller ceiling: aborting here cancels the SDK chain instead of
      // abandoning it to burn quota in the background past our bound.
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), PHRASE_TIMEOUT_MS);
      try {
        return await generateSupportAnswer({ systemInstruction: PHRASE_SYSTEM, history, message, signal: ctrl.signal });
      } finally {
        clearTimeout(timer);
        ctrl.abort();
      }
    })(),
    PHRASE_TIMEOUT_MS,
  );
  if (settled.status === "timeout") throw new Error("converse phrase timed out");
  if (settled.status !== "ok") throw settled.error;
  const out = settled.value.trim();
  if (!out) throw new Error("converse phrase empty");
  return out;
}

// ---- Grounded context gathering (read-only, workspace-scoped) ----

export type SelectedDetail = {
  option: LiveOption;
  shortRef: string;
  detail: string;
  stale: boolean;
  /** Evidence state behind the detail; drives grounded next-step hints. */
  briefState?: "missing" | "stale" | "current" | "pending" | "failed";
  /** Precomputed read-only next step; present when evidence supports one. */
  nextStep?: string;
};

export type ConverseContext = {
  workspaceName: string;
  empty: boolean;
  stats: StatsSnapshot | null;
  incidents: { id: string; title: string; status: string; severity: string; customers: number; conversations: number }[];
  candidates: { id: string; title: string; status: string; conversations: number; customers: number }[];
  decisions: string[];
  radarCandidateId: string | null;
  selected: SelectedDetail | null;
  ambiguous: LiveOption[] | null;
  lastAssistant: string | null;
};

function short(id: string): string {
  return id.slice(0, 8);
}

/** Fit a conversational reply to its cap. Paragraph breaks survive; the appended console link is absolute and never split. */
export function fitConverse(body: string, link: string | null, detailed: boolean): string {
  const cap = detailed ? CONVERSE_DETAILED_MAX : CONVERSE_NORMAL_MAX;
  const clean = formatMessageBody(body) || "Here's what I found.";
  const fullLink = link ? publicLink(link) : null;
  const full = fullLink ? `${clean}\n\n${fullLink}` : clean;
  if (full.length <= cap) return full;
  if (!fullLink) return truncateClean(clean, cap);
  const keep = Math.max(0, cap - fullLink.length - 2);
  return `${truncateClean(clean, keep, false)}\n\n${fullLink}`;
}

function statsLine(workspaceName: string, s: StatsSnapshot): string {
  return (
    `${workspaceName}, all time: ${s.conversations} conversations, ${s.customers} customers, ` +
    `${s.openIssues} open issues, ${s.pendingFixCards} Fix Cards awaiting review, ${s.sharedFixes} shared fixes.`
  );
}

/**
 * Gather grounded context for one conversational turn. Throws only when the
 * reads needed for this kind are unreachable (caller degrades honestly
 * without sending a fabricated reply).
 */
export async function gatherContext(input: {
  plan: ConversePlan;
  text: string;
  history: ConverseTurn[];
  workspaceId: string;
  operatorUserId: string;
  workspaceName: string;
  slug: string;
  stats: StatsSnapshot | null;
  reads: InvestigateReads;
}): Promise<ConverseContext> {
  const { plan, text, history, workspaceId, operatorUserId, reads } = input;
  const needsLists =
    plan.kind !== "greeting" && plan.kind !== "action_request" && plan.kind !== "explain";
  const needsStats = plan.kind === "status" || plan.kind === "worry" || plan.kind === "attention";

  const stats = input.stats;
  if (needsStats && !stats) {
    throw new Error("workspace state unreachable");
  }

  let incidents: ConverseContext["incidents"] = [];
  let candidates: ConverseContext["candidates"] = [];
  let decisions: string[] = [];
  let radarCandidateId: string | null = null;
  let radarOptions: LiveOption[] = [];
  if (needsLists) {
    const [incs, cands] = await Promise.all([
      reads.listActiveIncidents(workspaceId),
      reads.listReviewCandidates(workspaceId),
    ]);
    incidents = incs.slice(0, 5).map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      severity: r.severity,
      customers: r.customers,
      conversations: r.conversations,
    }));
    candidates = cands
      .filter((c) => c.status === "pending")
      .slice(0, 5)
      .map((c) => ({ id: c.id, title: c.title, status: c.status, conversations: c.conversations, customers: c.customers }));
    if (plan.kind === "worry" || plan.kind === "attention" || plan.kind === "next_steps") {
      const items = await reads.listDecisions(workspaceId);
      decisions = items.slice(0, 5).map((d) => d.label);
    }
    if (plan.kind === "latest") {
      // Prefer the operator's live Radar alert when one exists — the same
      // validated source as deterministic `show me`. Never claim Radar
      // otherwise (factsText stays silent when there is no alert).
      const alerts = await reads.recentRadarAlerts(workspaceId, operatorUserId).catch(() => []);
      const liveIds = new Set([
        ...incidents.map((i) => i.id),
        ...candidates.map((c) => c.id),
      ]);
      const liveAlerts = alerts.filter((a) => liveIds.has(a.candidateId));
      if (liveAlerts.length >= 1) {
        radarCandidateId = liveAlerts[0].candidateId;
      }
      if (liveAlerts.length > 1) {
        // Several live alerts: do not pick — the clarification path lists them.
        const byId = new Map(candidates.map((c) => [c.id, c]));
        for (const a of liveAlerts.slice(0, 5)) {
          const c = byId.get(a.candidateId);
          if (c) radarOptions.push({ kind: "candidate", id: c.id, title: c.title });
        }
      }
    }
  }

  const liveIncs: LiveOption[] = incidents.map((i) => ({ kind: "incident", id: i.id, title: i.title }));
  const liveCands: LiveOption[] = candidates.map((c) => ({ kind: "candidate", id: c.id, title: c.title }));
  const live: LiveOption[] = [...liveIncs, ...liveCands];
  const empty =
    (!stats || (stats.openIssues === 0 && stats.conversations === 0 && stats.customers === 0)) &&
    incidents.length === 0 &&
    candidates.length === 0;

  // Explicit reference in the current message wins over history context.
  let selected: LiveOption | null = null;
  let ambiguous: LiveOption[] | null = null;
  const hintTokens = (plan.refHint ? [plan.refHint] : []).concat(text.match(REF_TOKEN_RE) ?? []);
  if (hintTokens.length > 0 && live.length > 0) {
    const { resolveReference } = await import("./investigate");
    const cands = liveCands.map((c) => ({ id: c.id, title: c.title }));
    const incs = liveIncs.map((i) => ({ id: i.id, title: i.title }));
    for (const tok of hintTokens) {
      const target = resolveReference(tok, cands, incs);
      if (target.kind === "ambiguous") {
        ambiguous = target.options;
        break;
      }
      if (target.kind === "candidate" || target.kind === "incident") {
        selected = target;
        break;
      }
    }
  }
  if (!selected && !ambiguous && live.length > 0) {
    const contextKinds: ReadonlySet<ConverseKind> = new Set([
      "why_related",
      "sofar",
      "seen_before",
      "next_steps",
      "explain",
    ]);
    if (contextKinds.has(plan.kind)) {
      selected = inferSelectedRef(history, liveCands, liveIncs);
    }
  }

  // latest with a live Radar alert and no explicit reference: the alert is
  // the answer (single) or a clarification (several) — never a guess.
  if (plan.kind === "latest" && radarCandidateId && !selected && !ambiguous) {
    if (radarOptions.length > 1) {
      ambiguous = radarOptions;
    } else {
      const match = candidates.find((c) => c.id === radarCandidateId);
      if (match) {
        selected = { kind: "candidate", id: match.id, title: match.title };
      }
    }
  }

  // "the other one" = the most prominent option that is NOT the selected one.
  if (plan.kind === "other" && live.length > 0) {
    const current = selected ?? inferSelectedRef(history, liveCands, liveIncs);
    const rest = live.filter((o) => (current ? o.id !== current.id : true));
    if (current && rest.length === 0) {
      selected = current;
    } else if (current && rest.length >= 1 && live.length === 2) {
      selected = rest[0];
    } else if (!current && live.length === 1) {
      selected = live[0];
    } else {
      ambiguous = (current ? rest : live).slice(0, 5);
      selected = null;
    }
  }

  // Detail for the selected record (brief/matches read lazily per kind).
  let detail: SelectedDetail | null = null;
  if (selected && !ambiguous) {
    detail = await loadSelectedDetail(reads, workspaceId, selected, plan.kind);
  }

  return {
    workspaceName: input.workspaceName,
    empty,
    stats,
    incidents,
    candidates,
    decisions,
    radarCandidateId,
    selected: detail,
    ambiguous,
    lastAssistant: lastAssistantTurn(history),
  };
}

/**
 * Collapse near-duplicate complaint quotes into distinct findings.
 * Raw observations are overlapping customer quotes; joining them raw
 * produces repeated run-on fragments. Normalized containment drops
 * restatements while keeping genuinely different details, in order.
 */
function distinctObservations(facts: { observation: string }[], max: number): string[] {
  const out: string[] = [];
  const seen: string[] = [];
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  for (const f of facts) {
    const clean = f.observation.replace(/\s+/g, " ").trim();
    if (!clean) continue;
    const n = norm(clean);
    if (!n || seen.some((s) => s.includes(n) || n.includes(s))) continue;
    seen.push(n);
    out.push(/[.!?]$/.test(clean) ? clean : `${clean}.`);
    if (out.length >= max) break;
  }
  return out;
}

type BriefState = "missing" | "stale" | "current" | "pending" | "failed";

/**
 * One grounded, read-only next step derived from evidence state — never
 * invented causes, fixes, or executions. Everything that changes state
 * goes through the staff console.
 */
function suggestNextStep(briefState: BriefState, hasUnknowns: boolean): string {
  if (briefState === "missing" || briefState === "pending" || briefState === "failed") {
    return "Link the latest customer report so the evidence brief assembles, then review it in the staff console.";
  }
  if (briefState === "stale") {
    return "The evidence moved on — open the incident in the staff console to review the fresh reports.";
  }
  if (hasUnknowns) {
    return "Dig into the open question in the linked reports, then review the incident in the staff console.";
  }
  return "Open the incident in the staff console to review the linked reports and decide the next move.";
}

async function loadSelectedDetail(
  reads: InvestigateReads,
  workspaceId: string,
  option: LiveOption,
  kind: ConverseKind,
): Promise<SelectedDetail> {
  const ref = short(option.id);
  if (option.kind === "candidate") {
    const c = await reads.getCandidate(option.id, workspaceId).catch(() => null);
    if (!c) return { option, shortRef: ref, detail: "", stale: false };
    const detail = [
      `Candidate (UNCONFIRMED): ${c.title}.`,
      `${c.conversations} conversations, ${c.customers} customers.`,
      c.summary ? `Why grouped: ${c.summary.slice(0, 200)}` : "",
      `Grouping confidence: ${c.confidence} (estimate only).`,
    ]
      .filter(Boolean)
      .join(" ");
    return { option, shortRef: ref, detail, stale: false };
  }
  const [inc, brief, matches] = await Promise.all([
    reads.getIncident(option.id, workspaceId).catch(() => null),
    kind === "sofar" || kind === "why_related" ? reads.getBrief(option.id, workspaceId).catch(() => null) : Promise.resolve(null),
    kind === "seen_before" ? reads.getMatches(option.id, workspaceId).catch(() => null) : Promise.resolve(null),
  ]);
  if (!inc) return { option, shortRef: ref, detail: "", stale: false };
  const briefState: BriefState = !brief ? "missing" : brief.status === "current" ? "current" : (brief.status as BriefState);
  const parts = [
    `Incident: ${inc.title} [${inc.status}, ${inc.severity}].`,
    `Affects ${inc.customers} customers across ${inc.conversations} conversations.`,
  ];
  let stale = false;
  if ((kind === "sofar" || kind === "why_related") && brief) {
    if (brief.status !== "current") {
      stale = true;
      parts.push(`Evidence brief is ${brief.status} (v${brief.version}) — not current, treat findings as outdated.`);
    } else {
      const known = distinctObservations(brief.facts.map((f) => ({ observation: f.observation })), 3);
      if (known.length > 0) parts.push(`What we know: ${known.join(" ")}`);
      if (brief.unknowns.length > 0) parts.push(`Still unknown: ${brief.unknowns.slice(0, 2).join("; ")}.`);
      if (brief.contradictions.length > 0) {
        parts.push(`Conflicting evidence: ${brief.contradictions.slice(0, 2).join("; ")}.`);
      }
    }
  }
  const nextStep = suggestNextStep(briefState, (brief?.unknowns.length ?? 0) > 0);
  if (kind === "sofar" || kind === "why_related") {
    parts.push(`Suggested next step (read-only — anything that changes state needs the staff console): ${nextStep}`);
  }
  if (kind === "seen_before" && matches) {
    if (!matches.current) {
      stale = true;
      parts.push("Stored historical matches look stale — recompute before relying on them.");
    }
    const rows = matches.rows ?? [];
    if (rows.length === 0) {
      parts.push("No historical matches stored. Absence of matches is not proof of novelty.");
    } else {
      const top = rows[0];
      parts.push(
        `One past case: fix ${top.refId.slice(0, 8)} [${top.tier === "verified_fix" ? "VERIFIED HISTORICAL FIX" : top.tier === "documented_unverified" ? "DOCUMENTED BUT UNVERIFIED" : "POSSIBLE MATCH"}]. Past success does not prove today's cause.`,
      );
    }
  }
  return { option, shortRef: ref, detail: parts.join(" "), stale, briefState, nextStep };
}

// ---- Facts text for the phrasing model (bounded, verified only) ----

export function factsText(ctx: ConverseContext, plan: ConversePlan, slug: string): string {
  void slug;
  const lines: string[] = [`WORKSPACE: ${ctx.workspaceName}`];
  if (ctx.empty) {
    lines.push(
      "EMPTY WORKSPACE: zero conversations, zero active incidents, zero pending candidates. There is nothing to analyze. Do not invent incidents, numbers, or Radar alerts.",
    );
    return lines.join("\n");
  }
  if (ctx.stats) lines.push(`STATS: ${statsLine(ctx.workspaceName, ctx.stats)}`);
  if (plan.kind === "status" || plan.kind === "worry" || plan.kind === "attention") {
    lines.push("TIME: the stats above are all-time workspace totals, not today's activity — never present them as happening today. Only describe today specifically when dated records support it.");
  }
  lines.push("TRUTH: never claim everything is fine, fixed, or healthy, and never promise automatic alerts unless RADAR above confirms a recent alert.");
  if (ctx.incidents.length > 0) {
    lines.push(
      `ACTIVE INCIDENTS (${ctx.incidents.length}): ` +
        ctx.incidents
          .map((i) => `"${i.title.slice(0, 80)}" [${i.status}, ${i.severity}, #${short(i.id)}, ${i.customers} customers]`)
          .join(" | "),
    );
  } else {
    lines.push("ACTIVE INCIDENTS: none.");
  }
  if (ctx.candidates.length > 0) {
    lines.push(
      `PENDING CANDIDATES, ALL UNCONFIRMED (${ctx.candidates.length}): ` +
        ctx.candidates
          .map((c) => `"${c.title.slice(0, 80)}" [#${short(c.id)}, ${c.conversations} convos, ${c.customers} customers]`)
          .join(" | "),
    );
  } else {
    lines.push("PENDING CANDIDATES: none.");
  }
  if (ctx.decisions.length > 0) {
    lines.push(`OUTSTANDING REVIEW WORK: ${ctx.decisions.slice(0, 5).join(" | ")}`);
  }
  if (ctx.radarCandidateId) {
    lines.push(`RADAR: a recent Radar alert exists for candidate #${short(ctx.radarCandidateId)}. You may mention Radar.`);
  } else {
    lines.push("RADAR: no recent Radar alert in context. Do not claim Radar is enabled or sent anything.");
  }
  if (ctx.ambiguous && ctx.ambiguous.length > 0) {
    lines.push(
      `AMBIGUITY: multiple records match — ask the operator to pick one: ` +
        ctx.ambiguous.map((o) => `${o.kind} "${o.title.slice(0, 60)}" #${short(o.id)}`).join(" | "),
    );
  }
  if (ctx.selected) {
    lines.push(
      `SELECTED ${ctx.selected.option.kind.toUpperCase()} #${ctx.selected.shortRef}: ${ctx.selected.detail || "(record no longer available — say so honestly)"}${ctx.selected.stale ? " [STALE — label as outdated]" : ""}`,
    );
    if (
      ctx.selected.nextStep &&
      (plan.kind === "sofar" || plan.kind === "why_related" || plan.kind === "seen_before" || plan.kind === "next_steps")
    ) {
      lines.push(
        `NEXT STEPS (grounded read-only options — always recommend exactly this next step, never claim execution): ${ctx.selected.nextStep}`,
      );
    }
  } else if (
    plan.kind === "why_related" ||
    plan.kind === "sofar" ||
    plan.kind === "seen_before" ||
    plan.kind === "explain"
  ) {
    lines.push("SELECTED: none — no incident or candidate is in context. Ask a natural clarification question instead of guessing.");
  }
  if (plan.kind === "explain" && ctx.lastAssistant) {
    lines.push(`LAST REPLY TO EXPLAIN (rephrase simply, do not add new facts): "${ctx.lastAssistant.slice(0, 400)}"`);
  }
  if (plan.kind === "action_request") {
    lines.push(
      `ACTION REQUESTED (${(plan.topic ?? "").slice(0, 80)}): read-only mode. Explain it needs the staff console and point at the relevant record or list. Do not promise to do it.`,
    );
  }
  return lines.join("\n").slice(0, 2200);
}

// ---- Deterministic fallback (no model, never hallucinates) ----

export function fallbackReply(ctx: ConverseContext, plan: ConversePlan, slug: string): { body: string; link: string | null } {
  switch (plan.kind) {
    case "greeting":
      return {
        body: ctx.empty
          ? `Hey, Meros here.\n\nThings are quiet in ${ctx.workspaceName} — no customer conversations or open issues here yet.\n\nAsk me "what's happening?" anytime.`
          : `Hey, Meros here.\n\n${ctx.incidents.length > 0 ? `Keeping an eye on ${ctx.incidents.length === 1 ? "one open issue" : `${ctx.incidents.length} open issues`} right now.` : "Nothing urgent on the board right now."}\n\nAsk me what's happening or what needs attention.`,
        link: null,
      };
    case "status":
    case "worry": {
      if (ctx.empty) {
        return {
          body: `All quiet in ${ctx.workspaceName}.\n\nNo open issues, and no customer reports to look into yet. That's only what has been reported so far.`,
          link: null,
        };
      }
      const paras: string[] = [];
      if (ctx.stats) paras.push(statsLine(ctx.workspaceName, ctx.stats));
      if (ctx.incidents.length > 0) {
        const top = ctx.incidents[0];
        paras.push(
          plan.kind === "worry"
            ? `Worth a look: "${top.title.slice(0, 80)}" [${top.status}, ${top.severity}] — ${top.customers} customers across ${top.conversations} conversations. #${short(top.id)}`
            : `Open now: ${ctx.incidents.map((i) => `"${i.title.slice(0, 60)}" #${short(i.id)}`).join(", ")}.`,
        );
      } else {
        paras.push("No open issues.");
      }
      const pending = ctx.candidates.length;
      if (pending > 0) paras.push(`${pending} possible recurring problem${pending === 1 ? "" : "s"} waiting for review (all unconfirmed).`);
      if (plan.kind === "worry" && ctx.incidents.length === 0 && ctx.candidates.length === 0) {
        paras.push("Nothing looks worrying — no open issues, nothing waiting.");
      }
      return { body: paras.join("\n\n"), link: ctx.incidents.length > 0 ? incidentLink(slug, ctx.incidents[0].id) : null };
    }
    case "attention":
    case "next_steps": {
      if (ctx.empty) {
        return { body: `Nothing needs you right now — no open issues, nothing waiting for review.\n\nEnjoy the quiet.`, link: null };
      }
      const items = ctx.decisions.slice(0, 3);
      const body =
        items.length > 0
          ? `What needs you:\n${items.join("\n")}\n\nYou'll decide these in the staff console — I keep things read-only here.`
          : ctx.incidents.length > 0
            ? `Top of the pile: "${ctx.incidents[0].title.slice(0, 80)}" [${ctx.incidents[0].status}]\n\nWorth a look in the staff console when you get a moment.`
            : `Nothing outstanding — no review work queued.`;
      return { body, link: `/app/workspaces/${slug}/incidents` };
    }
    case "latest": {
      if (ctx.empty) return { body: `No open issues yet — nothing has come in to investigate.\n\nAsk me again later and I'll check what's live.`, link: null };
      if (ctx.ambiguous && ctx.ambiguous.length > 0) {
        return {
          body: `A couple of fresh reports came in — which one?\n\n${ctx.ambiguous.map((o) => `"${o.title.slice(0, 50)}" #${short(o.id)}`).join(" or ")}\n\nJust reply with the reference.`,
          link: null,
        };
      }
      if (ctx.selected) {
        const s = ctx.selected;
        return {
          body: s.detail ? `Latest: ${s.detail} #${s.shortRef}` : `That record isn't available anymore — try "incidents" for what's live.`,
          link: s.detail ? incidentLink(slug, s.option.id) : null,
        };
      }
      if (ctx.incidents.length > 0) {
        const top = ctx.incidents[0];
        return {
          body: `Latest issue: "${top.title.slice(0, 100)}" [${top.status}, ${top.severity}] — ${top.customers} customers, ${top.conversations} conversations. #${short(top.id)}`,
          link: incidentLink(slug, top.id),
        };
      }
      const c = ctx.candidates[0];
      return {
        body: `No confirmed issues — newest possible problem (unconfirmed): "${c.title.slice(0, 100)}" — ${c.conversations} conversations, ${c.customers} customers. #${short(c.id)}\n\nNothing here is confirmed yet.`,
        link: candidateLink(slug, c.id),
      };
    }
    case "why_related":
    case "sofar":
    case "seen_before": {
      if (ctx.empty) return { body: `Nothing to dig into yet — no issues or reports on record.\n\nAs soon as reports come in I'll group and summarize them here.`, link: null };
      if (ctx.ambiguous && ctx.ambiguous.length > 0) {
        return {
          body: `A couple of things match — which one do you mean?\n\n${ctx.ambiguous.map((o) => `"${o.title.slice(0, 50)}" #${short(o.id)}`).join(" or ")}\n\nJust reply with the reference.`,
          link: null,
        };
      }
      if (!ctx.selected || !ctx.selected.detail) {
        return {
          body: `Which one should I look at?\n\n${[...ctx.incidents, ...ctx.candidates].slice(0, 3).map((o) => `"${o.title.slice(0, 50)}" #${short(o.id)}`).join("\n")}\n\nReply with the reference and I'll dig in.`,
          link: null,
        };
      }
      const s = ctx.selected;
      const link = s.option.kind === "incident" ? incidentLink(slug, s.option.id) : candidateLink(slug, s.option.id);
      return { body: `${s.detail} #${s.shortRef}`, link };
    }
    case "other": {
      if (ctx.ambiguous && ctx.ambiguous.length > 0) {
        return {
          body: `A few to choose from — which one?\n\n${ctx.ambiguous.map((o) => `"${o.title.slice(0, 50)}" #${short(o.id)}`).join("\n")}`,
          link: null,
        };
      }
      if (ctx.selected?.detail) {
        const s = ctx.selected;
        const link = s.option.kind === "incident" ? incidentLink(slug, s.option.id) : candidateLink(slug, s.option.id);
        return { body: `The other one:\n\n${s.detail} #${s.shortRef}`, link };
      }
      return { body: `There's just the one live item right now — reply "incidents" and I'll walk through it.`, link: null };
    }
    case "explain": {
      if (ctx.lastAssistant) {
        const first = ctx.lastAssistant.split(/(?<=[.!?])\s/).slice(0, 2).join(" ").slice(0, 400);
        return { body: `Short version:\n\n${first}`, link: null };
      }
      return { body: `Happy to explain — which part should I unpack?\n\nName the issue or question and I'll put it plainly.`, link: null };
    }
    case "action_request": {
      const topic = (plan.topic ?? "").toLowerCase();
      const target = ctx.selected;
      const link = target
        ? target.option.kind === "incident"
          ? incidentLink(slug, target.option.id)
          : `/app/workspaces/${slug}/incidents/detected/${target.option.id}`
        : `/app/workspaces/${slug}/incidents`;
      let what = "That needs the staff console — I'm read-only here, so I can't make changes from chat.";
      if (/approv/.test(topic)) what = "Approvals happen in the staff console — open the staged plan there to approve. I'm read-only here, so I can't approve from chat.";
      else if (/publish|send|message/.test(topic)) what = "Customer messages go out from the staff console after review — I can't publish from chat. Open the incident there to send.";
      else if (/execut|run|deploy|fix/.test(topic)) what = "Fixes run through the staff console with human verification — I can't execute anything from chat. The proposal is waiting there.";
      else if (/prefer|notif|setting/.test(topic)) what = "Notification preferences live in the staff console — I can't change settings from chat.";
      else if (/accept|dismiss|close|resolv/.test(topic)) what = "Accepting, dismissing, or closing happens in the staff console review — I can't change it from chat.";
      else if (/card/.test(topic)) what = "Fix Cards are edited in the staff console — I can't alter them from chat.";
      else if (/pair|unpair|revoke/.test(topic)) what = "Pairing is managed in the staff console — ask your admin for a fresh code, then reply `pair XXXX-XXXX-XXXX`.";
      return { body: what, link };
    }
    case "unknown":
    default:
      return {
        body: ctx.empty
          ? `I'm with you — and all quiet here: no open issues, no reports to dig into yet.\n\nTry "what's happening?"`
          : `I'm with you. I can share what's happening, what's waiting on review, or dig into an issue.\n\nTry "what needs my attention?"`,
        link: null,
      };
  }
}

// ---- Orchestration (called by operator.ts after auth, before replyOnce) ----

export type ConverseRuntime = {
  text: string;
  history: ConverseTurn[];
  workspaceId: string;
  operatorUserId: string;
  workspaceName: string;
  slug: string;
  stats: StatsSnapshot | null;
  reads: InvestigateReads;
  classify: (text: string, history: ConverseTurn[]) => Promise<ConversePlan>;
  phrase: (input: PhraseInput) => Promise<string>;
};

/**
 * Run one conversational turn: classify (fast path, then bounded model),
 * gather workspace-scoped grounded context, phrase naturally (bounded
 * model), fall back deterministically on any model failure. Returns the
 * reply body + optional console link. Throws only when reads are
 * unreachable (caller degrades honestly without sending).
 */
export async function runConversational(rt: ConverseRuntime): Promise<{ replyText: string; kind: ConverseKind }> {
  let plan: ConversePlan;
  try {
    plan = validateConversePlan(await rt.classify(rt.text, rt.history)) ?? unknownPlan();
  } catch {
    plan = unknownPlan();
  }
  const ctx = await gatherContext({
    plan,
    text: rt.text,
    history: rt.history,
    workspaceId: rt.workspaceId,
    operatorUserId: rt.operatorUserId,
    workspaceName: rt.workspaceName,
    slug: rt.slug,
    stats: rt.stats,
    reads: rt.reads,
  });
  const facts = factsText(ctx, plan, rt.slug);
  const detailed = capFor(plan.kind) === CONVERSE_DETAILED_MAX;
  try {
    const out = await rt.phrase({ text: rt.text, history: rt.history, facts, kind: plan.kind, detailed });
    const link = linkFor(plan, ctx, rt.slug);
    return { replyText: fitConverse(out, link, detailed), kind: plan.kind };
  } catch {
    const fb = fallbackReply(ctx, plan, rt.slug);
    return { replyText: fitConverse(fb.body, fb.link, detailed), kind: plan.kind };
  }
}

function linkFor(plan: ConversePlan, ctx: ConverseContext, slug: string): string | null {
  if (plan.kind === "greeting" || plan.kind === "unknown" || plan.kind === "explain") return null;
  if (plan.kind === "action_request") {
    const s = ctx.selected;
    if (s) {
      return s.option.kind === "incident"
        ? `/app/workspaces/${slug}/incidents/${s.option.id}`
        : `/app/workspaces/${slug}/incidents/detected/${s.option.id}`;
    }
    return `/app/workspaces/${slug}/incidents`;
  }
  if (plan.kind === "attention" || plan.kind === "next_steps") return `/app/workspaces/${slug}/incidents`;
  if (ctx.selected) {
    return ctx.selected.option.kind === "incident"
      ? `/app/workspaces/${slug}/incidents/${ctx.selected.option.id}`
      : `/app/workspaces/${slug}/incidents/detected/${ctx.selected.option.id}`;
  }
  if ((plan.kind === "status" || plan.kind === "worry" || plan.kind === "latest") && ctx.incidents.length > 0) {
    return `/app/workspaces/${slug}/incidents/${ctx.incidents[0].id}`;
  }
  if (plan.kind === "latest" && ctx.candidates.length > 0) {
    return `/app/workspaces/${slug}/incidents/detected/${ctx.candidates[0].id}`;
  }
  return null;
}
