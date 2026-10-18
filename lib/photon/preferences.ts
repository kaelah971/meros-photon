import "server-only";

// Photon S3 operator notification preferences: per (workspace, operator).
// Missing row = defaults (proactive ON, quiet hours OFF). All validation is
// pure and unit-tested; only validated values ever reach Neon.

type Sql = <T = Record<string, unknown>[]>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<T>;

async function getSql(): Promise<Sql | null> {
  const { dbAvailable } = await import("../db");
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

export type OperatorPreferences = {
  workspaceId: string;
  operatorUserId: string;
  proactiveEnabled: boolean;
  quietHoursEnabled: boolean;
  quietStart: string; // HH:MM 24h
  quietEnd: string; // HH:MM 24h
  timezone: string; // IANA
  /** S15B Incident Radar opt-in. Default FALSE; missing/false/unreadable means OFF. */
  radarEnabled: boolean;
};

export const DEFAULT_PREFERENCES: Omit<OperatorPreferences, "workspaceId" | "operatorUserId"> = {
  proactiveEnabled: true,
  quietHoursEnabled: false,
  quietStart: "22:00",
  quietEnd: "07:00",
  timezone: "Africa/Lagos",
  radarEnabled: false,
};

export const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function isValidTime(v: unknown): v is string {
  return typeof v === "string" && TIME_RE.test(v);
}

/** Strict IANA timezone check. Pure. Accepts exactly what Intl itself
 * accepts (constructor test), rather than the supportedValuesOf list,
 * which omits common aliases like `UTC` that DateTimeFormat handles. */
export function isValidTimezone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export type PreferencesInput = {
  proactiveEnabled: unknown;
  quietHoursEnabled: unknown;
  quietStart: unknown;
  quietEnd: unknown;
  timezone: unknown;
  /** Optional: absent means "leave unchanged" (PUT merges with stored row). */
  radarEnabled?: unknown;
};

/** Validate a PUT body. Returns the clean row or a human error. Pure.
 * radarEnabled is optional: absent means "leave unchanged" so unrelated
 * saves never reset the Radar opt-in. Present-but-not-boolean is an error. */
export function validatePreferences(input: PreferencesInput): {
  ok: true;
  value: Omit<OperatorPreferences, "workspaceId" | "operatorUserId" | "radarEnabled"> & { radarEnabled: boolean | null };
} | { ok: false; error: string } {
  if (typeof input.proactiveEnabled !== "boolean") {
    return { ok: false, error: "proactiveEnabled must be a boolean" };
  }
  if (typeof input.quietHoursEnabled !== "boolean") {
    return { ok: false, error: "quietHoursEnabled must be a boolean" };
  }
  if (!isValidTime(input.quietStart)) {
    return { ok: false, error: "quietStart must be HH:MM (24h)" };
  }
  if (!isValidTime(input.quietEnd)) {
    return { ok: false, error: "quietEnd must be HH:MM (24h)" };
  }
  if (input.quietStart === input.quietEnd) {
    return { ok: false, error: "quietStart and quietEnd must differ" };
  }
  if (!isValidTimezone(input.timezone)) {
    return { ok: false, error: "timezone must be a valid IANA timezone" };
  }
  if (input.radarEnabled !== undefined && typeof input.radarEnabled !== "boolean") {
    return { ok: false, error: "radarEnabled must be a boolean" };
  }
  return {
    ok: true,
    value: {
      proactiveEnabled: input.proactiveEnabled,
      quietHoursEnabled: input.quietHoursEnabled,
      quietStart: input.quietStart,
      quietEnd: input.quietEnd,
      timezone: input.timezone,
      radarEnabled: typeof input.radarEnabled === "boolean" ? input.radarEnabled : null,
    },
  };
}

/** Minutes since local midnight for `now` in `tz`. NaN when unparseable. */
export function localMinutesInZone(timezone: string, now: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "NaN");
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? "NaN");
  if (!Number.isInteger(h) || !Number.isInteger(m)) return NaN;
  return (h * 60 + m) % 1440;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/**
 * Quiet-hours evaluation. Pure and injectable (`now`) for deterministic tests.
 * Handles overnight windows (start > end). Invalid config fails OPEN (false):
 * writes are validated, so this only guards corrupt/legacy rows — blocking
 * sends on unreadable prefs would be a denial, not safety.
 */
export function isQuietNow(
  prefs: Pick<OperatorPreferences, "quietHoursEnabled" | "quietStart" | "quietEnd" | "timezone">,
  now: Date = new Date(),
): boolean {
  if (!prefs.quietHoursEnabled) return false;
  if (!isValidTime(prefs.quietStart) || !isValidTime(prefs.quietEnd)) return false;
  if (!isValidTimezone(prefs.timezone)) return false;
  const mins = localMinutesInZone(prefs.timezone, now);
  if (!Number.isInteger(mins)) return false;
  const s = toMinutes(prefs.quietStart);
  const e = toMinutes(prefs.quietEnd);
  if (s === e) return false;
  if (s < e) return mins >= s && mins < e;
  return mins >= s || mins < e; // overnight window
}

/** Read own prefs; missing row yields defaults (no write). */
export async function getPreferences(
  workspaceId: string,
  operatorUserId: string,
): Promise<OperatorPreferences> {
  const loaded = await loadPreferences(workspaceId, operatorUserId);
  if (!loaded.present || !loaded.valid) {
    // Missing row: documented defaults. Malformed row: display-safe
    // defaults here (no write); the SEND path distinguishes via
    // loadPreferences and suppresses instead of enforcing guesses.
    return { workspaceId, operatorUserId, ...DEFAULT_PREFERENCES };
  }
  return loaded.prefs;
}

export type StoredPreferencesState =
  | { present: false }
  | { present: true; valid: boolean; prefs: OperatorPreferences };

/**
 * Raw preference state for send-path decisions. Distinguishes the three
 * cases the notifier must treat differently: missing (defaults apply),
 * valid (enforce), malformed (suppress non-test sends, never guess).
 */
export async function loadPreferences(
  workspaceId: string,
  operatorUserId: string,
): Promise<StoredPreferencesState> {
  const sql = await requireSql();
  const rows = (await sql`
    select proactive_enabled, quiet_hours_enabled, quiet_start, quiet_end, timezone, radar_enabled
    from operator_preferences
    where workspace_id = ${workspaceId} and operator_user_id = ${operatorUserId}
    limit 1
  `) as unknown as {
    proactive_enabled: unknown;
    quiet_hours_enabled: unknown;
    quiet_start: unknown;
    quiet_end: unknown;
    timezone: unknown;
    radar_enabled: unknown;
  }[];
  const r = rows[0];
  if (!r) return { present: false };
  const prefs: OperatorPreferences = {
    workspaceId,
    operatorUserId,
    proactiveEnabled: r.proactive_enabled === true,
    quietHoursEnabled: r.quiet_hours_enabled === true,
    quietStart: typeof r.quiet_start === "string" ? r.quiet_start : "",
    quietEnd: typeof r.quiet_end === "string" ? r.quiet_end : "",
    timezone: typeof r.timezone === "string" ? r.timezone : "",
    radarEnabled: r.radar_enabled === true,
  };
  const valid =
    r.proactive_enabled === prefs.proactiveEnabled &&
    typeof r.proactive_enabled === "boolean" &&
    typeof r.quiet_hours_enabled === "boolean" &&
    isValidTime(prefs.quietStart) &&
    isValidTime(prefs.quietEnd) &&
    prefs.quietStart !== prefs.quietEnd &&
    isValidTimezone(prefs.timezone);
  return { present: true, valid, prefs };
}

/**
 * True only when a row EXISTS but fails validation. Missing row is NOT
 * malformed (defaults apply). Used by the send path to fail closed.
 */
export async function isStoredPreferencesMalformed(
  workspaceId: string,
  operatorUserId: string,
): Promise<boolean> {
  const loaded = await loadPreferences(workspaceId, operatorUserId);
  return loaded.present && !loaded.valid;
}

/**
 * S7 proactive foundation (default-disabled): bounded opt-in for FUTURE
 * automatic incident evidence notifications. Missing row or missing/false
 * value means OFF. Nothing in S7 consults this on any send path and no
 * automatic send exists — it is stored intent only, for S8+ to enforce
 * alongside the existing preference/quiet-hours gates if ever activated.
 */
export async function isEvidenceAutoNotifyEnabled(
  workspaceId: string,
  operatorUserId: string,
): Promise<boolean> {
  try {
    const sql = await requireSql();
    const rows = (await sql`
      select evidence_auto_notify from operator_preferences
      where workspace_id = ${workspaceId} and operator_user_id = ${operatorUserId}
      limit 1
    `) as unknown as { evidence_auto_notify: unknown }[];
    return rows[0]?.evidence_auto_notify === true;
  } catch {
    // Unreadable state fails OFF (default-disabled), never guessed on.
    return false;
  }
}

/** Atomic validated upsert. Caller enforces staff + self-ownership. */
export async function upsertPreferences(input: OperatorPreferences): Promise<OperatorPreferences> {
  const sql = await requireSql();
  const rows = (await sql`
    insert into operator_preferences
      (workspace_id, operator_user_id, proactive_enabled, quiet_hours_enabled, quiet_start, quiet_end, timezone, radar_enabled, updated_at)
    values (${input.workspaceId}, ${input.operatorUserId}, ${input.proactiveEnabled},
            ${input.quietHoursEnabled}, ${input.quietStart}, ${input.quietEnd}, ${input.timezone}, ${input.radarEnabled}, now())
    on conflict (workspace_id, operator_user_id) do update set
      proactive_enabled = excluded.proactive_enabled,
      quiet_hours_enabled = excluded.quiet_hours_enabled,
      quiet_start = excluded.quiet_start,
      quiet_end = excluded.quiet_end,
      timezone = excluded.timezone,
      radar_enabled = excluded.radar_enabled,
      updated_at = now()
    returning proactive_enabled, quiet_hours_enabled, quiet_start, quiet_end, timezone, radar_enabled
  `) as unknown as {
    proactive_enabled: boolean;
    quiet_hours_enabled: boolean;
    quiet_start: string;
    quiet_end: string;
    timezone: string;
    radar_enabled: boolean;
  }[];
  const r = rows[0];
  if (!r) throw new Error("preferences upsert failed");
  return {
    workspaceId: input.workspaceId,
    operatorUserId: input.operatorUserId,
    proactiveEnabled: r.proactive_enabled,
    quietHoursEnabled: r.quiet_hours_enabled,
    quietStart: r.quiet_start,
    quietEnd: r.quiet_end,
    timezone: r.timezone,
    radarEnabled: r.radar_enabled === true,
  };
}

/**
 * S15B Incident Radar opt-in. TRUE only when a row explicitly stores true.
 * Missing row, false, unreadable state, or pre-migration schema (no
 * column) all mean OFF — never guessed on. Callers treat OFF as "no
 * automatic alerts for this operator".
 */
export async function isRadarEnabled(
  workspaceId: string,
  operatorUserId: string,
): Promise<boolean> {
  try {
    const sql = await requireSql();
    const rows = (await sql`
      select radar_enabled from operator_preferences
      where workspace_id = ${workspaceId} and operator_user_id = ${operatorUserId}
      limit 1
    `) as unknown as { radar_enabled: unknown }[];
    return rows[0]?.radar_enabled === true;
  } catch {
    // Unreadable state (including a schema without the column) fails OFF.
    return false;
  }
}

/**
 * Operators who explicitly opted into Incident Radar in one workspace.
 * Used for recipient selection; each operator is still gated on binding,
 * staff access, preferences, and quiet hours before any send.
 */
export async function listRadarOptedIn(workspaceId: string): Promise<string[]> {
  try {
    const sql = await requireSql();
    const rows = (await sql`
      select operator_user_id from operator_preferences
      where workspace_id = ${workspaceId} and radar_enabled = true
      order by updated_at desc limit 25
    `) as unknown as { operator_user_id: string }[];
    return [...new Set(rows.map((r) => r.operator_user_id).filter((id) => typeof id === "string" && id))];
  } catch {
    // Unreadable state means no recipients — fail closed, never broadcast.
    return [];
  }
}
