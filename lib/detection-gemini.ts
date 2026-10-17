import "server-only";

import { generateJson } from "./gemini";
import type { Judge, JudgeResult } from "./detection";

// Production judge: one bounded Gemini JSON call per substantive customer
// message. Customer text is UNTRUSTED DATA (never instructions); only ids
// from the provided candidate sets may be referenced, everything else is
// validated or nulled. Any failure degrades to "deferred", never a guess.

const JUDGE_SYSTEM = `You match customer support complaints to known issue patterns. Decide — do not invent diagnoses, causes, or fixes.

Input gives you: NEW_REPORT (one customer message), CANDIDATES (pending issue clusters with member excerpts), DISMISSED (titles of dismissed clusters), RECENT (other recent conversation excerpts).

Return a JSON object with EXACTLY these keys:
{"is_issue": boolean, "title": string, "summary": string, "match_candidate_id": string|null, "dismissed_match_id": string|null, "quality": "high"|"medium"|"low", "rationale": string, "evidence_quote": string}

Rules:
- is_issue is true ONLY for a concrete problem report (broken feature, error, failed payment, wrong charge). Greetings, thanks, follow-ups, questions, and confirmations are NOT issues.
- Two reports match ONLY when they share a SPECIFIC symptom: same error text/code, same failing action on the same feature, same wrong amount or recipient. Generic shared words ("payment", "error", "failed", "login", "app", "slow") ALONE never justify a match — e.g. "my card payment failed" and "my transfer failed" are DIFFERENT problems.
- Different wording of the SAME specific problem IS a match (e.g. "Visa checkout 500s" and "card payment blows up with a server error at checkout").
- match_candidate_id must be an id from CANDIDATES, or null. If the report clearly matches one, set it and set dismissed_match_id to null.
- dismissed_match_id must be an id from DISMISSED, or null. Set it ONLY when the report is the same already-dismissed pattern and nothing materially new is present. Otherwise null.
- A report matching NEITHER gets both ids null — it will seed a new candidate. Do not force a match.
- title: one line, observable symptom only, no cause claims. summary: 1-2 sentences of what customers experience. rationale: one sentence on WHY reports match (quote the overlapping specifics) or why not.
- evidence_quote: the shortest customer phrase supporting the call, copied verbatim from NEW_REPORT or excerpts — never invented.
- Keep title under 120 chars, summary under 400, rationale under 300.`;

const MAX_TITLE = 120;
const MAX_SUMMARY = 400;
const MAX_RATIONALE = 300;

function clean(s: unknown, max: number, fallback: string): string {
  const t = typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "";
  if (!t) return fallback;
  return t.length > max ? t.slice(0, max) : t;
}

/** Strict shape validation for model output. Pure — unit-testable. */
export function validateJudgeOutput(
  raw: unknown,
  knownPending: ReadonlySet<string>,
  knownDismissed: ReadonlySet<string>,
): JudgeResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.is_issue !== "boolean") return null;
  const quality = r.quality === "high" || r.quality === "medium" || r.quality === "low" ? r.quality : "low";
  const match =
    typeof r.match_candidate_id === "string" && knownPending.has(r.match_candidate_id)
      ? r.match_candidate_id
      : null;
  const dismissed =
    typeof r.dismissed_match_id === "string" && knownDismissed.has(r.dismissed_match_id)
      ? r.dismissed_match_id
      : null;
  if (!r.is_issue) {
    return {
      isIssue: false,
      title: "",
      summary: "",
      matchCandidateId: null,
      dismissedMatchId: null,
      quality,
      rationale: clean(r.rationale, MAX_RATIONALE, "not a concrete problem report"),
    };
  }
  const title = clean(r.title, MAX_TITLE, "");
  const summary = clean(r.summary, MAX_SUMMARY, "");
  if (!title || !summary) return null;
  return {
    isIssue: true,
    title,
    summary,
    matchCandidateId: match,
    dismissedMatchId: match ? null : dismissed,
    quality,
    rationale: clean(r.rationale, MAX_RATIONALE, "matched on reported symptoms"),
  };
}

function describeCandidate(c: { id: string; title: string; summary: string; excerpts: string[] }): string {
  const ex = c.excerpts
    .slice(0, 2)
    .map((e) => `"${e.slice(0, 200)}"`)
    .join(" | ");
  return `- id:${c.id} TITLE: ${c.title.slice(0, 120)}\n  SUMMARY: ${c.summary.slice(0, 300)}\n  EXCERPTS: ${ex}`;
}

/** The real model-backed judge. Throws on Gemini failure (caller degrades). */
export function geminiJudge(): (input: Parameters<Judge>[0]) => Promise<JudgeResult> {
  return async (input) => {
    const userText = [
      `NEW_REPORT: "${input.message.slice(0, 500)}"`,
      ``,
      `CANDIDATES (${input.candidates.length} pending):`,
      ...input.candidates.map(describeCandidate),
      ``,
      `DISMISSED (${input.dismissed.length} titles):`,
      ...input.dismissed.slice(0, 20).map((d) => `- id:${d.id} TITLE: ${d.title.slice(0, 120)}`),
      ``,
      `RECENT conversations (${input.recentConversations.length}, for context only — never match to these):`,
      ...input.recentConversations.slice(0, 10).map((r) => `- id:${r.id} EXCERPT: "${r.excerpt.slice(0, 200)}"`),
    ].join("\n");
    const raw = await generateJson({ systemInstruction: JUDGE_SYSTEM, userText });
    const out = validateJudgeOutput(
      raw,
      new Set(input.candidates.map((c) => c.id)),
      new Set(input.dismissed.map((d) => d.id)),
    );
    if (!out) throw new Error("judge returned unusable output");
    return out;
  };
}
