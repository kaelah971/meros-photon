import "server-only";
import { createHash } from "node:crypto";
import { after } from "next/server";

// S6 incident evidence briefs: durable, source-backed intelligence assembled
// automatically when real customer evidence lands on a confirmed incident.
// Every factual finding must cite authorized source message ids; anything
// uncited is rejected, never stored. Hypotheses are always labeled.

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

async function requireSql(): Promise<Sql> {
  const sql = await getSql();
  if (!sql) throw Object.assign(new Error("database unavailable"), { status: 503 });
  return sql;
}

export const MAX_SOURCE_MESSAGES = 100;
export const MAX_EXCERPT_CHARS = 500;
export const BRIEF_CLAIM_TIMEOUT_MS = 10 * 60 * 1000;

export type BriefStatus = "pending" | "current" | "stale" | "failed";

export type BriefSource = {
  messageId: string;
  conversationId: string;
  customerId: string;
  content: string;
  createdAt: string;
};

export type BriefFinding = {
  observation: string;
  identifiers: string[];
  sources: string[];
};

export type BriefCorroboration = {
  pattern: string;
  sources: string[];
};

export type BriefContradiction = {
  description: string;
  between: [string, string];
};

export type BriefHypothesis = {
  text: string;
  basedOn: string[];
};

export type BriefFindings = {
  facts: BriefFinding[];
  corroborated: BriefCorroboration[];
  contradictions: BriefContradiction[];
  unknowns: string[];
  hypotheses: BriefHypothesis[];
};

/** Message->conversation links for rendering supporting-evidence links. */
export async function briefSourceLinks(incidentId: string, workspaceId: string): Promise<{ messageId: string; conversationId: string }[]> {
  const sql = await requireSql();
  const rows = (await sql`
    select m.id as message_id, m.conversation_id from messages m
    join incident_conversations iv on iv.conversation_id = m.conversation_id
    join incidents i on i.id = iv.incident_id
    where iv.incident_id = ${incidentId} and i.workspace_id = ${workspaceId} and m.role = 'user'
    order by m.created_at limit 200
  `) as unknown as { message_id: string; conversation_id: string }[];
  return rows.map((r) => ({ messageId: r.message_id, conversationId: r.conversation_id }));
}

/** Read the current brief for display (null when none was ever built). */
export async function getIncidentBrief(incidentId: string, workspaceId: string): Promise<BriefRow | null> {
  const sql = await requireSql();
  const rows = (await sql`
    select incident_id, workspace_id, status, version, fingerprint, findings,
           source_count, generated_at, error, updated_at
    from incident_evidence_briefs
    where incident_id = ${incidentId} and workspace_id = ${workspaceId} limit 1
  `) as unknown as Record<string, unknown>[];
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    incident_id: r.incident_id as string,
    workspace_id: r.workspace_id as string,
    status: r.status as BriefStatus,
    version: r.version as number,
    fingerprint: r.fingerprint as string,
    findings: normalizeBriefFindings(r.findings),
    source_count: r.source_count as number,
    generated_at: (r.generated_at as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    updated_at: r.updated_at as string,
  };
}

export type BriefRow = {
  incident_id: string;
  workspace_id: string;
  status: BriefStatus;
  version: number;
  fingerprint: string;
  findings: BriefFindings;
  source_count: number;
  generated_at: string | null;
  error: string | null;
  updated_at: string;
};

/** Deterministic fingerprint of the exact source set. Pure. */
export function fingerprintSources(messageIds: string[]): string {
  const sorted = [...new Set(messageIds)].sort();
  return createHash("sha256").update(sorted.join("|"), "utf8").digest("hex").slice(0, 32);
}

const MAX_FACTS = 15;
const MAX_LIST = 10;
const MAX_TEXT = 500;

function str(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().replace(/\s+/g, " ");
  if (!t) return null;
  return t.length > max ? t.slice(0, max) : t;
}

function knownId(v: unknown, known: ReadonlySet<string>): string | null {
  return typeof v === "string" && known.has(v) ? v : null;
}

/**
 * Read-side normalization for persisted brief findings. The
 * incident_evidence_briefs.findings column defaults to '{}', and the
 * pending-claim insert omits findings — so a mid-build row carries an
 * empty object, NOT null, and `?? defaults` cannot save readers. Every
 * array field is coerced (missing/null/non-array → []) so a newly
 * accepted incident with a still-assembling brief renders empty states
 * instead of crashing on `facts.length`. Entries themselves are passed
 * through (writes are strictly validated); only the containers are fixed.
 */
export function normalizeBriefFindings(raw: unknown): BriefFindings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  return {
    facts: arr<BriefFinding>(r.facts),
    corroborated: arr<BriefCorroboration>(r.corroborated),
    contradictions: arr<BriefContradiction>(r.contradictions),
    unknowns: arr<string>(r.unknowns),
    hypotheses: arr<BriefHypothesis>(r.hypotheses),
  };
}

/**
 * Strict validation of model output. Every factual finding must cite only
 * authorized source ids; uncited/invented references invalidate that finding
 * (dropped, never stored). Hypotheses survive only as labeled guesses.
 * Returns null when nothing supportable remains.
 */
export function validateBriefFindings(
  raw: unknown,
  knownMessageIds: ReadonlySet<string>,
): BriefFindings | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const facts: BriefFinding[] = [];
  if (Array.isArray(r.facts)) {
    for (const f of r.facts.slice(0, MAX_FACTS)) {
      if (!f || typeof f !== "object") continue;
      const fo = f as Record<string, unknown>;
      const observation = str(fo.observation, MAX_TEXT);
      const sources = Array.isArray(fo.sources)
        ? [...new Set((fo.sources as unknown[]).map((s) => knownId(s, knownMessageIds)).filter((s): s is string => s !== null))]
        : [];
      const identifiers = Array.isArray(fo.identifiers)
        ? (fo.identifiers as unknown[]).filter((x): x is string => typeof x === "string").map((s) => s.trim().slice(0, 120)).filter(Boolean).slice(0, 8)
        : [];
      if (!observation || sources.length === 0) continue;
      facts.push({ observation, identifiers, sources });
    }
  }
  const corroborated: BriefCorroboration[] = [];
  if (Array.isArray(r.corroborated)) {
    for (const c of r.corroborated.slice(0, MAX_LIST)) {
      if (!c || typeof c !== "object") continue;
      const co = c as Record<string, unknown>;
      const pattern = str(co.pattern, MAX_TEXT);
      const sources = Array.isArray(co.sources)
        ? [...new Set((co.sources as unknown[]).map((s) => knownId(s, knownMessageIds)).filter((s): s is string => s !== null))]
        : [];
      if (!pattern || sources.length < 2) continue;
      corroborated.push({ pattern, sources });
    }
  }
  const contradictions: BriefContradiction[] = [];
  if (Array.isArray(r.contradictions)) {
    for (const c of r.contradictions.slice(0, MAX_LIST)) {
      if (!c || typeof c !== "object") continue;
      const co = c as Record<string, unknown>;
      const description = str(co.description, MAX_TEXT);
      const between = Array.isArray(co.between) ? co.between : [];
      const a = between.length > 0 ? knownId(between[0], knownMessageIds) : null;
      const b = between.length > 1 ? knownId(between[1], knownMessageIds) : null;
      if (!description || !a || !b || a === b) continue;
      contradictions.push({ description, between: [a, b] });
    }
  }
  const unknowns: string[] = Array.isArray(r.unknowns)
    ? (r.unknowns as unknown[])
        .map((u) => str(u, MAX_TEXT))
        .filter((u): u is string => u !== null)
        .slice(0, MAX_LIST)
    : [];
  const hypotheses: BriefHypothesis[] = [];
  if (Array.isArray(r.hypotheses)) {
    for (const h of r.hypotheses.slice(0, MAX_LIST)) {
      if (!h || typeof h !== "object") continue;
      const ho = h as Record<string, unknown>;
      const text = str(ho.text, MAX_TEXT);
      const basedOn = Array.isArray(ho.basedOn)
        ? [...new Set((ho.basedOn as unknown[]).map((s) => knownId(s, knownMessageIds)).filter((s): s is string => s !== null))]
        : [];
      if (!text || basedOn.length === 0) continue;
      hypotheses.push({ text, basedOn });
    }
  }
  if (facts.length === 0 && unknowns.length === 0) return null;
  return { facts, corroborated, contradictions, unknowns, hypotheses };
}

export type BriefStore = {
  loadBrief: (incidentId: string, workspaceId: string) => Promise<BriefRow | null>;
  insertPending: (incidentId: string, workspaceId: string, fingerprint: string, sourceCount: number) => Promise<boolean>;
  claimRebuild: (incidentId: string, workspaceId: string) => Promise<boolean>;
  markStale: (incidentId: string, workspaceId: string) => Promise<void>;
  completeBrief: (input: { incidentId: string; workspaceId: string; fingerprint: string; findings: BriefFindings; sourceCount: number }) => Promise<void>;
  failBrief: (incidentId: string, workspaceId: string, error: string) => Promise<void>;
  getSources: (incidentId: string, workspaceId: string) => Promise<BriefSource[]>;
};

export async function realBriefStore(): Promise<BriefStore> {
  const sql = await requireSql();
  const toRow = (r: Record<string, unknown>): BriefRow => ({
    incident_id: r.incident_id as string,
    workspace_id: r.workspace_id as string,
    status: r.status as BriefStatus,
    version: r.version as number,
    fingerprint: r.fingerprint as string,
    findings: normalizeBriefFindings(r.findings),
    source_count: r.source_count as number,
    generated_at: (r.generated_at as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    updated_at: r.updated_at as string,
  });
  return {
    loadBrief: async (incidentId, workspaceId) => {
      const rows = (await sql`
        select incident_id, workspace_id, status, version, fingerprint, findings,
               source_count, generated_at, error, updated_at
        from incident_evidence_briefs
        where incident_id = ${incidentId} and workspace_id = ${workspaceId} limit 1
      `) as unknown as Record<string, unknown>[];
      return rows[0] ? toRow(rows[0]) : null;
    },
    insertPending: async (incidentId, workspaceId, fingerprint, sourceCount) => {
      // Write explicit empty findings (never rely on the '{}' column
      // default): a pending row must already be render-safe if the builder
      // crashes before completing.
      const rows = (await sql`
        insert into incident_evidence_briefs (incident_id, workspace_id, status, version, fingerprint, findings, source_count)
        values (${incidentId}, ${workspaceId}, 'pending', 1, ${fingerprint}, ${JSON.stringify({ facts: [], corroborated: [], contradictions: [], unknowns: [], hypotheses: [] })}::jsonb, ${sourceCount})
        on conflict (incident_id) do nothing
        returning incident_id
      `) as unknown as { incident_id: string }[];
      return rows.length > 0;
    },
    claimRebuild: async (incidentId, workspaceId) => {
      const rows = (await sql`
        update incident_evidence_briefs
        set status = 'pending', updated_at = now()
        where incident_id = ${incidentId} and workspace_id = ${workspaceId}
          and (status != 'pending' or updated_at < now() - make_interval(secs => ${BRIEF_CLAIM_TIMEOUT_MS / 1000}))
        returning incident_id
      `) as unknown as { incident_id: string }[];
      return rows.length > 0;
    },
    markStale: async (incidentId, workspaceId) => {
      await sql`
        update incident_evidence_briefs set status = 'stale', updated_at = now()
        where incident_id = ${incidentId} and workspace_id = ${workspaceId} and status = 'current'
      `;
    },
    completeBrief: async (input) => {
      await sql`
        update incident_evidence_briefs
        set status = 'current', fingerprint = ${input.fingerprint},
            findings = ${JSON.stringify(input.findings)}::jsonb,
            source_count = ${input.sourceCount}, generated_at = now(), error = null,
            version = version + 1, updated_at = now()
        where incident_id = ${input.incidentId} and workspace_id = ${input.workspaceId}
      `;
    },
    failBrief: async (incidentId, workspaceId, error) => {
      await sql`
        update incident_evidence_briefs
        set status = 'failed', error = ${error.slice(0, 500)}, updated_at = now()
        where incident_id = ${incidentId} and workspace_id = ${workspaceId}
          and (status = 'pending' or fingerprint = '')
      `;
    },
    getSources: async (incidentId, workspaceId) => {
      const convs = (await sql`
        select iv.conversation_id from incident_conversations iv
        join incidents i on i.id = iv.incident_id
        where iv.incident_id = ${incidentId} and i.workspace_id = ${workspaceId}
        order by iv.added_at limit 20
      `) as unknown as { conversation_id: string }[];
      const out: BriefSource[] = [];
      for (const c of convs) {
        const msgs = (await sql`
          select m.id, m.conversation_id, c.customer_id, m.content, m.created_at
          from messages m join conversations c on c.id = m.conversation_id
          where m.conversation_id = ${c.conversation_id} and m.role = 'user'
            and c.workspace_id = ${workspaceId}
          order by m.created_at limit 25
        `) as unknown as { id: string; conversation_id: string; customer_id: string; content: string; created_at: string }[];
        for (const m of msgs) {
          if (out.length >= MAX_SOURCE_MESSAGES) break;
          const content = m.content.replace(/\s+/g, " ").trim().slice(0, MAX_EXCERPT_CHARS);
          if (content) out.push({ messageId: m.id, conversationId: m.conversation_id, customerId: m.customer_id, content, createdAt: m.created_at });
        }
        if (out.length >= MAX_SOURCE_MESSAGES) break;
      }
      return out;
    },
  };
}

export type BriefJudge = (input: {
  sources: { id: string; excerpt: string; conversationId: string; at: string }[];
}) => Promise<unknown>;

export type RefreshResult =
  | { action: "unchanged" }
  | { action: "built"; versionUp: boolean }
  | { action: "in_progress" }
  | { action: "deferred"; reason: string }
  | { action: "failed"; error: string };

/**
 * Fire-and-forget brief (re)build for route handlers. Must be called
 * synchronously inside request scope; no-ops (with a log) in tests or
 * when after() is unavailable. Never throws into the caller.
 */
export function scheduleBriefRefresh(incidentId: string, workspaceId: string): void {
  try {
    after(async () => {
      try {
        const store = await realBriefStore();
        const { geminiBriefJudge } = await import("./evidence-brief-gemini");
        const { isGeminiConfigured } = await import("./env");
        if (!isGeminiConfigured()) return;
        await refreshBriefIfNeeded(incidentId, workspaceId, { store, judge: geminiBriefJudge() });
      } catch {
        // Background intelligence must never break the operator action.
      }
    });
  } catch {
    // No request scope (tests, dev snippets): skip silently.
  }
}

/**
 * Rebuild the brief iff the source set changed. Concurrency-safe: only one
 * builder holds the pending claim; losers mark stale and step aside.
 * AI failure preserves prior briefs and records an honest failed state
 * only when nothing usable exists yet.
 */
export async function refreshBriefIfNeeded(
  incidentId: string,
  workspaceId: string,
  deps: { store: BriefStore; judge: BriefJudge },
): Promise<RefreshResult> {
  const store = deps.store;
  let sources: BriefSource[];
  try {
    sources = await store.getSources(incidentId, workspaceId);
  } catch {
    return { action: "deferred", reason: "source read failed" };
  }
  if (sources.length === 0) return { action: "deferred", reason: "no linked customer reports" };
  const fingerprint = fingerprintSources(sources.map((s) => s.messageId));

  let existing: BriefRow | null = null;
  try {
    existing = await store.loadBrief(incidentId, workspaceId);
  } catch {
    return { action: "deferred", reason: "brief read failed" };
  }

  if (existing && existing.status === "current" && existing.fingerprint === fingerprint) {
    return { action: "unchanged" };
  }
  if (!existing) {
    const inserted = await store.insertPending(incidentId, workspaceId, fingerprint, sources.length).catch(() => false);
    if (!inserted) return { action: "in_progress" };
  } else if (existing.status === "pending") {
    // Another builder holds a fresh claim — flag newer evidence, step aside.
    const freshPending = Date.now() - +new Date(existing.updated_at) < BRIEF_CLAIM_TIMEOUT_MS;
    if (freshPending) {
      if (existing.fingerprint !== fingerprint) await store.markStale(incidentId, workspaceId).catch(() => null);
      return { action: "in_progress" };
    }
    const claimed = await store.claimRebuild(incidentId, workspaceId).catch(() => false);
    if (!claimed) return { action: "in_progress" };
  } else {
    const claimed = await store.claimRebuild(incidentId, workspaceId).catch(() => false);
    if (!claimed) {
      await store.markStale(incidentId, workspaceId).catch(() => null);
      return { action: "in_progress" };
    }
  }

  let raw: unknown;
  try {
    raw = await deps.judge({
      sources: sources.map((s) => ({ id: s.messageId, excerpt: s.content, conversationId: s.conversationId, at: s.createdAt })),
    });
  } catch (e) {
    await store.failBrief(incidentId, workspaceId, e instanceof Error ? e.message : "judge failed").catch(() => null);
    return { action: "failed", error: "judge failed" };
  }
  const known = new Set(sources.map((s) => s.messageId));
  const findings = validateBriefFindings(raw, known);
  if (!findings) {
    await store.failBrief(incidentId, workspaceId, "judge returned no supportable findings").catch(() => null);
    return { action: "failed", error: "unusable judge output" };
  }
  try {
    await store.completeBrief({ incidentId, workspaceId, fingerprint, findings, sourceCount: sources.length });
  } catch {
    return { action: "deferred", reason: "brief write failed" };
  }
  return { action: "built", versionUp: true };
}
