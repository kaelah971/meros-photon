import "server-only";

import type { GenerateResult } from "../recovery-plans";
import { incidentLink } from "./investigate";

// P3 iMessage recovery-plan copilot orchestration. Pure logic with
// injected reads/runner — no Photon transport, no direct DB. Called by
// converse.runConversational AFTER operator.ts authorization (active
// binding + staff already verified); references still resolve ONLY
// against workspace-scoped records, never guessed IDs.
//
// Hard boundaries (enforced here, not trusted to callers):
// - Generation runs ONLY when `authorized` is true — i.e. the explicit
//   request matched the deterministic fast path. Model-classified
//   requests get a confirmation prompt, never generation. An LLM never
//   authorizes a database mutation.
// - Planning only: drafts are created via the existing validated
//   generatePlanIfNeeded. Nothing here approves, executes, messages
//   customers, changes incident status, or claims verification.
// - Every draft reply says plainly that it needs human review and that
//   nothing is approved or sent — no jargon, no raw statuses.

export type CopilotOption = { kind: "candidate" | "incident"; id: string; title: string };

export type PlanCopilotSelection =
  | { state: "selected"; option: CopilotOption }
  | { state: "ambiguous"; options: CopilotOption[] }
  | { state: "none"; live: CopilotOption[] };

export type CopilotIncident = {
  id: string;
  title: string;
  status: string;
  severity: string;
  customers: number;
  conversations: number;
} | null;

export type PlanRunner = (incidentId: string, workspaceId: string) => Promise<GenerateResult>;

const short = (id: string) => id.slice(0, 8);
const clean = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);

/**
 * Deterministic draft-confirmation matcher. A bare confirmation counts ONLY
 * when the newest bot-authored turn is OUR draft prompt for a specific
 * incident ("reply YES … #<short>") — older prompts expire, unrelated
 * "yes" answers never authorize anything. Returns the bound short ref so
 * the caller revalidates it against live workspace records. Pure.
 */
const CONFIRM_RE = /^\s*(yes|yeah|yep|yup|do it|go ahead|please do|draft it|confirm(?:ed)?|ok(?:ay)?(?: do it| draft it)?|sure(?: do it)?|sounds good|lets do it|let's do it)(\s*,?\s*please)?\s*[!.?]*$/i;
const CONFIRM_PROMPT_RE = /reply YES[^\n]*#([0-9a-f]{8,})/i;

export function matchDraftConfirmation(
  text: string,
  history: { role: string; text: string }[],
): { shortRef: string } | null {
  if (!CONFIRM_RE.test(text.trim())) return null;
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (h.role !== "assistant" || !h.text.trim()) continue;
    const m = h.text.match(CONFIRM_PROMPT_RE);
    return m ? { shortRef: m[1].toLowerCase() } : null;
  }
  return null;
}

/** iMessage body budget. Mirrors converse CONVERSE_NORMAL_MAX: fitConverse
 * appends the review link separately, so the body must leave room for it. */
export const PLAN_BODY_CAP = 500;

/**
 * Longest complete-sentence prefix within maxLen (minLen floors trivial
 * fragments like "v2."). Returns null when nothing safe fits — callers
 * then try a clause cut, then fall back to a general acknowledgement.
 */
export function completeSentences(text: string, maxLen: number, minLen = 12): string | null {
  const cleanText = text.replace(/\s+/g, " ").trim();
  if (!cleanText) return null;
  if (cleanText.length <= maxLen) return cleanText;
  const m = cleanText.slice(0, maxLen).match(/^([\s\S]*[.!?])(?=\s|$)/);
  const sent = (m ? m[1] : "").trim();
  return sent.length >= minLen ? sent : null;
}

const DANGLERS = /\b(the|a|an|and|or|to|of|for|with|in|on|at|that|this|these|those|is|are|was|were|be|been|by|from|as|it|its|their|his|her|our|your)\s*[,;:\u2014\u2013-]*\s*$/i;

/**
 * Meaning-preserving clause cut for single-sentence steps that exceed the
 * budget: longest prefix ending at a comma/semicolon/dash/conjunction
 * boundary, with dangling words stripped. Never returns a fragment ending
 * mid-clause ("or are"); null when no safe cut exists.
 */
export function clauseCut(text: string, maxLen: number, minLen = 40): string | null {
  const cleanText = text.replace(/\s+/g, " ").trim();
  if (!cleanText || cleanText.length <= maxLen) return cleanText || null;
  const slice = cleanText.slice(0, maxLen);
  const bounds = [",", ";", ":", "\u2014", "\u2013", " - ", " and ", " or ", " but "]
    .map((b) => slice.lastIndexOf(b))
    .filter((i) => i > 0);
  if (bounds.length === 0) return null;
  let cut = slice.slice(0, Math.max(...bounds)).replace(/[\s,;:\u2014\u2013-]+$/, "");
  cut = cut.replace(DANGLERS, "").trim();
  return cut.length >= minLen ? cut : null;
}

/**
 * Built/unchanged reply that always fits the iMessage budget with complete
 * sentences and an intact link: short ack, ONE payload-derived first
 * recommendation (or a general ack when it cannot fit safely), review
 * reminder, and the link passed separately (fitConverse appends it).
 */
export function planResultBody(input: {
  context: string;
  fresh: boolean;
  firstStep: string | null;
  link: string;
}): { body: string; link: string } {
  const ack = input.fresh
    ? "Yeah, I've put together a draft."
    : "Good news — there's already a draft for this, nothing new to add.";
  const reminder =
    "We haven't confirmed the cause yet — it still needs your review, and nothing is approved or sent.";
  const head = `${input.context}\n\n${ack} `;
  const tail = `\n\n${reminder}`;
  const linkRoom = input.link.length + 2; // fitConverse joins body + link with "\n\n"
  const recPrefix = "Here's what I'd check first: ";
  const recBudget = PLAN_BODY_CAP - linkRoom - (head + tail).length - recPrefix.length;
  const stepped = input.firstStep?.replace(/\s+/g, " ").trim() ?? "";
  const rec =
    completeSentences(stepped, recBudget) ?? clauseCut(stepped, recBudget) ?? null;
  const recLine = rec
    ? `${recPrefix}${rec}`
    : "The write-up is too detailed for chat — open the review link for the full steps.";
  return { body: `${head}${recLine}${tail}`, link: input.link };
}

/** Plain-words cause for a failed draft. Categories stay machine-usable
 * upstream; iMessage gets everyday language, never raw model output. */
function plainFailureCause(error: string): string {
  const e = error.toLowerCase();
  if (e.includes("no_step_cited_authorized_evidence"))
    return "I couldn't tie the next steps to the reported evidence";
  if (e.includes("steps_rejected_safety_or_ownership"))
    return "a step missed a safety check";
  if (e.includes("high_risk_without_approval_warning"))
    return "a high-risk step missed its approval warning";
  if (e.includes("unsupported_certainty") || e.includes("executable"))
    return "the wording overstated what we actually know";
  if (e.includes("empty_or_malformed") || e.includes("missing_summary"))
    return "the model didn't come back with anything usable";
  return "the draft didn't check out";
}

/**
 * Production runner: existing P2 generation with real deps. Idempotent
 * per (incident, brief fingerprint) — unchanged briefs return the
 * existing draft with zero new rows.
 */
export async function realPlanRunner(
  incidentId: string,
  workspaceId: string,
  operatorUserId: string,
): Promise<GenerateResult> {
  const { generatePlanIfNeeded, realPlanDeps } = await import("../recovery-plans");
  return generatePlanIfNeeded(incidentId, workspaceId, operatorUserId, await realPlanDeps());
}

export async function handlePlanRequest(input: {
  selection: PlanCopilotSelection;
  workspaceId: string;
  slug: string;
  /** Deterministic explicit-request gate. False = model-inferred only. */
  authorized: boolean;
  runPlan: PlanRunner;
  getIncident: (incidentId: string, workspaceId: string) => Promise<CopilotIncident>;
}): Promise<{ body: string; link: string | null }> {
  const { selection, workspaceId, slug } = input;
  if (selection.state === "ambiguous") {
    const opts = selection.options.slice(0, 3);
    return {
      body: `A few match — which incident should I draft for?\n\n${opts.map((o) => `"${clean(o.title, 50)}" #${short(o.id)}`).join("\n")}\n\nReply with the reference and I'll draft it.`,
      link: null,
    };
  }
  if (selection.state === "none") {
    if (selection.live.length === 0) {
      return { body: `Nothing to draft for — no open issues right now.`, link: null };
    }
    return {
      body: `Which incident should I draft for?\n\n${selection.live.slice(0, 3).map((o) => `"${clean(o.title, 50)}" #${short(o.id)}`).join("\n")}\n\nReply "draft a recovery plan for #<ref>" and I'll draft it.`,
      link: `/app/workspaces/${slug}/incidents`,
    };
  }
  const { option } = selection;
  if (option.kind !== "incident") {
    return {
      body: `That's still something we're looking into, not a confirmed incident yet — I can only draft once it's confirmed.\n\nTake a look in the staff console first; once it's accepted I'll draft the recovery plan here.`,
      link: `/app/workspaces/${slug}/incidents/detected/${option.id}`,
    };
  }
  const inc = await input.getIncident(option.id, workspaceId).catch(() => null);
  if (!inc) {
    return { body: `That record isn't available anymore — try "incidents" for what's live.`, link: `/app/workspaces/${slug}/incidents` };
  }
  const stateWords = inc.status === "resolved" ? "resolved" : inc.status === "dismissed" ? "dismissed" : "still open";
  const context = `"${clean(inc.title, 80)}" — ${stateWords}. Affects ${inc.customers} customers across ${inc.conversations} conversations.`;
  if (!input.authorized) {
    // Model-inferred intent is never enough to mutate: offer a one-word
    // contextual confirmation bound to THIS incident, or the exact phrase.
    // matchDraftConfirmation accepts the YES only against this prompt.
    return {
      body: `${context}\n\nWant me to draft the recovery plan? Reply YES and I'll draft #${short(inc.id)} for review. Nothing is approved or sent from here.\n\nThe evidence brief is ready, though we haven't confirmed the cause yet.`,
      link: incidentLink(slug, inc.id),
    };
  }
  let result: GenerateResult;
  try {
    result = await input.runPlan(inc.id, workspaceId);
  } catch {
    return { body: `${context}\n\nDrafting hit a wall reaching the records — nothing was created. Try again in a bit, or open the staff console.`, link: incidentLink(slug, inc.id) };
  }
  switch (result.action) {
    case "built":
    case "unchanged": {
      const p = result.plan.payload;
      const first = p.steps.length > 0 ? p.steps[0].description : null;
      const composed = planResultBody({
        context,
        fresh: result.action === "built",
        firstStep: first,
        link: incidentLink(slug, inc.id),
      });
      return { body: composed.body, link: composed.link };
    }
    case "insufficient":
      return {
        body: `${context}\n\nI can't draft anything useful yet — ${clean(result.reason, 160)}\n\nOnce the latest customer report is linked up, ask me again and I'll take another look.`,
        link: incidentLink(slug, inc.id),
      };
    case "in_progress":
      return {
        body: `${context}\n\nA draft is already on its way — give it a moment, then ask again. Nothing is approved or sent from here.`,
        link: incidentLink(slug, inc.id),
      };
    case "deferred":
      return {
        body: `${context}\n\nI couldn't reach the records just now, so nothing was drafted. Try again in a bit, or open the staff console.`,
        link: incidentLink(slug, inc.id),
      };
    case "failed":
    default:
      return {
        body: `${context}\n\nI tried, but ${plainFailureCause(result.action === "failed" ? result.error : "unknown")} — nothing was stored and the existing records are untouched. Try again, or open the staff console.`,
        link: incidentLink(slug, inc.id),
      };
  }
}
