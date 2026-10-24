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
// - Replies label every draft DRAFT / planning-only / needs human review.

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

function planLines(payload: {
  steps: { kind: string; description: string; risk: string }[];
  riskLevel: string;
  missingInfo: string[];
}): string[] {
  const lines = payload.steps.slice(0, 3).map(
    (s, i) => `${i + 1}. [${s.kind}] ${clean(s.description, 120)}`,
  );
  lines.push(`Overall risk: ${payload.riskLevel}.`);
  if (payload.missingInfo.length > 0) {
    lines.push(`Still unknown: ${clean(payload.missingInfo[0], 140)}`);
  }
  return lines;
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
      body: `That's still an unconfirmed grouping, not a confirmed incident — I can only draft for confirmed incidents.\n\nReview it in the staff console first; once accepted I'll draft the recovery plan here. #${short(option.id)}`,
      link: `/app/workspaces/${slug}/incidents/detected/${option.id}`,
    };
  }
  const inc = await input.getIncident(option.id, workspaceId).catch(() => null);
  if (!inc) {
    return { body: `That record isn't available anymore — try "incidents" for what's live.`, link: `/app/workspaces/${slug}/incidents` };
  }
  const context = `"${clean(inc.title, 80)}" [${inc.status}, ${inc.severity}] — ${inc.customers} customers across ${inc.conversations} conversations.`;
  if (!input.authorized) {
    // Model-inferred intent is never enough to mutate: demand the explicit phrase.
    return {
      body: `${context}\n\nTo draft a recovery plan for this, reply exactly:\n\ndraft a recovery plan for #${short(inc.id)}\n\nDrafts are planning-only and always need human review — nothing is approved or sent from chat.`,
      link: incidentLink(slug, inc.id),
    };
  }
  let result: GenerateResult;
  try {
    result = await input.runPlan(inc.id, workspaceId);
  } catch {
    return { body: `${context}\n\nDrafting hit a wall reaching the records — nothing was created. Try again in a bit, or open the staff console.`, link: incidentLink(slug, inc.id) };
  }
  const reviewLine = `Review it here (staff sign-in):`;
  switch (result.action) {
    case "built":
    case "unchanged": {
      const p = result.plan.payload;
      const fresh = result.action === "built" ? "Drafted" : "Already drafted";
      return {
        body:
          `${context}\n\n${fresh} recovery plan v${result.plan.plan_version} (DRAFT — planning only, needs human review, not approved, nothing sent):\n` +
          planLines(p).join("\n") +
          `\n\n${reviewLine}`,
        link: incidentLink(slug, inc.id),
      };
    }
    case "insufficient":
      return {
        body: `${context}\n\nI can't draft yet — ${clean(result.reason, 160)}\n\nLink the latest customer report so the evidence brief assembles, then ask me again.`,
        link: incidentLink(slug, inc.id),
      };
    case "in_progress":
      return {
        body: `${context}\n\nA draft is already being prepared — give it a moment, then ask again. Nothing is approved or sent from chat.`,
        link: incidentLink(slug, inc.id),
      };
    case "deferred":
      return {
        body: `${context}\n\nDrafting hit a wall reaching the records — nothing was created. Try again in a bit, or open the staff console.`,
        link: incidentLink(slug, inc.id),
      };
    case "failed":
    default:
      return {
        body: `${context}\n\nDrafting failed (${clean(result.action === "failed" ? result.error : "unknown", 160)}). Nothing was stored — the evidence and existing records are untouched. Try again, or open the staff console.`,
        link: incidentLink(slug, inc.id),
      };
  }
}
