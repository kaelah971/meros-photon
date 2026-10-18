import "server-only";

import { after } from "next/server";

import type { BriefFindings } from "./evidence-brief";

// S8 memory-backed fix-card matching: read-only recommendations linking a
// confirmed incident's CURRENT S6 evidence brief to authorized historical
// Fix Cards. Nothing here executes fixes, changes lifecycle, or sends
// messages — it only surfaces grounded similarity with applicability
// warnings. Matching is fingerprint-gated: unchanged evidence never
// re-runs; a new fingerprint invalidates older rows (kept as history).
//
// Authorization boundaries (never crossed):
// - Neon candidates: SAME workspace only, status shared|kept_private.
//   pending_review (unreviewed), failed, and superseded cards never surface.
// - Walrus: ONLY the global shared-fixes namespace is recalled, and a hit
//   surfaces ONLY when its blob resolves to a card in THIS workspace.
//   Customer-private namespaces are never touched.

export type MatchBrief = {
  status: string;
  version: number;
  fingerprint: string;
  findings: BriefFindings;
  source_count: number;
  generated_at: string | null;
};

export type MatchCard = {
  id: string;
  status: string;
  /** reviewed_text ?? candidate_text: what staff actually approved or wrote. */
  text: string;
  /** True when the linked support issue is resolved; null when unknown. */
  resolved: boolean | null;
  createdAt: string;
  blobId: string | null;
};

export type BriefSignals = {
  /** Exact tokens from the brief (error codes, amounts, feature names). */
  identifiers: string[];
  /** Lowercased symptom words, stopwords removed. */
  symptomTerms: string[];
  /** Raw observation strings (for judge context + validation corpus). */
  observations: string[];
};

export type MatchTier = "verified_fix" | "documented_unverified" | "possible_match";

/** Generic support words that must never establish a match by themselves. */
const STOPWORDS = new Set(
  "payment,failed,fails,failure,error,errors,issue,issues,problem,problems,checkout,account,orders,order,page,app,website,site,code,message,today,still,again,when,with,from,that,this,have,been,very,just,also,into,over,under,more,most,than,then,their,there,them,they,what,while,after,before,cannot,card,cards,pay,paid,trying,tried,getting,works,working,broken,sorry,please,help,hello,thanks".split(
    ",",
  ),
);

const MAX_QUERY_CHARS = 500;
const MAX_CANDIDATES_FOR_JUDGE = 5;

function wordsOf(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9+_.-]*/g) ?? []).filter(
    (w) => w.length >= 4 && !STOPWORDS.has(w),
  );
}

/** Deterministic signal extraction from the persisted brief. Pure. */
export function extractSignals(brief: MatchBrief): BriefSignals {
  const identifiers = [
    ...new Set(
      (brief.findings.facts ?? [])
        .flatMap((f) => f.identifiers ?? [])
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t.length > 0 && t.length <= 40),
    ),
  ].slice(0, 12);
  const observations = (brief.findings.facts ?? [])
    .map((f) => f.observation.trim())
    .filter((o) => o.length > 0)
    .slice(0, 10);
  const corroborated = (brief.findings.corroborated ?? []).map((c) => c.pattern).slice(0, 6);
  const symptomTerms = [
    ...new Set([...observations, ...corroborated].flatMap(wordsOf)),
  ].slice(0, 24);
  return { identifiers, symptomTerms, observations };
}

/**
 * Bounded recall query: specific identifiers first, then symptom terms.
 * Empty when the brief carries no usable signal (no invented query).
 */
export function buildRecallQuery(signals: BriefSignals): string {
  const parts = [...signals.identifiers, ...signals.symptomTerms.slice(0, 10)];
  const q = parts.join(" ").trim().slice(0, MAX_QUERY_CHARS);
  return q;
}

export type ScoredCandidate = {
  card: MatchCard;
  score: number;
  identifierHits: string[];
  symptomHits: number;
};

/** Deterministic prefilter: specific-token overlap only. Pure. */
export function scoreCardText(signals: BriefSignals, cardText: string): Omit<ScoredCandidate, "card"> {
  const hay = cardText.toLowerCase();
  const identifierHits = signals.identifiers.filter((t) => t.length >= 2 && hay.includes(t));
  let symptomHits = 0;
  for (const term of signals.symptomTerms) {
    if (hay.includes(term)) symptomHits++;
  }
  return { score: identifierHits.length * 2 + symptomHits, identifierHits, symptomHits };
}

/**
 * Shortlist for the AI judge: needs ≥1 identifier hit (specific) or ≥3
 * symptom-term hits (converging). Generic-only overlap never passes.
 * Ranked by score, capped so the judge call stays bounded.
 */
export function prefilterCandidates(signals: BriefSignals, cards: MatchCard[]): ScoredCandidate[] {
  return cards
    .map((card) => ({ card, ...scoreCardText(signals, card.text) }))
    .filter((c) => c.identifierHits.length >= 1 || c.symptomHits >= 3)
    .sort((a, b) => b.score - a.score || (a.card.createdAt < b.card.createdAt ? 1 : -1))
    .slice(0, MAX_CANDIDATES_FOR_JUDGE);
}

/**
 * Tier mapping computed in code from card state + judge relevance — never
 * from model-claimed confidence. null = no recommendation stored.
 */
export function tierFor(card: MatchCard, relevance: "likely" | "possible" | "none"): MatchTier | null {
  if (relevance === "none") return null;
  if (relevance === "likely" && card.status === "shared" && card.resolved === true) {
    return "verified_fix";
  }
  if (relevance === "likely") return "documented_unverified";
  return "possible_match";
}

export type MatchFinding = {
  ref: string;
  relevance: "likely" | "possible" | "none";
  reasons: string[];
  matchingSymptoms: string[];
  differences: string[];
  unknowns: string[];
  applicable: boolean;
  warning: string;
};

const MAX_LIST = 6;
const MAX_TEXT = 300;

function str(v: unknown, max = MAX_TEXT): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().replace(/\s+/g, " ");
  if (!t) return null;
  return t.length > max ? t.slice(0, max) : t;
}

function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return (v as unknown[])
    .map((x) => str(x))
    .filter((x): x is string => x !== null)
    .slice(0, MAX_LIST);
}

/**
 * Strict validation of model output. Refs must be supplied candidate ids;
 * supporting reasons required for likely/possible; matching symptoms must
 * appear in the supplied evidence corpus (brief signals or card text).
 * Invalid entries are dropped, never stored. Returns the surviving list.
 */
export function validateMatchJudgment(
  raw: unknown,
  allowedRefs: ReadonlyMap<string, { cardText: string }>,
  corpus: string,
): MatchFinding[] {
  if (!raw || typeof raw !== "object") return [];
  const matches = (raw as Record<string, unknown>).matches;
  if (!Array.isArray(matches)) return [];
  const hay = corpus.toLowerCase();
  const out: MatchFinding[] = [];
  for (const m of matches.slice(0, MAX_CANDIDATES_FOR_JUDGE)) {
    if (!m || typeof m !== "object") continue;
    const o = m as Record<string, unknown>;
    const ref = typeof o.ref === "string" ? o.ref : "";
    if (!allowedRefs.has(ref)) continue; // invented reference — reject
    const relevance = o.relevance === "likely" || o.relevance === "possible" ? o.relevance : "none";
    if (relevance === "none") continue;
    const reasons = strList(o.reasons);
    if (reasons.length === 0) continue; // unsupported claim — reject
    const matchingSymptoms = strList(o.matchingSymptoms).filter((s) => hay.includes(s.toLowerCase()));
    if (relevance === "likely" && matchingSymptoms.length === 0) continue;
    const applicable = o.applicable === true;
    const warning = str(o.warning) ?? "";
    if (!applicable && !warning) continue; // must say why not applicable
    out.push({
      ref,
      relevance,
      reasons,
      matchingSymptoms,
      differences: strList(o.differences),
      unknowns: strList(o.unknowns),
      applicable,
      warning,
    });
  }
  return out;
}

// ---- Persistence (Neon; additive S8 table) ----

type Sql = <T = Record<string, unknown>[]>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<T>;

async function requireSql(): Promise<Sql> {
  const { dbAvailable } = await import("./db");
  if (!(await dbAvailable())) throw Object.assign(new Error("database unavailable"), { status: 503 });
  const { neon } = await import("@neondatabase/serverless");
  return neon(process.env.DATABASE_URL!.trim()) as unknown as Sql;
}

export type MatchPayload = {
  reasons: string[];
  matchingSymptoms: string[];
  differences: string[];
  unknowns: string[];
  applicable: boolean;
  warning: string;
  cardStatus: string;
  cardResolved: boolean | null;
  cardExcerpt: string;
  identifierHits: string[];
};

export type MatchRow = {
  id: string;
  incident_id: string;
  workspace_id: string;
  brief_fingerprint: string;
  brief_version: number;
  ref_kind: string;
  ref_id: string;
  tier: MatchTier;
  payload: MatchPayload;
  generated_at: string;
};

export type LatestMatches = { fingerprint: string; briefVersion: number; rows: MatchRow[] };

export type MatchStore = {
  loadForBrief: (incidentId: string, workspaceId: string, fingerprint: string) => Promise<MatchRow[]>;
  loadLatest: (incidentId: string, workspaceId: string) => Promise<LatestMatches | null>;
  saveMatches: (input: {
    incidentId: string;
    workspaceId: string;
    fingerprint: string;
    briefVersion: number;
    matches: { refId: string; tier: MatchTier; payload: MatchPayload }[];
  }) => Promise<void>;
  loadCards: (workspaceId: string) => Promise<MatchCard[]>;
  resolveCardsByBlobs: (workspaceId: string, blobIds: string[]) => Promise<Map<string, MatchCard>>;
};

function toRow(r: Record<string, unknown>): MatchRow {
  return {
    id: r.id as string,
    incident_id: r.incident_id as string,
    workspace_id: r.workspace_id as string,
    brief_fingerprint: r.brief_fingerprint as string,
    brief_version: r.brief_version as number,
    ref_kind: r.ref_kind as string,
    ref_id: r.ref_id as string,
    tier: r.tier as MatchTier,
    payload: (r.payload ?? {
      reasons: [],
      matchingSymptoms: [],
      differences: [],
      unknowns: [],
      applicable: false,
      warning: "",
      cardStatus: "",
      cardResolved: null,
      cardExcerpt: "",
      identifierHits: [],
    }) as MatchPayload,
    generated_at: r.generated_at as string,
  };
}

export async function realMatchStore(): Promise<MatchStore> {
  const sql = await requireSql();
  const toCard = (r: Record<string, unknown>): MatchCard => ({
    id: r.id as string,
    status: r.status as string,
    text: (r.text as string) ?? "",
    resolved: typeof r.resolved === "boolean" ? (r.resolved as boolean) : null,
    createdAt: r.created_at as string,
    blobId: (r.walrus_blob_id as string | null) ?? null,
  });
  return {
    loadForBrief: async (incidentId, workspaceId, fingerprint) => {
      const rows = (await sql`
        select id, incident_id, workspace_id, brief_fingerprint, brief_version,
               ref_kind, ref_id, tier, payload, generated_at
        from incident_fix_matches
        where incident_id = ${incidentId} and workspace_id = ${workspaceId}
          and brief_fingerprint = ${fingerprint}
        order by generated_at, id
      `) as unknown as Record<string, unknown>[];
      return rows.map(toRow);
    },
    loadLatest: async (incidentId, workspaceId) => {
      const rows = (await sql`
        select id, incident_id, workspace_id, brief_fingerprint, brief_version,
               ref_kind, ref_id, tier, payload, generated_at
        from incident_fix_matches
        where incident_id = ${incidentId} and workspace_id = ${workspaceId}
          and brief_fingerprint = (
            select brief_fingerprint from incident_fix_matches
            where incident_id = ${incidentId} and workspace_id = ${workspaceId}
            order by generated_at desc limit 1
          )
        order by generated_at, id
      `) as unknown as Record<string, unknown>[];
      if (rows.length === 0) return null;
      return {
        fingerprint: rows[0].brief_fingerprint as string,
        briefVersion: rows[0].brief_version as number,
        rows: rows.map(toRow),
      };
    },
    saveMatches: async (input) => {
      for (const m of input.matches) {
        await sql`
          insert into incident_fix_matches
            (incident_id, workspace_id, brief_fingerprint, brief_version, ref_kind, ref_id, tier, payload)
          values (${input.incidentId}, ${input.workspaceId}, ${input.fingerprint},
                  ${input.briefVersion}, 'fix_card', ${m.refId}, ${m.tier}, ${JSON.stringify(m.payload)}::jsonb)
          on conflict (incident_id, brief_fingerprint, ref_id) do nothing
        `;
      }
    },
    loadCards: async (workspaceId) => {
      // Authorized statuses only, same workspace. pending_review is
      // unreviewed, failed is unusable, superseded is replaced by its
      // revision (which surfaces under its own row when shared).
      const rows = (await sql`
        select fc.id, fc.status,
               coalesce(fc.reviewed_text, fc.candidate_text) as text,
               (si.status = 'resolved') as resolved,
               fc.created_at, fc.walrus_blob_id
        from fix_cards fc left join support_issues si on si.id = fc.issue_id
        where fc.workspace_id = ${workspaceId}
          and fc.status in ('shared', 'kept_private')
        order by fc.created_at desc limit 20
      `) as unknown as Record<string, unknown>[];
      return rows.filter((r) => typeof r.text === "string" && (r.text as string).trim()).map(toCard);
    },
    resolveCardsByBlobs: async (workspaceId, blobIds) => {
      const clean = [...new Set(blobIds.map((b) => b.trim()).filter(Boolean))].slice(0, 10);
      if (clean.length === 0) return new Map();
      // Workspace-scoped resolution: a shared-namespace hit surfaces ONLY
      // when its blob belongs to a usable card in THIS workspace. Other
      // tenants' shared cards never resolve here and are dropped.
      const rows = (await sql`
        select fc.id, fc.status,
               coalesce(fc.reviewed_text, fc.candidate_text) as text,
               (si.status = 'resolved') as resolved,
               fc.created_at, fc.walrus_blob_id
        from fix_cards fc left join support_issues si on si.id = fc.issue_id
        where fc.workspace_id = ${workspaceId}
          and fc.status in ('shared', 'kept_private')
          and fc.walrus_blob_id = any(${clean})
      `) as unknown as Record<string, unknown>[];
      const out = new Map<string, MatchCard>();
      for (const r of rows) {
        const card = toCard(r);
        if (card.blobId && card.text.trim()) out.set(card.blobId, card);
      }
      return out;
    },
  };
}

// ---- Refresh orchestration (read-only; never acts on matches) ----

export type MatchRecallHit = { text: string; blobId: string };

export type MatchJudge = (input: {
  observations: string[];
  identifiers: string[];
  unknowns: string[];
  candidates: { ref: string; status: string; resolved: boolean | null; text: string }[];
}) => Promise<unknown>;

export type MatchDeps = {
  loadBrief: (incidentId: string, workspaceId: string) => Promise<MatchBrief | null>;
  store: MatchStore;
  /** Shared-namespace recall only; throws/unavailable must not corrupt data. */
  recall: (query: string) => Promise<MatchRecallHit[]>;
  judge: MatchJudge;
};

export type RefreshResult =
  | { action: "unchanged" }
  | { action: "built"; count: number }
  | { action: "no_match" }
  | { action: "no_signals" }
  | { action: "deferred"; reason: string }
  | { action: "in_progress" }
  | { action: "failed"; error: string };

/** In-process single-flight per (incident, fingerprint): concurrent refreshes
 * for the same evidence collapse; a different fingerprint runs freely. */
const running = new Set<string>();

/**
 * Recompute matches iff the brief is current and no rows exist for its
 * fingerprint. Expensive work (recall + judge) runs only for fresh
 * evidence; recall failure degrades to Neon-only matching; judge failure
 * stores nothing so prior rows stay intact.
 */
export async function refreshMatchesIfNeeded(
  incidentId: string,
  workspaceId: string,
  deps: MatchDeps,
): Promise<RefreshResult> {
  let brief: MatchBrief | null;
  try {
    brief = await deps.loadBrief(incidentId, workspaceId);
  } catch {
    return { action: "deferred", reason: "brief read failed" };
  }
  if (!brief) return { action: "deferred", reason: "no evidence brief yet" };
  if (brief.status !== "current") {
    return { action: "deferred", reason: `brief is ${brief.status}` };
  }

  let existing: MatchRow[];
  try {
    existing = await deps.store.loadForBrief(incidentId, workspaceId, brief.fingerprint);
  } catch {
    return { action: "deferred", reason: "match read failed" };
  }
  if (existing.length > 0) return { action: "unchanged" };

  const signals = extractSignals(brief);
  const query = buildRecallQuery(signals);
  if (!query) return { action: "no_signals" };

  const lockKey = `${incidentId}:${brief.fingerprint}`;
  if (running.has(lockKey)) return { action: "in_progress" };
  running.add(lockKey);
  try {
    // Re-check after acquiring the lock: a concurrent refresh may have
    // finished while we waited on the brief read.
    try {
      const raced = await deps.store.loadForBrief(incidentId, workspaceId, brief.fingerprint);
      if (raced.length > 0) return { action: "unchanged" };
    } catch {
      return { action: "deferred", reason: "match read failed" };
    }

    let cards: MatchCard[];
    try {
      cards = await deps.store.loadCards(workspaceId);
    } catch {
      return { action: "deferred", reason: "fix-card read failed" };
    }

    // Shared-namespace recall enriches with cross-case phrasing; failure
    // degrades to Neon-only matching instead of failing the refresh.
    let recalled: MatchRecallHit[] = [];
    try {
      recalled = await deps.recall(query);
    } catch {
      recalled = [];
    }
    if (recalled.length > 0) {
      try {
        const byBlob = await deps.store.resolveCardsByBlobs(
          workspaceId,
          recalled.map((h) => h.blobId),
        );
        const seen = new Set(cards.map((c) => c.id));
        for (const hit of recalled) {
          const card = byBlob.get(hit.blobId);
          if (card && !seen.has(card.id)) {
            seen.add(card.id);
            cards.push(card);
          }
        }
      } catch {
        // Blob resolution failed — Neon candidates still stand.
      }
    }
    if (cards.length === 0) return { action: "no_match" };

    const shortlist = prefilterCandidates(signals, cards);
    if (shortlist.length === 0) return { action: "no_match" };

    const allowed = new Map(shortlist.map((s) => [s.card.id, { cardText: s.card.text }]));
    const corpus = [
      ...signals.observations,
      ...signals.identifiers,
      ...(brief.findings.unknowns ?? []),
      ...shortlist.map((s) => s.card.text),
    ].join("\n");
    let raw: unknown;
    try {
      raw = await deps.judge({
        observations: signals.observations,
        identifiers: signals.identifiers,
        unknowns: brief.findings.unknowns ?? [],
        candidates: shortlist.map((s) => ({
          ref: s.card.id,
          status: s.card.status,
          resolved: s.card.resolved,
          text: s.card.text.slice(0, 500),
        })),
      });
    } catch (e) {
      return { action: "failed", error: e instanceof Error ? e.message : "judge failed" };
    }
    const findings = validateMatchJudgment(raw, allowed, corpus);
    if (findings.length === 0) return { action: "no_match" };

    const byCard = new Map(shortlist.map((s) => [s.card.id, s.card]));
    const toSave: { refId: string; tier: MatchTier; payload: MatchPayload }[] = [];
    for (const f of findings) {
      const card = byCard.get(f.ref);
      if (!card) continue;
      const tier = tierFor(card, f.relevance);
      if (!tier) continue;
      toSave.push({
        refId: card.id,
        tier,
        payload: {
          reasons: f.reasons,
          matchingSymptoms: f.matchingSymptoms,
          differences: f.differences,
          unknowns: f.unknowns,
          applicable: f.applicable,
          warning: f.warning,
          cardStatus: card.status,
          cardResolved: card.resolved,
          cardExcerpt: card.text.slice(0, 300),
          identifierHits: shortlist.find((s) => s.card.id === card.id)?.identifierHits ?? [],
        },
      });
    }
    if (toSave.length === 0) return { action: "no_match" };
    try {
      await deps.store.saveMatches({
        incidentId,
        workspaceId,
        fingerprint: brief.fingerprint,
        briefVersion: brief.version,
        matches: toSave,
      });
    } catch {
      return { action: "deferred", reason: "match write failed" };
    }
    return { action: "built", count: toSave.length };
  } finally {
    running.delete(lockKey);
  }
}

/**
 * Production wiring for matching: persisted brief loader, Neon store,
 * shared-namespace recall with a wall-clock bound, and the Gemini judge.
 * Shared by the background scheduler, the explicit refresh route, and the
 * chat background refresh — one place, no duplicated wiring.
 */
export async function realMatchDeps(): Promise<MatchDeps> {
  const { geminiMatchJudge } = await import("./fix-matches-gemini");
  const { recallShared } = await import("./walrus");
  const { settleWithTimeout } = await import("./retry");
  const store = await realMatchStore();
  return {
    loadBrief: async (incidentId, workspaceId) => {
      const { getIncidentBrief } = await import("./evidence-brief");
      const row = await getIncidentBrief(incidentId, workspaceId);
      return row
        ? {
            status: row.status,
            version: row.version,
            fingerprint: row.fingerprint,
            findings: row.findings,
            source_count: row.source_count,
            generated_at: row.generated_at,
          }
        : null;
    },
    store,
    recall: async (query) => {
      const settled = await settleWithTimeout(recallShared(query, { topK: 5 }), 10_000);
      if (settled.status !== "ok") return [];
      return settled.value.results.map((h) => ({ text: h.text, blobId: h.blobId }));
    },
    judge: geminiMatchJudge(),
  };
}

/**
 * Fire-and-forget match refresh for route handlers. Must be called
 * synchronously inside request scope; no-ops (with a log) in tests or
 * when after() is unavailable. Never throws into the caller and never
 * delays customer-facing responses.
 */
export function scheduleMatchRefresh(incidentId: string, workspaceId: string): void {
  try {
    after(async () => {
      try {
        const { isGeminiConfigured } = await import("./env");
        if (!isGeminiConfigured()) return;
        await refreshMatchesIfNeeded(incidentId, workspaceId, await realMatchDeps());
      } catch {
        // Background intelligence must never break the operator action.
      }
    });
  } catch {
    // No request scope (tests, dev snippets): skip silently.
  }
}
