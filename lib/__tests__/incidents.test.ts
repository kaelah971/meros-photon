import { describe, expect, it, afterAll, vi } from "vitest";
import { createHash } from "node:crypto";
import { addOrganizationMember, ensureOrganization, ensureWorkspace } from "../db";
import { organizationIdForSlug, workspaceIdForSlug, customerIdFor } from "../tenant";
import {
  INCIDENT_SEVERITIES,
  addIncidentConversation,
  addIncidentCustomer,
  addIncidentEvidence,
  canTransition,
  createIncident,
  getIncidentForWorkspace,
  listIncidentEvents,
  listIncidents,
  mergeIncident,
  splitIncident,
  transitionIncident,
  updateIncidentFields,
  validateTransition,
  type IncidentStatus,
} from "../incidents";
import { createConversation } from "../support-ops";
import { POST as createPOST } from "@/app/api/incidents/route";

// next/headers has no request scope in tests: control the cookie jar here.
let cookieJar = "";
vi.mock("next/headers", () => ({
  headers: async () => new Headers(cookieJar ? { cookie: cookieJar } : {}),
}));

const stamp = Date.now().toString(36);
const PW = "correct-horse-123";
const createdEmails: string[] = [];
const createdOrgIds: string[] = [];
const SLUG = `inc-ws-${stamp}`;
const SLUG_B = `inc-ws-b-${stamp}`;

function dbKey(): string {
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  return readFileSync(".env.local", "utf8")
    .split("\n").map((l) => l.trim()).find((l) => l.startsWith("DATABASE_URL="))!
    .slice("DATABASE_URL=".length);
}

async function signupSession(email: string): Promise<string> {
  const { auth } = await import("../better-auth");
  const res = (await auth.api.signUpEmail({
    body: { email, password: PW, name: email.split("@")[0] },
    headers: new Headers(),
    asResponse: true,
  })) as unknown as Response;
  const setCookies = res.headers.getSetCookie();
  const sessionCookie = setCookies.find((c) => c.startsWith("meros.session_token="))!;
  expect(sessionCookie, "session set-cookie present").toBeTruthy();
  createdEmails.push(email);
  return sessionCookie.split(";")[0];
}

async function userIdFor(email: string): Promise<string> {
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(dbKey());
  const rows = (await sql`select id from "user" where email = ${email} limit 1`) as unknown as { id: string }[];
  return rows[0].id;
}

afterAll(async () => {
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(dbKey());
  for (const id of createdOrgIds) {
    await sql`delete from organizations where id = ${id}`;
  }
  for (const email of createdEmails) {
    await sql`delete from "user" where email = ${email}`;
  }
});

describe("incident lifecycle transitions (pure)", () => {
  it("allows every documented forward step", () => {
    const ok: [IncidentStatus, IncidentStatus][] = [
      ["detected", "investigating"],
      ["investigating", "ready_for_action"],
      ["ready_for_action", "recovering"],
      ["recovering", "monitoring"],
      ["monitoring", "resolved"],
      ["monitoring", "recovering"],
      ["resolved", "investigating"],
      ["detected", "dismissed"],
      ["investigating", "dismissed"],
      ["monitoring", "dismissed"],
    ];
    for (const [from, to] of ok) expect(canTransition(from, to), `${from}->${to}`).toBe(true);
  });

  it("rejects same-state, skips, backward, and terminal moves", () => {
    const bad: [IncidentStatus, IncidentStatus][] = [
      ["detected", "detected"],
      ["detected", "resolved"],
      ["detected", "monitoring"],
      ["investigating", "recovering"],
      ["ready_for_action", "monitoring"],
      ["resolved", "monitoring"],
      ["resolved", "dismissed"],
      ["dismissed", "investigating"],
      ["merged", "investigating"],
      ["split", "investigating"],
      ["resolved", "resolved"],
      ["investigating", "split"],
      ["monitoring", "split"],
    ];
    for (const [from, to] of bad) expect(canTransition(from, to), `${from}->${to}`).toBe(false);
  });

  it("validateTransition enforces merge linkage rules", () => {
    expect(validateTransition("investigating", "ready_for_action", {}).ok).toBe(true);
    expect(validateTransition("investigating", "bogus" as IncidentStatus, {}).ok).toBe(false);
    expect(validateTransition("investigating", "merged", {}).ok).toBe(false);
    expect(validateTransition("investigating", "merged", { mergedIntoIncidentId: "x" }).ok).toBe(true);
    expect(validateTransition("investigating", "ready_for_action", { mergedIntoIncidentId: "x" }).ok).toBe(false);
  });

  it("severities are exactly the documented four", () => {
    expect([...INCIDENT_SEVERITIES]).toEqual(["low", "medium", "high", "critical"]);
  });
});

describe("incident persistence (live Neon)", () => {
  it("setup: workspaces, staffer, customer, conversation", async () => {
    for (const slug of [SLUG, SLUG_B]) {
      const orgId = organizationIdForSlug(slug);
      await ensureOrganization({ id: orgId, slug, name: `Temp ${slug}` });
      await ensureWorkspace({ id: workspaceIdForSlug(slug), organizationId: orgId, slug, name: `Temp ${slug}` });
      createdOrgIds.push(orgId);
    }
    cookieJar = await signupSession(`inc-staff-${stamp}@example.test`);
    const staffId = await userIdFor(`inc-staff-${stamp}@example.test`);
    await addOrganizationMember({ organizationId: organizationIdForSlug(SLUG), userId: staffId, role: "owner" });
    expect(staffId).toBeTruthy();
  }, 120_000);

  it("create validates input and persists", async () => {
    const wsId = workspaceIdForSlug(SLUG);
    await expect(createIncident({ workspaceId: wsId, title: "   " })).rejects.toMatchObject({ status: 400 });
    await expect(
      createIncident({ workspaceId: wsId, title: "Bad sev", severity: "urgent" as never }),
    ).rejects.toMatchObject({ status: 400 });
    const inc = await createIncident({ workspaceId: wsId, title: "Checkout 500s", severity: "high" });
    expect(inc.status).toBe("detected");
    expect(inc.severity).toBe("high");
    const found = await getIncidentForWorkspace(wsId, inc.id);
    expect(found?.title).toBe("Checkout 500s");
    expect(found?.customer_count).toBe(0);
  }, 120_000);

  it("associations link existing workspace records and timeline them", async () => {
    const wsId = workspaceIdForSlug(SLUG);
    const { ensureCustomer } = await import("../db");
    const { getIdSalt } = await import("../env");
    const hash = createHash("sha256").update(`bootstrap-${stamp}`, "utf8").digest("hex");
    const customerId = customerIdFor(wsId, hash);
    await ensureCustomer({ id: customerId, workspaceId: wsId, bootstrapHash: hash });
    const { conversation } = await createConversation({ workspaceId: wsId, customerId, title: "Visa fails" });
    const inc = await createIncident({ workspaceId: wsId, title: "Payment outage" });

    // Cross-workspace conversation must 404, never link.
    const wsB = workspaceIdForSlug(SLUG_B);
    const other = await createConversation({
      workspaceId: wsB,
      customerId: (await (async () => {
        const h2 = createHash("sha256").update(`other-${stamp}`, "utf8").digest("hex");
        const cid = customerIdFor(wsB, h2);
        await ensureCustomer({ id: cid, workspaceId: wsB, bootstrapHash: h2 });
        return cid;
      })()),
      title: "Other ws thread",
    });
    await expect(
      addIncidentConversation({ incidentId: inc.id, workspaceId: wsId, conversationId: other.conversation.id }),
    ).rejects.toMatchObject({ status: 404 });

    const linked = await addIncidentConversation({ incidentId: inc.id, workspaceId: wsId, conversationId: conversation.id });
    expect(linked).toEqual({ conversationLinked: true, customerLinked: true });
    const after = await getIncidentForWorkspace(wsId, inc.id);
    expect(after?.conversation_count).toBe(1);
    expect(after?.customer_count).toBe(1);

    // Duplicate link is idempotent, not an error.
    await addIncidentConversation({ incidentId: inc.id, workspaceId: wsId, conversationId: conversation.id });
    expect((await getIncidentForWorkspace(wsId, inc.id))?.conversation_count).toBe(1);

    // Evidence: existing message ref ok; foreign message rejected.
    const { listMessages, addUserMessage } = await import("../support-ops");
    await addUserMessage({ conversationId: conversation.id, content: "Visa fails with 500", clientId: `inc-msg-${stamp}` });
    const msgs = await listMessages(conversation.id);
    expect(msgs.length).toBeGreaterThan(0);
    const ev = await addIncidentEvidence({
      incidentId: inc.id,
      workspaceId: wsId,
      evidence: { kind: "message", messageId: msgs[0].id, label: "failing request" },
    });
    expect(ev.kind).toBe("message");
    await expect(
      addIncidentEvidence({ incidentId: inc.id, workspaceId: wsId, evidence: { kind: "note", note: "  " } }),
    ).rejects.toMatchObject({ status: 400 });

    const events = await listIncidentEvents(inc.id, wsId);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("created");
    expect(kinds).toContain("conversation_linked");
    expect(kinds).toContain("evidence_added");
    // Append-only: kinds only grow; created stays first.
    expect(events[0].kind).toBe("created");
  }, 120_000);

  it("transitions validate, resolve, and lock terminals", async () => {
    const wsId = workspaceIdForSlug(SLUG);
    const inc = await createIncident({ workspaceId: wsId, title: "Refund delays" });
    await expect(
      transitionIncident({ incidentId: inc.id, workspaceId: wsId, to: "resolved" }),
    ).rejects.toMatchObject({ status: 409 });
    // S12: resolving needs a verified closure or an explicit administrative reason.
    // (From detected the lifecycle gate fires first; the reason check
    // applies once monitoring is reached.)
    for (const to of ["investigating", "ready_for_action", "recovering", "monitoring"] as const) {
      await transitionIncident({ incidentId: inc.id, workspaceId: wsId, to });
    }
    await expect(
      transitionIncident({
        incidentId: inc.id,
        workspaceId: wsId,
        to: "resolved",
        closure: { mode: "administrative", reason: "" },
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      transitionIncident({
        incidentId: inc.id,
        workspaceId: wsId,
        to: "resolved",
        closure: { mode: "administrative", reason: "   " },
      }),
    ).rejects.toMatchObject({ status: 400 });
    const resolved = await transitionIncident({
      incidentId: inc.id, workspaceId: wsId, to: "resolved", resolutionSummary: "Deployed fix, verified",
      closure: { mode: "administrative", reason: "Duplicate of a tracked outage; verified path not applicable" },
    });
    expect(resolved.status).toBe("resolved");
    expect(resolved.resolution_summary).toContain("Deployed fix");
    expect(resolved.resolved_at).toBeTruthy();
    await expect(
      transitionIncident({ incidentId: inc.id, workspaceId: wsId, to: "monitoring" }),
    ).rejects.toMatchObject({ status: 409 });
    // Reopen is the one allowed terminal move.
    const reopened = await transitionIncident({ incidentId: inc.id, workspaceId: wsId, to: "investigating" });
    expect(reopened.status).toBe("investigating");
  }, 120_000);

  it("cross-workspace isolation holds", async () => {
    const wsId = workspaceIdForSlug(SLUG);
    const wsB = workspaceIdForSlug(SLUG_B);
    const inc = await createIncident({ workspaceId: wsId, title: "Isolated" });
    expect(await getIncidentForWorkspace(wsB, inc.id)).toBeNull();
    expect(await listIncidents(wsB)).toEqual([]);
  }, 120_000);

  it("split moves only selected links; merge moves everything", async () => {
    const wsId = workspaceIdForSlug(SLUG);
    const { ensureCustomer } = await import("../db");
    const { getIdSalt } = await import("../env");
    const mkCust = async (tag: string) => {
      const h = createHash("sha256").update(`${tag}-${stamp}`, "utf8").digest("hex");
      const cid = customerIdFor(wsId, h);
      await ensureCustomer({ id: cid, workspaceId: wsId, bootstrapHash: h });
      return cid;
    };
    const c1 = await mkCust("s1");
    const c2 = await mkCust("s2");
    const t1 = (await createConversation({ workspaceId: wsId, customerId: c1, title: "T1" })).conversation;
    const t2 = (await createConversation({ workspaceId: wsId, customerId: c2, title: "T2" })).conversation;
    const src = await createIncident({ workspaceId: wsId, title: "Big outage" });
    await addIncidentConversation({ incidentId: src.id, workspaceId: wsId, conversationId: t1.id });
    await addIncidentConversation({ incidentId: src.id, workspaceId: wsId, conversationId: t2.id });

    const { source, child } = await splitIncident({
      incidentId: src.id,
      workspaceId: wsId,
      childTitle: "Card failures",
      moveConversationIds: [t1.id],
      moveCustomerIds: [c1],
    });
    expect(source.status).toBe("split");
    expect(child.split_from_incident_id).toBe(src.id);
    expect((await getIncidentForWorkspace(wsId, src.id))?.conversation_count).toBe(1);
    expect((await getIncidentForWorkspace(wsId, child.id))?.conversation_count).toBe(1);

    const target = await createIncident({ workspaceId: wsId, title: "Payments epic" });
    const merged = await mergeIncident({ incidentId: child.id, workspaceId: wsId, targetIncidentId: target.id });
    expect(merged.source.status).toBe("merged");
    expect(merged.source.merged_into_incident_id).toBe(target.id);
    expect((await getIncidentForWorkspace(wsId, target.id))?.conversation_count).toBe(1);
    await expect(
      mergeIncident({ incidentId: target.id, workspaceId: wsId, targetIncidentId: target.id }),
    ).rejects.toMatchObject({ status: 400 });
  }, 120_000);
});

describe("incident API validation (live Neon)", () => {
  function req(body: unknown, qs = "") {
    return new Request(`http://test/api/incidents${qs}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("anonymous callers get 401; unknown workspaces 404; empty titles 400", async () => {
    cookieJar = "";
    const anon = await createPOST(req({ workspaceSlug: SLUG, title: "X" }));
    expect(anon.status).toBe(401);

    cookieJar = await signupSession(`inc-staff2-${stamp}@example.test`);
    const staffId = await userIdFor(`inc-staff2-${stamp}@example.test`);
    await addOrganizationMember({ organizationId: organizationIdForSlug(SLUG), userId: staffId, role: "owner" });

    const missing = await createPOST(req({ workspaceSlug: "nope", title: "X" }));
    expect(missing.status).toBe(404);
    const empty = await createPOST(req({ workspaceSlug: SLUG, title: "  " }));
    expect(empty.status).toBe(400);
    const created = await createPOST(req({ workspaceSlug: SLUG, title: "API incident", severity: "low" }));
    expect(created.status).toBe(201);
  }, 120_000);
});
