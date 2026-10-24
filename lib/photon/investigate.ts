import "server-only";

// S15C iMessage Muse Router — read-only investigation over persisted
// S4–S11 records. Pure command parsing + deterministic reply builders;
// all data comes from injected reads so the exact authorization and
// dedupe decisions stay unit-testable. Nothing here mutates, approves,
// executes, messages customers, or closes anything.
//
// Safety: inbound text is untrusted. References resolve only against
// bounded workspace-scoped records (exact UUID or unambiguous short
// prefix). Every factual claim cites a stored record; missing or stale
// data is labeled honestly, never regenerated or invented.

export const MAX_REPLY_CHARS = 1500;
export const RADAR_ALERT_WINDOW_HOURS = 24;

export type RouterIntent =
  | { kind: "help" }
  | { kind: "incidents" }
  | { kind: "alerts" }
  | { kind: "show" }
  | { kind: "investigate"; ref: string }
  | { kind: "evidence"; ref: string }
  | { kind: "matches"; ref: string }
  | { kind: "decisions" };

const REF = String.raw`([A-Za-z0-9][A-Za-z0-9-]{3,63})`;
const OPT_SLASH = String.raw`^\s*\/?\s*`;

function cmd(re: string): RegExp {
  return new RegExp(OPT_SLASH + "(?:" + re + ")" + String.raw`\s*$`, "i");
}

/**
 * Narrow deterministic aliases only — no free-form routing.
 * `show` alone means "show me" (Radar context); with a reference it means
 * investigate. `incident <ref>` / `candidate <ref>` are investigate aliases.
 */
export function parseRouterIntent(text: string): RouterIntent | null {
  const t = text.trim();
  if (cmd(String.raw`(?:help|\?|commands)`).test(t)) return { kind: "help" };
  if (cmd(String.raw`(?:incidents|list)`).test(t)) return { kind: "incidents" };
  if (cmd(String.raw`alerts`).test(t)) return { kind: "alerts" };
  if (cmd(String.raw`show\s+me|show`).test(t)) return { kind: "show" };
  if (cmd(String.raw`decisions|todo|reviews`).test(t)) return { kind: "decisions" };
  let m = new RegExp(OPT_SLASH + String.raw`(?:investigate|incident|candidate)\s+` + REF + String.raw`\s*$`, "i").exec(t);
  if (m) return { kind: "investigate", ref: m[1] };
  m = new RegExp(OPT_SLASH + String.raw`show\s+` + REF + String.raw`\s*$`, "i").exec(t);
  if (m) return { kind: "investigate", ref: m[1] };
  m = new RegExp(OPT_SLASH + String.raw`(?:evidence|brief)\s+` + REF + String.raw`\s*$`, "i").exec(t);
  if (m) return { kind: "evidence", ref: m[1] };
  m = new RegExp(OPT_SLASH + String.raw`(?:matches|history)\s+` + REF + String.raw`\s*$`, "i").exec(t);
  if (m) return { kind: "matches", ref: m[1] };
  return null;
}

export function shortRef(id: string): string {
  return id.slice(0, 8);
}

// ---- iMessage formatting + links (single shared seam) ----

const DEFAULT_PUBLIC_ORIGIN = "https://meros-photon.vercel.app";

/** Trusted canonical origin for staff-console links. Env-overridable, https-only — never model or user input. */
export function consoleOrigin(): string {
  const raw = (process.env.MEROS_PUBLIC_ORIGIN ?? "").trim().replace(/\/+$/, "");
  if (/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?$/.test(raw)) return raw;
  return DEFAULT_PUBLIC_ORIGIN;
}

/** Absolute staff-console URL — iMessage cannot use relative paths. Already-absolute https URLs pass through untouched. */
export function publicLink(path: string): string {
  if (/^https:\/\//i.test(path.trim())) return path.trim();
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${consoleOrigin()}${p}`;
}

/**
 * Normalize reply text for narrow phone screens WITHOUT destroying
 * meaning: intentional paragraph breaks survive, spaces/tabs inside a
 * line collapse, CRLF is safe, runs of blank lines become one, control
 * characters and leading/trailing blank lines go. Bullets and
 * punctuation are untouched.
 */
export function formatMessageBody(text: string): string {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) =>
      l
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
        .replace(/[\t ]+/g, " ")
        .trim(),
    );
  const out: string[] = [];
  let blanks = 0;
  for (const l of lines) {
    if (!l) {
      blanks++;
      if (out.length > 0 && blanks <= 1) out.push("");
      continue;
    }
    blanks = 0;
    out.push(l);
  }
  while (out.length > 0 && !out[out.length - 1]) out.pop();
  return out.join("\n");
}

/**
 * Shorten to max chars at a word boundary, never inside a URL (a link
 * the cut would split is dropped whole instead of left half-clickable).
 */
export function truncateClean(text: string, max: number, ellipsis = true): string {
  const t = text.trimEnd();
  if (t.length <= max || max <= 0) return max <= 0 ? "" : t;
  const spans: [number, number][] = [];
  const re = /https?:\/\/\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) spans.push([m.index, m.index + m[0].length]);
  let cut = max;
  while (cut > 0 && !/\s/.test(t[cut]!)) cut--;
  if (cut <= 0) cut = max;
  for (const [s, e] of spans) {
    if (cut > s && cut < e) {
      cut = s;
      break;
    }
  }
  const body = t.slice(0, cut).trimEnd();
  if (!body) return ellipsis ? `${t.slice(0, Math.max(0, max - 1)).trimEnd()}…` : t.slice(0, max).trimEnd();
  return ellipsis ? `${body}…` : body;
}

/** Paragraph-safe cap for phone readability; never truncates mid-link. Link is absolute (iMessage-safe). */
export function fitReply(text: string, link: string): string {
  const body = formatMessageBody(text);
  if (body.length <= MAX_REPLY_CHARS) return body;
  const full = publicLink(link);
  const suffix = `\n… (full detail: ${full})`;
  return truncateClean(body, MAX_REPLY_CHARS - suffix.length, false) + suffix;
}

export function helpText(): string {
  return [
    "Meros commands (send `help` anytime):",
    `incidents — recent active incidents`,
    `alerts — candidates awaiting review`,
    `show me — investigate your latest Radar alert`,
    `investigate <ref> — candidate or incident summary`,
    `evidence <ref> — current evidence brief`,
    `matches <ref> — historical fix matches`,
    `decisions — outstanding review work`,
    `stats — workspace stats`,
    `Replies are read-only summaries. Review and act in the web console.`,
  ].join("\n");
}

// ---- Read models (injected) ----

export type CandidateView = {
  id: string;
  title: string;
  summary: string;
  status: string;
  confidence: string;
  rationale: string;
  acceptedIncidentId: string | null;
  conversations: number;
  customers: number;
  messages: number;
  updatedAt: string;
};

export type IncidentView = {
  id: string;
  title: string;
  status: string;
  severity: string;
  customers: number;
  conversations: number;
  evidence: number;
  updatedAt: string;
};

export type BriefView = {
  status: string;
  version: number;
  fingerprint: string;
  generatedAt: string | null;
  facts: { observation: string; sources: string[] }[];
  unknowns: string[];
  contradictions: string[];
};

export type PlanSummaryView = {
  version: number;
  status: string;
  riskLevel: string;
  stepCount: number;
  topSteps: string[];
  fingerprint: string;
};

export type MatchView = {
  refId: string;
  tier: string;
  reasons: string[];
  symptoms: string[];
  applicable: boolean;
  warning: string;
  cardStatus: string;
  cardResolved: boolean | null;
  excerpt: string;
};

export type DecisionItem = {
  kind: "candidate" | "approval" | "execution" | "watch" | "plan";
  label: string;
  ref: string;
};

export type RadarAlertView = { candidateId: string; createdAt: string };

export type InvestigateReads = {
  workspaceSlug: (workspaceId: string) => Promise<string | null>;
  listActiveIncidents: (workspaceId: string) => Promise<IncidentView[]>;
  listReviewCandidates: (workspaceId: string) => Promise<CandidateView[]>;
  getCandidate: (incidentId: string, workspaceId: string) => Promise<CandidateView | null>;
  getIncident: (incidentId: string, workspaceId: string) => Promise<IncidentView | null>;
  getBrief: (incidentId: string, workspaceId: string) => Promise<BriefView | null>;
  getMatches: (incidentId: string, workspaceId: string) => Promise<{ current: boolean; fingerprint: string | null; rows: MatchView[] }>;
  /** Latest active recovery-plan draft, if any. Optional: callers degrade without it. */
  getPlan?: (incidentId: string, workspaceId: string) => Promise<PlanSummaryView | null>;  listDecisions: (workspaceId: string) => Promise<DecisionItem[]>;
  recentRadarAlerts: (workspaceId: string, operatorUserId: string) => Promise<RadarAlertView[]>;
};

export type RefTarget = { kind: "candidate" | "incident"; id: string; title: string } | { kind: "ambiguous"; options: { kind: "candidate" | "incident"; id: string; title: string }[] } | { kind: "unknown" };

/**
 * Resolve a user-typed reference against bounded workspace records.
 * Exact UUID wins; otherwise a short prefix must match exactly one record
 * across both kinds. Anything else is unknown/ambiguous — never guessed.
 */
export function resolveReference(
  raw: string,
  candidates: { id: string; title: string }[],
  incidents: { id: string; title: string }[],
): RefTarget {
  const ref = raw.trim().toLowerCase();
  if (!/^[a-z0-9-]{4,64}$/i.test(ref)) return { kind: "unknown" };
  const exactC = candidates.find((c) => c.id.toLowerCase() === ref);
  if (exactC) return { kind: "candidate", id: exactC.id, title: exactC.title };
  const exactI = incidents.find((i) => i.id.toLowerCase() === ref);
  if (exactI) return { kind: "incident", id: exactI.id, title: exactI.title };
  const cands = candidates.filter((c) => c.id.toLowerCase().startsWith(ref));
  const incs = incidents.filter((i) => i.id.toLowerCase().startsWith(ref));
  const all = [
    ...cands.map((c) => ({ kind: "candidate" as const, id: c.id, title: c.title })),
    ...incs.map((i) => ({ kind: "incident" as const, id: i.id, title: i.title })),
  ];
  if (all.length === 1) return all[0];
  if (all.length > 1) return { kind: "ambiguous", options: all.slice(0, 5) };
  return { kind: "unknown" };
}

function fmtDate(iso: string | null): string {
  if (!iso) return "unknown time";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "unknown time";
  return new Date(t).toLocaleString();
}

export function candidateLink(slug: string, id: string): string {
  return publicLink(`/app/workspaces/${slug}/incidents/detected/${id}`);
}

export function incidentLink(slug: string, id: string): string {
  return publicLink(`/app/workspaces/${slug}/incidents/${id}`);
}

export function evidenceLink(slug: string, id: string): string {
  return publicLink(`/app/workspaces/${slug}/incidents/${id}/evidence`);
}

// ---- Reply builders (pure) ----

export function incidentsReply(slug: string, rows: IncidentView[]): string {
  if (rows.length === 0) return "No active incidents right now. Candidates awaiting review: reply `alerts`.";
  const lines = [`Active incidents (${rows.length}):`];
  for (const r of rows.slice(0, 5)) {
    lines.push(`• ${r.title.slice(0, 80)} [${r.status}, ${r.severity}] #${shortRef(r.id)}`);
  }
  lines.push(`Reply \`investigate <ref>\` for detail.`);
  return fitReply(lines.join("\n"), incidentLink(slug, rows[0].id));
}

export function alertsReply(slug: string, rows: CandidateView[]): string {
  const pending = rows.filter((r) => r.status === "pending");
  if (pending.length === 0) return "No candidates awaiting review. Recent incidents: reply `incidents`.";
  const lines = [`Reviewable candidates (${pending.length}) — all UNCONFIRMED:`];
  for (const r of pending.slice(0, 5)) {
    lines.push(`• ${r.title.slice(0, 80)} — ${r.conversations} convos, ${r.customers} customers #${shortRef(r.id)}`);
  }
  lines.push(`Reply \`investigate <ref>\`. Nothing here is confirmed.`);
  return fitReply(lines.join("\n"), candidateLink(slug, pending[0].id));
}

export function candidateSummaryReply(slug: string, c: CandidateView, radarContext: boolean): string {
  const head = radarContext ? `Your Radar alert (UNCONFIRMED): ${c.title}` : `Possible issue (UNCONFIRMED): ${c.title}`;
  const lines = [
    head,
    `${c.conversations} conversations · ${c.customers} customers · last seen ${fmtDate(c.updatedAt)}`,
    `Grouping confidence: ${c.confidence} (estimate only)`,
  ];
  if (c.summary.trim()) lines.push(`Why grouped: ${c.summary.slice(0, 300)}`);
  lines.push(`Review: ${candidateLink(slug, c.id)}`, `No recovery has been performed.`);
  return fitReply(lines.join("\n"), candidateLink(slug, c.id));
}

export function incidentSummaryReply(
  slug: string,
  i: IncidentView,
  brief: BriefView | null,
  matchCount: number,
): string {
  const lines = [`Incident: ${i.title.slice(0, 120)} [${i.status}, ${i.severity}]`];
  lines.push(`Affected: ${i.customers} customers · ${i.conversations} conversations · ${i.evidence} evidence refs`);
  if (!brief) {
    lines.push(`Evidence: no brief yet.`);
  } else if (brief.status !== "current") {
    lines.push(`Evidence: brief is ${brief.status} (v${brief.version}) — not current, treat findings as outdated.`);
  } else {
    lines.push(`Brief: current v${brief.version} (fp ${brief.fingerprint.slice(0, 8)})`);
    for (const f of brief.facts.slice(0, 3)) lines.push(`• ${f.observation.slice(0, 120)}`);
    if (brief.unknowns.length > 0) lines.push(`Unknowns: ${brief.unknowns.slice(0, 2).join("; ").slice(0, 160)}`);
    if (brief.contradictions.length > 0) lines.push(`Conflicts in evidence: ${brief.contradictions.slice(0, 2).join("; ").slice(0, 160)}`);
  }
  if (matchCount > 0) lines.push(`History: ${matchCount} past case(s) matched — see \`matches ${shortRef(i.id)}\`.`);
  lines.push(`Open: ${incidentLink(slug, i.id)}`);
  return fitReply(lines.join("\n"), incidentLink(slug, i.id));
}

export function evidenceReply(slug: string, incidentId: string, title: string, brief: BriefView | null): string {
  if (!brief) {
    return fitReply(
      `No evidence brief for "${title.slice(0, 80)}" yet. Link customer reports first — nothing to summarize.`,
      incidentLink(slug, incidentId),
    );
  }
  if (brief.status !== "current") {
    return fitReply(
      `Evidence for "${title.slice(0, 80)}" is ${brief.status} (v${brief.version}) — NOT current. Newer reports arrived; check the web console before relying on this.`,
      incidentLink(slug, incidentId),
    );
  }
  const lines = [`Evidence — ${title.slice(0, 80)} (current v${brief.version}):`];
  for (const f of brief.facts.slice(0, 5)) {
    const src = f.sources.length > 0 ? ` [${f.sources.map((s) => s.slice(0, 8)).join(", ")}]` : "";
    lines.push(`• ${f.observation.slice(0, 140)}${src}`);
  }
  if (brief.unknowns.length > 0) lines.push(`Unknowns: ${brief.unknowns.slice(0, 3).join(" · ").slice(0, 200)}`);
  if (brief.contradictions.length > 0) lines.push(`Conflicts: ${brief.contradictions.slice(0, 2).join(" · ").slice(0, 200)}`);
  lines.push(`Full brief: ${evidenceLink(slug, incidentId)}`);
  return fitReply(lines.join("\n"), evidenceLink(slug, incidentId));
}

function tierLabel(tier: string): string {
  if (tier === "verified_fix") return "VERIFIED HISTORICAL FIX";
  if (tier === "documented_unverified") return "DOCUMENTED BUT UNVERIFIED";
  return "POSSIBLE MATCH";
}

export function matchesReply(
  slug: string,
  incidentId: string,
  title: string,
  current: boolean,
  fingerprint: string | null,
  rows: MatchView[],
): string {
  if (rows.length === 0) {
    return fitReply(
      `No historical matches stored for "${title.slice(0, 80)}". Absence of matches is not proof of novelty.`,
      incidentLink(slug, incidentId),
    );
  }
  const lines = [
    `Historical matches for "${title.slice(0, 80)}"${current ? ` (brief fp ${(fingerprint ?? "").slice(0, 8)}, current)` : " (STALE — recompute before relying)"}:`,
  ];
  for (const m of rows.slice(0, 4)) {
    const bits = [`[${tierLabel(m.tier)}] fix ${m.refId.slice(0, 8)}`];
    if (m.cardResolved === true) bits.push("issue resolved");
    if (m.cardResolved === false) bits.push("issue still open");
    if (m.reasons[0]) bits.push(m.reasons[0].slice(0, 120));
    if (m.tier !== "verified_fix") bits.push("lead, not prescription");
    if (!m.applicable && m.warning) bits.push(`not directly applicable: ${m.warning.slice(0, 100)}`);
    lines.push(`• ${bits.join(" · ")}`);
  }
  lines.push(`Past success does not prove today's cause.`);
  return fitReply(lines.join("\n"), incidentLink(slug, incidentId));
}

export function decisionsReply(slug: string, items: DecisionItem[]): string {
  if (items.length === 0) return "Nothing awaiting review. Candidates: `alerts`. Incidents: `incidents`.";
  const lines = [`Outstanding review work (${items.length}):`];
  for (const d of items.slice(0, 8)) lines.push(`• ${d.label}`);
  lines.push(`Decisions happen in the web console — nothing is acted on from here.`);
  void slug;
  return fitReply(lines.join("\n"), publicLink(`/app/workspaces/${slug}/incidents`));
}

export function ambiguousReply(ref: string, options: { kind: "candidate" | "incident"; id: string; title: string }[]): string {
  const lines = [`Multiple records match "${ref.slice(0, 24)}" — reply with the full reference:`];
  for (const o of options) lines.push(`• ${o.kind} "${o.title.slice(0, 60)}" #${shortRef(o.id)} (${o.id})`);
  return lines.join("\n").slice(0, MAX_REPLY_CHARS);
}

export function unknownRefReply(ref: string): string {
  return `No candidate or incident matches "${ref.slice(0, 32)}" in this workspace. Try \`alerts\` or \`incidents\`.`;
}
