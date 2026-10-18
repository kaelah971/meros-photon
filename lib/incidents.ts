import "server-only";

// S4 Incident Center domain: persistent incidents + lifecycle + timeline.
// All reads/writes are workspace-scoped by ID; callers enforce requireStaff.
// Associations only ever point at EXISTING records in the SAME workspace —
// nothing is fabricated, and evidence refs preserve source identity.

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

export const INCIDENT_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

export const INCIDENT_STATUSES = [
  "detected",
  "investigating",
  "ready_for_action",
  "recovering",
  "monitoring",
  "resolved",
  "dismissed",
  "merged",
  "split",
] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const TERMINAL_STATUSES: readonly IncidentStatus[] = [
  "resolved",
  "dismissed",
  "merged",
  "split",
];

/**
 * Explicit transition map. Anything absent is rejected (fail-closed).
 * resolved may reopen to investigating; dismissed/merged/split are final.
 * 'merged' is allowed from any active state (target linkage validated
 * separately); 'split' is NOT a transition target — splitting always goes
 * through the explicit split action, which creates the child incident.
 */
const ALLOWED: Record<IncidentStatus, readonly IncidentStatus[]> = {
  detected: ["investigating", "merged", "dismissed"],
  investigating: ["ready_for_action", "merged", "dismissed"],
  ready_for_action: ["recovering", "merged", "dismissed"],
  recovering: ["monitoring", "merged", "dismissed"],
  monitoring: ["resolved", "recovering", "merged", "dismissed"],
  resolved: ["investigating"],
  dismissed: [],
  merged: [],
  split: [],
};

/** Pure: is this lifecycle step allowed? */
export function canTransition(from: IncidentStatus, to: IncidentStatus): boolean {
  if (from === to) return false;
  return (ALLOWED[from] ?? []).includes(to);
}

/** Pure: merge needs a real target; split children are created by the action. */
export function validateTransition(
  from: IncidentStatus,
  to: IncidentStatus,
  opts?: { mergedIntoIncidentId?: string | null },
): { ok: true } | { ok: false; error: string } {
  if (!(INCIDENT_STATUSES as readonly string[]).includes(to)) {
    return { ok: false, error: `unknown status '${to}'` };
  }
  if (!canTransition(from, to)) {
    return { ok: false, error: `cannot move from ${from} to ${to}` };
  }
  if (to === "merged" && !opts?.mergedIntoIncidentId) {
    return { ok: false, error: "merge requires a target incident" };
  }
  if (to !== "merged" && opts?.mergedIntoIncidentId) {
    return { ok: false, error: "merge target is only valid when merging" };
  }
  return { ok: true };
}

export type IncidentRow = {
  id: string;
  workspace_id: string;
  title: string;
  description: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  resolution_summary: string | null;
  resolved_at: string | null;
  merged_into_incident_id: string | null;
  split_from_incident_id: string | null;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
};

export type IncidentSummary = IncidentRow & {
  customer_count: number;
  conversation_count: number;
  evidence_count: number;
};

export type IncidentCustomerRow = { customer_id: string; display_name: string | null; added_at: string };
export type IncidentConversationRow = {
  conversation_id: string;
  title: string;
  status: string;
  customer_display: string | null;
  added_at: string;
};
export type IncidentEvidenceRow = {
  id: string;
  kind: string;
  ref_conversation_id: string | null;
  ref_message_id: string | null;
  ref_fix_card_id: string | null;
  ref_knowledge_id: string | null;
  label: string;
  note: string;
  created_at: string;
};
export type IncidentEventRow = {
  id: string;
  kind: string;
  actor_user_id: string | null;
  detail: Record<string, unknown>;
  created_at: string;
};

export async function recordEvent(input: {
  incidentId: string;
  kind: string;
  actorUserId?: string | null;
  detail?: Record<string, unknown>;
}): Promise<void> {
  const sql = await requireSql();
  await sql`
    insert into incident_events (incident_id, kind, actor_user_id, detail)
    values (${input.incidentId}, ${input.kind}, ${input.actorUserId ?? null},
            ${JSON.stringify(input.detail ?? {})})
  `;
}

/** Create an incident (operator-controlled only). Titles are required. */
export async function createIncident(input: {
  workspaceId: string;
  title: string;
  description?: string | null;
  severity?: IncidentSeverity | null;
  createdByUserId?: string | null;
  initialConversationIds?: string[];
}): Promise<IncidentRow> {
  const title = input.title.trim().replace(/\s+/g, " ").slice(0, 160);
  if (!title) throw Object.assign(new Error("title is required"), { status: 400 });
  const severity = input.severity ?? "medium";
  if (!(INCIDENT_SEVERITIES as readonly string[]).includes(severity)) {
    throw Object.assign(new Error("unknown severity"), { status: 400 });
  }
  const description = (input.description ?? "").trim().slice(0, 4000);
  const sql = await requireSql();
  const rows = (await sql`
    insert into incidents (workspace_id, title, description, severity, status, created_by_user_id)
    values (${input.workspaceId}, ${title}, ${description}, ${severity}, 'detected', ${input.createdByUserId ?? null})
    returning id, workspace_id, title, description, severity, status,
      resolution_summary, resolved_at, merged_into_incident_id, split_from_incident_id,
      created_by_user_id, created_at, updated_at
  `) as unknown as IncidentRow[];
  const row = rows[0];
  if (!row) throw new Error("incident insert failed");
  await recordEvent({
    incidentId: row.id,
    kind: "created",
    actorUserId: input.createdByUserId ?? null,
    detail: { title, severity },
  });
  for (const conversationId of input.initialConversationIds ?? []) {
    await addIncidentConversation({
      incidentId: row.id,
      workspaceId: input.workspaceId,
      conversationId,
      actorUserId: input.createdByUserId ?? null,
    });
  }
  return row;
}

export async function getIncidentForWorkspace(
  workspaceId: string,
  incidentId: string,
): Promise<IncidentSummary | null> {
  const sql = await requireSql();
  const rows = (await sql`
    select i.id, i.workspace_id, i.title, i.description, i.severity, i.status,
           i.resolution_summary, i.resolved_at, i.merged_into_incident_id,
           i.split_from_incident_id, i.created_by_user_id, i.created_at, i.updated_at,
      (select count(*)::int from incident_customers ic where ic.incident_id = i.id) as customer_count,
      (select count(*)::int from incident_conversations iv where iv.incident_id = i.id) as conversation_count,
      (select count(*)::int from incident_evidence ie where ie.incident_id = i.id) as evidence_count
    from incidents i
    where i.id = ${incidentId} and i.workspace_id = ${workspaceId}
    limit 1
  `) as unknown as IncidentSummary[];
  return rows[0] ?? null;
}

export async function listIncidents(
  workspaceId: string,
  status?: IncidentStatus | null,
): Promise<IncidentSummary[]> {
  const sql = await requireSql();
  if (status) {
    if (!(INCIDENT_STATUSES as readonly string[]).includes(status)) {
      throw Object.assign(new Error("unknown status"), { status: 400 });
    }
    return (await sql`
      select i.id, i.workspace_id, i.title, i.description, i.severity, i.status,
             i.resolution_summary, i.resolved_at, i.merged_into_incident_id,
             i.split_from_incident_id, i.created_by_user_id, i.created_at, i.updated_at,
        (select count(*)::int from incident_customers ic where ic.incident_id = i.id) as customer_count,
        (select count(*)::int from incident_conversations iv where iv.incident_id = i.id) as conversation_count,
        (select count(*)::int from incident_evidence ie where ie.incident_id = i.id) as evidence_count
      from incidents i
      where i.workspace_id = ${workspaceId} and i.status = ${status}
      order by i.updated_at desc limit 200
    `) as unknown as IncidentSummary[];
  }
  return (await sql`
    select i.id, i.workspace_id, i.title, i.description, i.severity, i.status,
           i.resolution_summary, i.resolved_at, i.merged_into_incident_id,
           i.split_from_incident_id, i.created_by_user_id, i.created_at, i.updated_at,
      (select count(*)::int from incident_customers ic where ic.incident_id = i.id) as customer_count,
      (select count(*)::int from incident_conversations iv where iv.incident_id = i.id) as conversation_count,
      (select count(*)::int from incident_evidence ie where ie.incident_id = i.id) as evidence_count
    from incidents i
    where i.workspace_id = ${workspaceId}
    order by i.updated_at desc limit 200
  `) as unknown as IncidentSummary[];
}

export async function updateIncidentFields(input: {
  incidentId: string;
  workspaceId: string;
  title?: string | null;
  description?: string | null;
  severity?: IncidentSeverity | null;
  actorUserId?: string | null;
}): Promise<IncidentRow> {
  const patch: { title?: string; description?: string; severity?: IncidentSeverity } = {};
  if (input.title !== undefined && input.title !== null) {
    const t = input.title.trim().replace(/\s+/g, " ").slice(0, 160);
    if (!t) throw Object.assign(new Error("title must not be empty"), { status: 400 });
    patch.title = t;
  }
  if (input.description !== undefined && input.description !== null) {
    patch.description = input.description.trim().slice(0, 4000);
  }
  if (input.severity !== undefined && input.severity !== null) {
    if (!(INCIDENT_SEVERITIES as readonly string[]).includes(input.severity)) {
      throw Object.assign(new Error("unknown severity"), { status: 400 });
    }
    patch.severity = input.severity;
  }
  if (Object.keys(patch).length === 0) {
    throw Object.assign(new Error("nothing valid to update"), { status: 400 });
  }
  const sql = await requireSql();
  const before = await getIncidentForWorkspace(input.workspaceId, input.incidentId);
  if (!before) throw Object.assign(new Error("incident not found"), { status: 404 });
  if ((TERMINAL_STATUSES as readonly string[]).includes(before.status)) {
    throw Object.assign(new Error(`incident is ${before.status} and cannot be edited`), { status: 409 });
  }
  await sql`
    update incidents
    set title = coalesce(${patch.title ?? null}, title),
        description = coalesce(${patch.description ?? null}, description),
        severity = coalesce(${patch.severity ?? null}, severity),
        updated_at = now()
    where id = ${input.incidentId} and workspace_id = ${input.workspaceId}
  `;
  const after = await getIncidentForWorkspace(input.workspaceId, input.incidentId);
  if (!after) throw new Error("incident update failed");
  if (patch.severity && patch.severity !== before.severity) {
    await recordEvent({
      incidentId: after.id,
      kind: "severity_changed",
      actorUserId: input.actorUserId ?? null,
      detail: { from: before.severity, to: patch.severity },
    });
  }
  return after;
}

/**
 * Explicit lifecycle transition. Validates the step, applies resolution /
 * merge bookkeeping, and appends the timeline event. Terminal states are
 * final (except resolved → investigating reopen).
 */
export async function transitionIncident(input: {
  incidentId: string;
  workspaceId: string;
  to: IncidentStatus;
  actorUserId?: string | null;
  resolutionSummary?: string | null;
  reason?: string | null;
  mergedIntoIncidentId?: string | null;
}): Promise<IncidentRow> {
  const sql = await requireSql();
  const current = await getIncidentForWorkspace(input.workspaceId, input.incidentId);
  if (!current) throw Object.assign(new Error("incident not found"), { status: 404 });
  const gate = validateTransition(current.status, input.to, {
    mergedIntoIncidentId: input.mergedIntoIncidentId,
  });
  if (!gate.ok) throw Object.assign(new Error(gate.error), { status: 409 });

  let mergedInto: string | null = null;
  if (input.to === "merged") {
    const target = await getIncidentForWorkspace(input.workspaceId, input.mergedIntoIncidentId!);
    if (!target) throw Object.assign(new Error("merge target not found in this workspace"), { status: 404 });
    if (target.id === current.id) throw Object.assign(new Error("cannot merge an incident into itself"), { status: 400 });
    if ((TERMINAL_STATUSES as readonly string[]).includes(target.status)) {
      throw Object.assign(new Error(`merge target is ${target.status}`), { status: 409 });
    }
    mergedInto = target.id;
  }
  const resolution =
    input.to === "resolved"
      ? (input.resolutionSummary ?? "").trim().slice(0, 2000) || current.resolution_summary
      : current.resolution_summary;
  await sql`
    update incidents
    set status = ${input.to},
        resolution_summary = ${resolution},
        resolved_at = case when ${input.to} = 'resolved' then coalesce(resolved_at, now()) else resolved_at end,
        merged_into_incident_id = coalesce(${mergedInto}, merged_into_incident_id),
        updated_at = now()
    where id = ${input.incidentId} and workspace_id = ${input.workspaceId}
  `;
  const after = await getIncidentForWorkspace(input.workspaceId, input.incidentId);
  if (!after) throw new Error("incident transition failed");
  await recordEvent({
    incidentId: after.id,
    kind: "status_changed",
    actorUserId: input.actorUserId ?? null,
    detail: {
      from: current.status,
      to: input.to,
      ...(input.to === "resolved" && resolution ? { resolution } : {}),
      ...(input.to === "dismissed" && input.reason?.trim() ? { reason: input.reason.trim().slice(0, 500) } : {}),
      ...(mergedInto ? { mergedInto } : {}),
    },
  });
  return after;
}

/** Associate an EXISTING conversation (same workspace). Also links its customer. */
export async function addIncidentConversation(input: {
  incidentId: string;
  workspaceId: string;
  conversationId: string;
  actorUserId?: string | null;
}): Promise<{ conversationLinked: boolean; customerLinked: boolean }> {
  const sql = await requireSql();
  const conv = (await sql`
    select id, workspace_id, customer_id from conversations
    where id = ${input.conversationId} and workspace_id = ${input.workspaceId} limit 1
  `) as unknown as { id: string; workspace_id: string; customer_id: string }[];
  if (!conv[0]) throw Object.assign(new Error("conversation not found in this workspace"), { status: 404 });
  const incident = await getIncidentForWorkspace(input.workspaceId, input.incidentId);
  if (!incident) throw Object.assign(new Error("incident not found"), { status: 404 });
  if ((TERMINAL_STATUSES as readonly string[]).includes(incident.status)) {
    throw Object.assign(new Error(`incident is ${incident.status} and cannot change`), { status: 409 });
  }
  await sql`
    insert into incident_conversations (incident_id, conversation_id, added_by_user_id)
    values (${input.incidentId}, ${input.conversationId}, ${input.actorUserId ?? null})
    on conflict (incident_id, conversation_id) do nothing
  `;
  await sql`
    insert into incident_customers (incident_id, customer_id, added_by_user_id)
    values (${input.incidentId}, ${conv[0].customer_id}, ${input.actorUserId ?? null})
    on conflict (incident_id, customer_id) do nothing
  `;
  await recordEvent({
    incidentId: input.incidentId,
    kind: "conversation_linked",
    actorUserId: input.actorUserId ?? null,
    detail: { conversationId: input.conversationId, customerId: conv[0].customer_id },
  });
  return { conversationLinked: true, customerLinked: true };
}

/** Associate an EXISTING customer (same workspace). */
export async function addIncidentCustomer(input: {
  incidentId: string;
  workspaceId: string;
  customerId: string;
  actorUserId?: string | null;
}): Promise<void> {
  const sql = await requireSql();
  const cu = (await sql`
    select id from customers where id = ${input.customerId} and workspace_id = ${input.workspaceId} limit 1
  `) as unknown as { id: string }[];
  if (!cu[0]) throw Object.assign(new Error("customer not found in this workspace"), { status: 404 });
  const incident = await getIncidentForWorkspace(input.workspaceId, input.incidentId);
  if (!incident) throw Object.assign(new Error("incident not found"), { status: 404 });
  if ((TERMINAL_STATUSES as readonly string[]).includes(incident.status)) {
    throw Object.assign(new Error(`incident is ${incident.status} and cannot change`), { status: 409 });
  }
  await sql`
    insert into incident_customers (incident_id, customer_id, added_by_user_id)
    values (${input.incidentId}, ${input.customerId}, ${input.actorUserId ?? null})
    on conflict (incident_id, customer_id) do nothing
  `;
  await recordEvent({
    incidentId: input.incidentId,
    kind: "customer_linked",
    actorUserId: input.actorUserId ?? null,
    detail: { customerId: input.customerId },
  });
}

export type EvidenceInput =
  | { kind: "message"; messageId: string; label?: string; note?: string }
  | { kind: "conversation"; conversationId: string; label?: string; note?: string }
  | { kind: "fix_card"; fixCardId: string; label?: string; note?: string }
  | { kind: "knowledge"; knowledgeId: string; label?: string; note?: string }
  | { kind: "note"; label?: string; note: string };

/** Reference EXISTING source records (same workspace) — never invented. */
export async function addIncidentEvidence(input: {
  incidentId: string;
  workspaceId: string;
  evidence: EvidenceInput;
  actorUserId?: string | null;
}): Promise<IncidentEvidenceRow> {
  const sql = await requireSql();
  const incident = await getIncidentForWorkspace(input.workspaceId, input.incidentId);
  if (!incident) throw Object.assign(new Error("incident not found"), { status: 404 });
  if ((TERMINAL_STATUSES as readonly string[]).includes(incident.status)) {
    throw Object.assign(new Error(`incident is ${incident.status} and cannot change`), { status: 409 });
  }
  const e = input.evidence;
  let refs = { c: null as string | null, m: null as string | null, f: null as string | null, k: null as string | null };
  const label = ("label" in e && e.label ? e.label : "").trim().slice(0, 200);
  const note = ("note" in e && e.note ? e.note : "").trim().slice(0, 2000);
  if (e.kind === "message") {
    const r = (await sql`
      select m.id from messages m join conversations c on c.id = m.conversation_id
      where m.id = ${e.messageId} and c.workspace_id = ${input.workspaceId} limit 1
    `) as unknown as { id: string }[];
    if (!r[0]) throw Object.assign(new Error("message not found in this workspace"), { status: 404 });
    refs = { ...refs, m: r[0].id };
  } else if (e.kind === "conversation") {
    const r = (await sql`
      select id from conversations where id = ${e.conversationId} and workspace_id = ${input.workspaceId} limit 1
    `) as unknown as { id: string }[];
    if (!r[0]) throw Object.assign(new Error("conversation not found in this workspace"), { status: 404 });
    refs = { ...refs, c: r[0].id };
  } else if (e.kind === "fix_card") {
    const r = (await sql`
      select id from fix_cards where id = ${e.fixCardId} and workspace_id = ${input.workspaceId} limit 1
    `) as unknown as { id: string }[];
    if (!r[0]) throw Object.assign(new Error("fix card not found in this workspace"), { status: 404 });
    refs = { ...refs, f: r[0].id };
  } else if (e.kind === "knowledge") {
    const r = (await sql`
      select id from workspace_knowledge where id = ${e.knowledgeId} and workspace_id = ${input.workspaceId} limit 1
    `) as unknown as { id: string }[];
    if (!r[0]) throw Object.assign(new Error("knowledge source not found in this workspace"), { status: 404 });
    refs = { ...refs, k: r[0].id };
  } else {
    if (!note) throw Object.assign(new Error("operator notes require text"), { status: 400 });
  }
  const rows = (await sql`
    insert into incident_evidence
      (incident_id, kind, ref_conversation_id, ref_message_id, ref_fix_card_id, ref_knowledge_id, label, note, created_by_user_id)
    values (${input.incidentId}, ${e.kind}, ${refs.c}, ${refs.m}, ${refs.f}, ${refs.k},
            ${label}, ${note}, ${input.actorUserId ?? null})
    returning id, kind, ref_conversation_id, ref_message_id, ref_fix_card_id,
              ref_knowledge_id, label, note, created_at
  `) as unknown as IncidentEvidenceRow[];
  if (!rows[0]) throw new Error("evidence insert failed");
  await recordEvent({
    incidentId: input.incidentId,
    kind: "evidence_added",
    actorUserId: input.actorUserId ?? null,
    detail: { evidenceId: rows[0].id, evidenceKind: e.kind },
  });
  return rows[0];
}

/**
 * Explicit split: creates a child incident linked via split_from, moves the
 * SELECTED associations (never everything implicitly), and marks the source
 * 'split'. Both sides get timeline entries. No clustering is implied.
 */
export async function splitIncident(input: {
  incidentId: string;
  workspaceId: string;
  childTitle: string;
  childDescription?: string | null;
  severity?: IncidentSeverity | null;
  moveConversationIds?: string[];
  moveCustomerIds?: string[];
  actorUserId?: string | null;
}): Promise<{ source: IncidentRow; child: IncidentRow }> {
  const sql = await requireSql();
  const source = await getIncidentForWorkspace(input.workspaceId, input.incidentId);
  if (!source) throw Object.assign(new Error("incident not found"), { status: 404 });
  if ((TERMINAL_STATUSES as readonly string[]).includes(source.status)) {
    throw Object.assign(new Error(`incident is ${source.status} and cannot split`), { status: 409 });
  }
  const child = await createIncident({
    workspaceId: input.workspaceId,
    title: input.childTitle,
    description: input.childDescription ?? "",
    severity: input.severity ?? source.severity,
    createdByUserId: input.actorUserId ?? null,
  });
  await sql`update incidents set split_from_incident_id = ${source.id} where id = ${child.id}`;
  for (const conversationId of input.moveConversationIds ?? []) {
    const conv = (await sql`
      select conversation_id from incident_conversations
      where incident_id = ${source.id} and conversation_id = ${conversationId} limit 1
    `) as unknown as { conversation_id: string }[];
    if (!conv[0]) throw Object.assign(new Error("conversation is not linked to the source incident"), { status: 404 });
    await sql`delete from incident_conversations where incident_id = ${source.id} and conversation_id = ${conversationId}`;
    await addIncidentConversation({
      incidentId: child.id,
      workspaceId: input.workspaceId,
      conversationId,
      actorUserId: input.actorUserId ?? null,
    });
  }
  for (const customerId of input.moveCustomerIds ?? []) {
    const cu = (await sql`
      select customer_id from incident_customers
      where incident_id = ${source.id} and customer_id = ${customerId} limit 1
    `) as unknown as { customer_id: string }[];
    if (!cu[0]) throw Object.assign(new Error("customer is not linked to the source incident"), { status: 404 });
    await sql`delete from incident_customers where incident_id = ${source.id} and customer_id = ${customerId}`;
    await addIncidentCustomer({
      incidentId: child.id,
      workspaceId: input.workspaceId,
      customerId,
      actorUserId: input.actorUserId ?? null,
    });
  }
  await sql`
    update incidents set status = 'split', updated_at = now()
    where id = ${source.id} and workspace_id = ${input.workspaceId}
  `;
  await recordEvent({
    incidentId: source.id,
    kind: "split",
    actorUserId: input.actorUserId ?? null,
    detail: { childIncidentId: child.id },
  });
  await recordEvent({
    incidentId: child.id,
    kind: "split_from",
    actorUserId: input.actorUserId ?? null,
    detail: { sourceIncidentId: source.id },
  });
  const updated = await getIncidentForWorkspace(input.workspaceId, source.id);
  const childFull = await getIncidentForWorkspace(input.workspaceId, child.id);
  if (!updated || !childFull) throw new Error("split failed");
  return { source: updated, child: childFull };
}

/**
 * Explicit merge: moves ALL of the source's associations to the target,
 * marks the source 'merged' with its link, and records both timelines.
 * Target must be non-terminal and in the same workspace.
 */
export async function mergeIncident(input: {
  incidentId: string;
  workspaceId: string;
  targetIncidentId: string;
  actorUserId?: string | null;
}): Promise<{ source: IncidentRow; target: IncidentRow }> {
  const sql = await requireSql();
  const source = await getIncidentForWorkspace(input.workspaceId, input.incidentId);
  if (!source) throw Object.assign(new Error("incident not found"), { status: 404 });
  if (source.id === input.targetIncidentId) {
    throw Object.assign(new Error("cannot merge an incident into itself"), { status: 400 });
  }
  if ((TERMINAL_STATUSES as readonly string[]).includes(source.status)) {
    throw Object.assign(new Error(`incident is ${source.status} and cannot merge`), { status: 409 });
  }
  const target = await getIncidentForWorkspace(input.workspaceId, input.targetIncidentId);
  if (!target) throw Object.assign(new Error("merge target not found in this workspace"), { status: 404 });
  if ((TERMINAL_STATUSES as readonly string[]).includes(target.status)) {
    throw Object.assign(new Error(`merge target is ${target.status}`), { status: 409 });
  }
  const moved = { customers: 0, conversations: 0, evidence: 0 };
  const convs = (await sql`
    select conversation_id from incident_conversations where incident_id = ${source.id}
  `) as unknown as { conversation_id: string }[];
  for (const c of convs) {
    await sql`
      insert into incident_conversations (incident_id, conversation_id, added_by_user_id)
      values (${target.id}, ${c.conversation_id}, ${input.actorUserId ?? null})
      on conflict (incident_id, conversation_id) do nothing
    `;
    moved.conversations += 1;
  }
  const custs = (await sql`
    select customer_id from incident_customers where incident_id = ${source.id}
  `) as unknown as { customer_id: string }[];
  for (const c of custs) {
    await sql`
      insert into incident_customers (incident_id, customer_id, added_by_user_id)
      values (${target.id}, ${c.customer_id}, ${input.actorUserId ?? null})
      on conflict (incident_id, customer_id) do nothing
    `;
    moved.customers += 1;
  }
  const ev = (await sql`
    update incident_evidence set incident_id = ${target.id} where incident_id = ${source.id}
    returning id
  `) as unknown as { id: string }[];
  moved.evidence = ev.length;
  await sql`
    update incidents set status = 'merged', merged_into_incident_id = ${target.id}, updated_at = now()
    where id = ${source.id} and workspace_id = ${input.workspaceId}
  `;
  await sql`update incidents set updated_at = now() where id = ${target.id}`;
  await recordEvent({
    incidentId: source.id,
    kind: "merged",
    actorUserId: input.actorUserId ?? null,
    detail: { intoIncidentId: target.id, ...moved },
  });
  await recordEvent({
    incidentId: target.id,
    kind: "merge_received",
    actorUserId: input.actorUserId ?? null,
    detail: { fromIncidentId: source.id, ...moved },
  });
  const updatedSource = await getIncidentForWorkspace(input.workspaceId, source.id);
  const updatedTarget = await getIncidentForWorkspace(input.workspaceId, target.id);
  if (!updatedSource || !updatedTarget) throw new Error("merge failed");
  return { source: updatedSource, target: updatedTarget };
}

export async function listIncidentCustomers(
  incidentId: string,
  workspaceId: string,
): Promise<IncidentCustomerRow[]> {
  const sql = await requireSql();
  return (await sql`
    select ic.customer_id, coalesce(cu.display_name, left(cu.id, 8)) as display_name, ic.added_at
    from incident_customers ic join customers cu on cu.id = ic.customer_id
    join incidents i on i.id = ic.incident_id
    where ic.incident_id = ${incidentId} and i.workspace_id = ${workspaceId}
    order by ic.added_at
  `) as unknown as IncidentCustomerRow[];
}

export async function listIncidentConversations(
  incidentId: string,
  workspaceId: string,
): Promise<IncidentConversationRow[]> {
  const sql = await requireSql();
  return (await sql`
    select iv.conversation_id, c.title, c.status,
           coalesce(cu.display_name, left(cu.id, 8)) as customer_display, iv.added_at
    from incident_conversations iv
    join conversations c on c.id = iv.conversation_id
    left join customers cu on cu.id = c.customer_id
    join incidents i on i.id = iv.incident_id
    where iv.incident_id = ${incidentId} and i.workspace_id = ${workspaceId}
    order by iv.added_at
  `) as unknown as IncidentConversationRow[];
}

export async function listIncidentEvidence(
  incidentId: string,
  workspaceId: string,
): Promise<IncidentEvidenceRow[]> {
  const sql = await requireSql();
  return (await sql`
    select ie.id, ie.kind, ie.ref_conversation_id, ie.ref_message_id, ie.ref_fix_card_id,
           ie.ref_knowledge_id, ie.label, ie.note, ie.created_at
    from incident_evidence ie join incidents i on i.id = ie.incident_id
    where ie.incident_id = ${incidentId} and i.workspace_id = ${workspaceId}
    order by ie.created_at
  `) as unknown as IncidentEvidenceRow[];
}

export async function listIncidentEvents(
  incidentId: string,
  workspaceId: string,
): Promise<IncidentEventRow[]> {
  const sql = await requireSql();
  return (await sql`
    select ie.id, ie.kind, ie.actor_user_id, ie.detail, ie.created_at
    from incident_events ie join incidents i on i.id = ie.incident_id
    where ie.incident_id = ${incidentId} and i.workspace_id = ${workspaceId}
    order by ie.created_at, ie.id
  `) as unknown as IncidentEventRow[];
}

/**
 * Non-terminal incidents a conversation is linked to (S6 refresh scope).
 * Bounded; used to schedule evidence-brief rebuilds on new reports.
 */
export async function listOpenIncidentIdsForConversation(conversationId: string): Promise<string[]> {
  const sql = await requireSql();
  const rows = (await sql`
    select iv.incident_id from incident_conversations iv
    join incidents i on i.id = iv.incident_id
    where iv.conversation_id = ${conversationId}
      and i.status not in ('resolved', 'dismissed', 'merged', 'split')
    order by i.updated_at desc limit 5
  `) as unknown as { incident_id: string }[];
  return rows.map((r) => r.incident_id);
}
