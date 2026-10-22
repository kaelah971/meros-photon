import type { ChatTurn } from "./gemini";

// Pure helpers for the resolution → Fix Card → promotion loop.
// All Walrus/model I/O lives in routes; everything here is unit-testable.

export const MEMORY_TYPES = ["PROFILE", "ISSUE", "ATTEMPT", "RESOLUTION", "CORRECTION"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export type ExtractedFact = { type: MemoryType; text: string };

// --- Resolution detection -------------------------------------------------

const RESOLUTION_PATTERNS = [
  /\bthat fixed it\b/i,
  /\bit'?s fixed\b/i,
  /\bworks? now\b/i,
  /\bit worked\b/i,
  /\bworking now\b/i,
  /\bproblem solved\b/i,
  /\bissue (is |was )?resolved\b/i,
  /\bmark( |$|ed).*resolv/i,
  /\bresolv(ed|tion confirmed)\b/i,
  /\ball good now\b/i,
  /\bsolved it\b/i,
  /\bthank .*?(fixed|solved|working|helpful)\b/i,
  /\bfixed,? thanks\b/i,
];

/** Explicit user resolution language. Never inferred from assistant prose. */
export function detectResolution(message: string): boolean {
  const t = message.trim();
  if (t.length < 3 || t.length > 500) return false;
  return RESOLUTION_PATTERNS.some((re) => re.test(t));
}

// --- Retrieval query construction ------------------------------------------
// Compact symptom/error/product context. Filler removed so short profile
// facts (which scored ~0.806 against a full chatty question at cutoff 0.8)
// match on substance, not politeness padding.

const FILLER_PATTERNS: RegExp[] = [
  /\bplease\b/gi,
  /\bthanks?\b/gi,
  /\bthank you\b/gi,
  /\bhi\b/gi,
  /\bhello\b/gi,
  /\bhey\b/gi,
  /\bcould you\b/gi,
  /\bcan you\b/gi,
  /\bwould you\b/gi,
  /\bi (need|want|was wondering|wondering)\b/gi,
  /\bfor a bug report\b/gi,
  /\bi need it\b/gi,
  /\bwhat should i check\??$/i,
  /\bwhat do i do\??$/i,
];

export function buildRecallQuery(message: string, history: ChatTurn[] = []): string {
  let q = message.trim();
  for (const re of FILLER_PATTERNS) q = q.replace(re, " ");
  q = q.replace(/\s+/g, " ").replace(/\s+([?.,!])/g, "$1").trim();
  // Add compact context from the previous user turn only (symptom/product).
  const prevUser = [...history].reverse().find((t) => t.role === "user");
  if (prevUser) {
    let ctx = prevUser.text.replace(/\s+/g, " ").trim().slice(0, 160);
    if (ctx && !q.toLowerCase().includes(ctx.toLowerCase().slice(0, 24))) {
      q = `${ctx} | ${q}`;
    }
  }
  return q.slice(0, 500) || message.trim().slice(0, 500);
}

// --- Fix Card candidate -----------------------------------------------------

export type FixCandidate = { symptom: string; cause: string; resolution: string };

export function formatSharedFix(c: FixCandidate): string {
  return [
    "[SHARED_FIX]",
    `Symptom: ${c.symptom.trim()}`,
    `Cause: ${c.cause.trim()}`,
    `Resolution: ${c.resolution.trim()}`,
  ].join("\n");
}

export function parseSharedFix(text: string): FixCandidate | null {
  const lines = text.trim().split("\n").map((l) => l.trim());
  if (lines[0] !== "[SHARED_FIX]") return null;
  const get = (label: string) => {
    const line = lines.find((l) => l.toLowerCase().startsWith(label.toLowerCase() + ":"));
    return line ? line.slice(label.length + 1).trim() : "";
  };
  const c = { symptom: get("Symptom"), cause: get("Cause"), resolution: get("Resolution") };
  if (!c.symptom || !c.cause || !c.resolution) return null;
  return c;
}

// --- Redaction / sanitization gate -------------------------------------------
// Runs server-side on every candidate, including text echoed back by the
// operator's own client at promote time (client input is untrusted).

const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "email address", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { name: "private namespace", re: /meros:user:[0-9a-f]{8,}/i },
  { name: "sui/object id", re: /\b0x[0-9a-f]{16,}\b/i },
  { name: "api key/token", re: /\b(api[_-]?key|bearer|secret|password|passwd|pwd)\s*[:=]\s*\S+/i },
  { name: "bech32 secret", re: /\b(suiprivkey1|walrusprivkey1)[a-z0-9]+\b/i },
  { name: "seed phrase", re: /\b(mnemonic|seed phrase)\s*[:=]/i },
  { name: "phone number", re: /(\+?\d[\d\s().-]{7,}\d)/ },
  { name: "access code leak", re: /\baccess code\s*[:=]\s*\S+/i },
];

export function checkRedaction(text: string): { passed: boolean; issues: string[] } {
  const issues: string[] = [];
  for (const p of SECRET_PATTERNS) {
    if (p.re.test(text)) issues.push(`possible ${p.name}`);
  }
  return { passed: issues.length === 0, issues };
}

const MAX_FIELD_CHARS = 400;

// --- Resolution grounding ----------------------------------------------------
// A shared fix must preserve the CONFIRMED resolution, not substitute an
// alternate technique. Grounding is lexical and deterministic: the Resolution
// must overlap the user's own confirmation turns, and must not introduce
// technique words absent from the whole recent conversation.

const GROUNDING_STOPWORDS = new Set(
  "a,an,the,and,or,but,if,then,else,when,with,without,for,from,to,of,in,on,at,by,as,is,are,was,were,be,been,it,its,this,that,these,those,you,your,they,their,we,our,will,can,should,could,would,do,does,did,not,no,yes,all,any,each,other,into,over,under,again,once,just,also,than,too,very,how,what,which,who,whom,why,there,here,have,has,had,use,used,using,file,files,try,make,made".split(","),
);

function stemToken(w: string): string {
  if (w.length > 6 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 5 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 5 && w.endsWith("es")) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith("s")) return w.slice(0, -1);
  return w;
}

function contentStems(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? [])
    .map(stemToken)
    .filter((w) => !GROUNDING_STOPWORDS.has(w));
}

export type GroundingResult = {
  grounded: boolean;
  reason: string;
  confirmOverlap: number;
  novelWords: string[];
};

// Boilerplate that carries no technique meaning — excluded before matching so
// ordinary phrasing ("retry the import") neither helps nor hurts.
const GENERIC_ANCHORS = new Set(
  "file,files,import,imports,retry,retries,try,error,errors,issue,issues,problem,data,fix,fixed,works,work,working,step,steps,result,results".split(","),
);

// Anchors = the resolution's substantive concepts (action + key parameters).
function resolutionAnchors(s: string): string[] {
  return [...new Set(contentStems(s).filter((w) => !GENERIC_ANCHORS.has(w)))];
}

const MIN_ANCHOR_RATIO = 0.5;

export function checkResolutionGrounding(
  resolution: string,
  confirmation: string,
  context = "",
): GroundingResult {
  const anchors = resolutionAnchors(resolution);
  if (anchors.length === 0) {
    return { grounded: false, reason: "resolution has no substantive action", confirmOverlap: 0, novelWords: [] };
  }
  const confirmSet = new Set(contentStems(confirmation));
  const matched = anchors.filter((w) => confirmSet.has(w));
  const confirmOverlap = matched.length / anchors.length;
  // Diagnostic only: anchors absent from the whole conversation (assistant
  // suggestions included). Never decisive on its own — the confirmation
  // match above is what blocks substitutions.
  const contextSet = new Set([...confirmSet, ...contentStems(context)]);
  const novelWords = anchors.filter((w) => !contextSet.has(w));
  const need = Math.min(2, anchors.length);
  if (matched.length >= need && confirmOverlap >= MIN_ANCHOR_RATIO) {
    return { grounded: true, reason: `grounded in confirmed anchors (${matched.join(", ")})`, confirmOverlap, novelWords };
  }
  const missing = anchors.filter((w) => !confirmSet.has(w));
  return {
    grounded: false,
    reason: `resolution is not grounded in the user-confirmed action (${matched.length}/${anchors.length} anchors match; missing: ${missing.slice(0, 6).join(", ") || "none"}) — refusing a substituted fix`,
    confirmOverlap,
    novelWords,
  };
}

// --- Claim grounding (Symptom/Cause) ------------------------------------------
// Resolution grounding alone is not enough: an assistant hypothesis discussed
// mid-conversation (e.g. "due to regional locale settings") can be promoted
// into Cause as if it were established fact. Symptom/Cause claims must be
// supported by CUSTOMER-PROVIDED evidence (user turns / quoted error text) —
// assistant-only wording is dropped clause by clause, and the field is
// rejected when nothing supportable remains.

// Causal seams where speculation typically attaches. Separators are
// captured so fully-supported fields rejoin byte-identically.
const CLAIM_SEAM_RE = /(\.\s+|[!?;]+\s*|(?:,\s*)?(?:due to|because of|thanks to|caused by)\s+|\s+because\s+)/i;

type ClausePart = { clause: string; sepAfter: string; index: number };

function splitClauses(field: string): ClausePart[] {
  const tokens = field.split(CLAIM_SEAM_RE);
  const out: ClausePart[] = [];
  for (let i = 0; i < tokens.length; i += 2) {
    const clause = (tokens[i] ?? "").trim();
    if (!clause) continue;
    out.push({ clause, sepAfter: tokens[i + 1] ?? "", index: i / 2 });
  }
  return out;
}

export type ClaimGrounding =
  | { ok: true; text: string; dropped: string[] }
  | { ok: false; reason: string };

/**
 * Keep only the clauses of a Symptom/Cause field whose substantive anchors
 * appear in customer-provided evidence. Clauses with no anchors (generic
 * phrasing) are kept — only positively-unsupported claims are dropped.
 */
export function groundClaimField(field: string, userEvidence: string): ClaimGrounding {
  const clean = field.trim();
  if (!clean) return { ok: false, reason: "field is empty" };
  const evidenceSet = new Set(contentStems(userEvidence));
  const parts = splitClauses(clean);
  if (parts.length === 0) return { ok: false, reason: "field has no readable clauses" };
  const dropped: string[] = [];
  const kept: ClausePart[] = parts.filter((p) => {
    const anchors = resolutionAnchors(p.clause);
    if (anchors.length === 0) return true;
    const supported = anchors.some((w) => evidenceSet.has(w));
    if (!supported) dropped.push(p.clause);
    return supported;
  });
  if (kept.length === 0) {
    return {
      ok: false,
      reason: `no clause of the field is supported by customer evidence (dropped: ${dropped.slice(0, 3).join(" | ") || "all"}) — refusing an ungrounded claim`,
    };
  }
  // Rebuild with original separators when clauses were adjacent; a neutral
  // ". " bridge otherwise. Nothing dropped => byte-identical to input.
  let rebuilt = kept[0].clause;
  for (let i = 1; i < kept.length; i++) {
    const prev = kept[i - 1];
    const cur = kept[i];
    rebuilt += (cur.index === prev.index + 1 ? prev.sepAfter : ". ") + cur.clause;
  }
  rebuilt = rebuilt.replace(/\s+/g, " ").trim();
  // Preserve the field's terminal punctuation when surgery removed it
  // (e.g. "…delimiters due to X." -> "…delimiters.").
  if (dropped.length > 0 && /[.!?]$/.test(clean) && !/[.!?;:]$/.test(rebuilt)) {
    rebuilt += ".";
  }
  if (rebuilt.length < 10) {
    return { ok: false, reason: "field has no supportable substance after speculation was removed" };
  }
  const anchors = resolutionAnchors(rebuilt);
  const matched = anchors.filter((w) => evidenceSet.has(w));
  const need = Math.min(2, anchors.length);
  if (anchors.length > 0 && !(matched.length >= need && matched.length / anchors.length >= MIN_ANCHOR_RATIO)) {
    return {
      ok: false,
      reason: `field is not grounded in customer evidence (${matched.length}/${anchors.length} anchors match) — refusing an ungrounded claim`,
    };
  }
  return { ok: true, text: rebuilt, dropped };
}

/** Full server-side gate for a candidate about to enter shared memory. */
export function validateSharedCandidate(
  text: string,
  grounding?: { confirmation: string; context?: string; evidence?: string },
): {
  ok: boolean;
  candidate?: FixCandidate;
  error?: string;
  redaction?: { passed: boolean; issues: string[] };
  /** Present when evidence grounding rewrote the text: the safe version. */
  sanitized?: string;
} {
  const clean = text.trim();
  if (!clean) return { ok: false, error: "candidate is empty" };
  if (clean.length > 2000) return { ok: false, error: "candidate too long" };
  const candidate = parseSharedFix(clean);
  if (!candidate) {
    return { ok: false, error: "candidate must be [SHARED_FIX] with Symptom/Cause/Resolution lines" };
  }
  for (const [k, v] of Object.entries(candidate)) {
    if (v.length > MAX_FIELD_CHARS) {
      return { ok: false, error: `${k} exceeds ${MAX_FIELD_CHARS} chars` };
    }
  }
  if (grounding) {
    const g = checkResolutionGrounding(candidate.resolution, grounding.confirmation, grounding.context ?? "");
    if (!g.grounded) {
      return { ok: false, candidate, error: g.reason };
    }
    // Symptom/Cause claims must come from customer-provided evidence —
    // assistant speculation (discussed mid-thread but never confirmed) is
    // dropped clause by clause; ungroundable fields reject the candidate.
    if (typeof grounding.evidence === "string" && grounding.evidence.trim()) {
      const evidence = grounding.evidence;
      const scrubbed = { ...candidate };
      for (const key of ["symptom", "cause"] as const) {
        const r = groundClaimField(scrubbed[key], evidence);
        if (!r.ok) return { ok: false, candidate, error: r.reason };
        scrubbed[key] = r.text;
      }
      const sanitized = formatSharedFix(scrubbed);
      const reparsed = parseSharedFix(sanitized);
      if (!reparsed) return { ok: false, candidate, error: "candidate failed shape check after grounding" };
      const redaction = checkRedaction(sanitized);
      if (!redaction.passed) {
        return { ok: false, candidate: reparsed, redaction, error: `redaction failed: ${redaction.issues.join(", ")}` };
      }
      return { ok: true, candidate: reparsed, redaction, sanitized };
    }
  }
  const redaction = checkRedaction(clean);
  if (!redaction.passed) {
    return { ok: false, candidate, redaction, error: `redaction failed: ${redaction.issues.join(", ")}` };
  }
  return { ok: true, candidate, redaction };
}

// --- Extraction output validation --------------------------------------------

export function validateExtractedFacts(raw: unknown): ExtractedFact[] {
  if (!Array.isArray(raw)) return [];
  const out: ExtractedFact[] = [];
  const seen = new Set<string>();
  for (const item of raw.slice(0, 3)) {
    if (!item || typeof item !== "object") continue;
    const { type, text } = item as { type?: unknown; text?: unknown };
    if (typeof type !== "string" || typeof text !== "string") continue;
    const t = type.trim().toUpperCase();
    if (!(MEMORY_TYPES as readonly string[]).includes(t)) continue;
    const clean = text.trim().replace(/^\[[A-Za-z_]+\]\s*/, "");
    if (clean.length < 10 || clean.length > 500) continue;
    if (checkRedaction(clean).passed === false) continue;
    // One fact, one write: identical facts in a single extraction batch
    // collapse to a single write so a turn can never store duplicates.
    const key = `${t}:${clean.toLowerCase().replace(/\s+/g, " ").trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type: t as MemoryType, text: `[${t}] ${clean}` });
  }
  return out;
}

/** Remove facts that restate already-recalled memory (dedupe at capture). */
export function dropKnownFacts(facts: ExtractedFact[], knownTexts: string[]): ExtractedFact[] {
  const norm = (s: string) =>
    s.replace(/^\[[A-Za-z_]+\]\s*/, "").toLowerCase().replace(/\s+/g, " ").trim();
  const known = new Set(knownTexts.map(norm));
  return facts.filter((f) => {
    const n = norm(f.text);
    if (!n || known.has(n)) return false;
    for (const k of known) {
      if (k && (k.includes(n) || n.includes(k))) return false;
    }
    return true;
  });
}
