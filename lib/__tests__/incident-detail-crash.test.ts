import { describe, expect, it, afterAll, vi } from "vitest";
import React from "react";
(globalThis as { React?: typeof React }).React = React;
import { addOrganizationMember, ensureOrganization, ensureWorkspace } from "../db";
import { organizationIdForSlug, workspaceIdForSlug } from "../tenant";
import { uniqueSlug, uniqueEmail, FixtureTracker } from "./fixtures";

vi.mock("next/link", () => ({ default: (props: unknown) => props }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error(`redirect:${url}`), { digest: "NEXT_REDIRECT" });
  },
}));

const tracker = new FixtureTracker();
const SLUG = uniqueSlug("inc-crash");
const EMAIL = uniqueEmail("inc-crash");
const PW = "correct-horse-123";
let userId = "";
let workspaceId = "";

async function signup(): Promise<void> {
  const { auth } = await import("../better-auth");
  const res = (await auth.api.signUpEmail({
    body: { email: EMAIL, password: PW, name: "Crash" },
    headers: new Headers(),
    asResponse: true,
  })) as unknown as Response;
  const setCookies = res.headers.getSetCookie();
  const sc = setCookies.find((c) => c.startsWith("meros.session_token="))!;
  expect(sc).toBeTruthy();
  tracker.trackEmail(EMAIL);
  const { neon } = await import("@neondatabase/serverless");
  const { readFileSync } = await import("node:fs");
  const key = readFileSync(".env.local", "utf8").split("\n").map((l) => l.trim()).find((l) => l.startsWith("DATABASE_URL="))!.slice("DATABASE_URL=".length);
  const sql = neon(key);
  const rows = (await sql`select id from "user" where email = ${EMAIL} limit 1`) as unknown as { id: string }[];
  userId = rows[0].id;
}

const { currentUserMock } = vi.hoisted(() => ({
  currentUserMock: vi.fn(async (): Promise<{ id: string; email: string; displayName: string }> => ({
    id: "pending",
    email: "placeholder",
    displayName: "Crash",
  })),
}));

vi.mock("@/lib/auth", () => ({ currentUser: currentUserMock }));

afterAll(async () => {
  await tracker.cleanup();
});

describe("incident detail render path for a newly accepted incident", () => {
  it("setup: workspace + owner + customer + conversation", async () => {
    const orgId = organizationIdForSlug(SLUG);
    workspaceId = workspaceIdForSlug(SLUG);
    await ensureOrganization({ id: orgId, slug: SLUG, name: `Temp ${SLUG}` });
    await ensureWorkspace({ id: workspaceId, organizationId: orgId, slug: SLUG, name: `Temp ${SLUG}` });
    tracker.trackOrg(orgId);
    await signup();
    // Point the auth mock at the real user id.
    currentUserMock.mockResolvedValue({ id: userId, email: EMAIL, displayName: "Crash" });
    await addOrganizationMember({ organizationId: orgId, userId, role: "owner" });
  }, 120_000);

  it("fresh detected incident with links but no brief/plan/watch renders every section", async () => {
    const { ensureAuthCustomer } = await import("../db");
    const { createConversation, addUserMessage } = await import("../support-ops");
    const { createIncident, addIncidentConversation, addIncidentCustomer, getIncidentForWorkspace } = await import("../incidents");
    const { customerIdForAuth } = await import("../tenant");

    const custId = customerIdForAuth(workspaceId, userId);
    await ensureAuthCustomer({ id: custId, workspaceId, authUserId: userId, displayName: "Crash" });
    const { conversation } = await createConversation({ workspaceId, customerId: custId, title: "Checkout fails with 422" });
    await addUserMessage({ conversationId: conversation.id, content: "My checkout keeps failing with HTTP 422 every time I pay.", clientId: "diag-1" });

    // Mirror approval: detected incident + linked conversation/customer, no downstream records.
    const incident = await createIncident({
      workspaceId,
      title: "CKT-422 checkout failures",
      description: "Checkout fails with HTTP 422",
      severity: "medium",
      createdByUserId: userId,
      initialConversationIds: [conversation.id],
    });
    expect(incident.status).toBe("detected");
    await addIncidentCustomer({ incidentId: incident.id, workspaceId, customerId: custId, actorUserId: userId });

    // Page-level loaders.
    const { listIncidentConversations, listIncidentCustomers, listIncidentEvidence, listIncidentEvents, listIncidents } = await import("../incidents");
    const { listWorkspaceConversations, listWorkspaceCustomers } = await import("../support-ops");
    const found = await getIncidentForWorkspace(workspaceId, incident.id);
    expect(found?.id).toBe(incident.id);
    const [customers, conversations, evidence, events] = await Promise.all([
      listIncidentCustomers(incident.id, workspaceId),
      listIncidentConversations(incident.id, workspaceId),
      listIncidentEvidence(incident.id, workspaceId),
      listIncidentEvents(incident.id, workspaceId),
    ]);
    for (const [name, arr] of [["customers", customers], ["conversations", conversations], ["evidence", evidence], ["events", events]] as const) {
      expect(Array.isArray(arr), `${name} must be an array`).toBe(true);
    }
    expect(customers).toHaveLength(1);
    expect(conversations).toHaveLength(1);

    // Every section component on the detail page, executed for real.
    // First: the empty state (no downstream records) must render.
    const EvidenceBrief = (await import("@/components/evidence-brief")).default;
    const IncidentSnapshot = (await import("@/components/incident-snapshot")).default;
    const IncidentFixMatches = (await import("@/components/incident-fix-matches")).default;
    const IncidentRecoveryPlan = (await import("@/components/incident-recovery-plan")).default;
    const ResolutionWatchSection = (await import("@/components/resolution-watch-section")).default;
    const RecoverManySection = (await import("@/components/recover-many-section")).default;
    const ClosureSection = (await import("@/components/closure-section")).default;
    const base = { workspaceSlug: SLUG, workspaceId, incidentId: incident.id };
    await EvidenceBrief(base);
    await IncidentSnapshot({ ...base, incident: { id: incident.id, title: incident.title, status: incident.status, severity: incident.severity, customer_count: 1, conversation_count: 1 } });
    await IncidentFixMatches(base);
    await IncidentRecoveryPlan(base);
    await ResolutionWatchSection(base);
    await RecoverManySection(base);
    await ClosureSection(base);

    // Full page render path (data loading + JSX assembly, no browser).
    const Page = (await import("@/app/app/workspaces/[slug]/incidents/[incidentId]/page")).default;
    const el = await Page({ params: Promise.resolve({ slug: SLUG, incidentId: incident.id }) });
    expect(el).toBeTruthy();
  }, 180_000);

  it("pending brief claim without completion renders without crashing", async () => {
    const { ensureAuthCustomer } = await import("../db");
    const { createConversation, addUserMessage } = await import("../support-ops");
    const { createIncident } = await import("../incidents");
    const { customerIdForAuth } = await import("../tenant");
    const { realBriefStore } = await import("../evidence-brief");

    const custId = customerIdForAuth(workspaceId, userId);
    await ensureAuthCustomer({ id: custId, workspaceId, authUserId: userId, displayName: "Crash" });
    const { conversation } = await createConversation({ workspaceId, customerId: custId, title: "Pending brief case" });
    await addUserMessage({ conversationId: conversation.id, content: "My checkout keeps failing with HTTP 422 on every order.", clientId: "diag-p-1" });
    const incident = await createIncident({
      workspaceId,
      title: "Pending brief incident",
      description: "pending",
      severity: "medium",
      createdByUserId: userId,
      initialConversationIds: [conversation.id],
    });
    // Transient state: build claimed but never completed (crashed worker).
    const store = await realBriefStore();
    expect(await store.insertPending(incident.id, workspaceId, "fp-pending-test", 1)).toBe(true);

    const base = { workspaceSlug: SLUG, workspaceId, incidentId: incident.id };
    const EvidenceBrief = (await import("@/components/evidence-brief")).default;
    const IncidentSnapshot = (await import("@/components/incident-snapshot")).default;
    const IncidentFixMatches = (await import("@/components/incident-fix-matches")).default;
    const IncidentRecoveryPlan = (await import("@/components/incident-recovery-plan")).default;
    const ResolutionWatchSection = (await import("@/components/resolution-watch-section")).default;
    const RecoverManySection = (await import("@/components/recover-many-section")).default;
    const ClosureSection = (await import("@/components/closure-section")).default;
    await EvidenceBrief(base);
    await IncidentSnapshot({ ...base, incident: { id: incident.id, title: incident.title, status: incident.status, severity: incident.severity, customer_count: 1, conversation_count: 1 } });
    await IncidentFixMatches(base);
    await IncidentRecoveryPlan(base);
    await ResolutionWatchSection(base);
    await RecoverManySection(base);
    await ClosureSection(base);
    const Page = (await import("@/app/app/workspaces/[slug]/incidents/[incidentId]/page")).default;
    const el = await Page({ params: Promise.resolve({ slug: SLUG, incidentId: incident.id }) });
    expect(el).toBeTruthy();
  }, 180_000);

  it("incident with a built brief, matches and derived records still renders", async () => {
    const { ensureAuthCustomer } = await import("../db");
    const { createConversation, addUserMessage } = await import("../support-ops");
    const { createIncident, addIncidentConversation } = await import("../incidents");
    const { customerIdForAuth } = await import("../tenant");
    const { realBriefStore, refreshBriefIfNeeded } = await import("../evidence-brief");
    const { realMatchDeps, refreshMatchesIfNeeded } = await import("../fix-matches");

    const custId = customerIdForAuth(workspaceId, userId);
    await ensureAuthCustomer({ id: custId, workspaceId, authUserId: userId, displayName: "Crash" });
    const convIds: string[] = [];
    const msgIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { conversation } = await createConversation({ workspaceId, customerId: custId, title: `Checkout fails ${i}` });
      convIds.push(conversation.id);
      const stored = await addUserMessage({ conversationId: conversation.id, content: `My checkout keeps failing with HTTP 422 on order ${1000 + i}.`, clientId: `diag-b-${i}` });
      msgIds.push(stored.id);
    }
    const incident = await createIncident({
      workspaceId,
      title: "CKT checkout failures batch",
      description: "Checkout fails with HTTP 422",
      severity: "medium",
      createdByUserId: userId,
      initialConversationIds: convIds,
    });

    // Mirror the transient state right after approval: background refresh
    // has claimed the brief build but not completed it yet.
    const store = await realBriefStore();
    const briefRes = await refreshBriefIfNeeded(incident.id, workspaceId, {
      store,
      judge: async () => ({
        facts: [{ observation: "Checkout returns HTTP 422", sources: msgIds.slice(0, 2), identifiers: ["422"] }],
        corroborated: [],
        contradictions: [],
        unknowns: ["Whether the gateway or the app emits the 422"],
        hypotheses: [],
      }),
    });
    expect(briefRes.action).toBe("built");
    const matchRes = await refreshMatchesIfNeeded(incident.id, workspaceId, await realMatchDeps());
    expect(["built", "unchanged", "deferred", "skipped", "no_match", "stale"]).toContain(matchRes.action);

    const base = { workspaceSlug: SLUG, workspaceId, incidentId: incident.id };
    const EvidenceBrief = (await import("@/components/evidence-brief")).default;
    const IncidentSnapshot = (await import("@/components/incident-snapshot")).default;
    const IncidentFixMatches = (await import("@/components/incident-fix-matches")).default;
    const IncidentRecoveryPlan = (await import("@/components/incident-recovery-plan")).default;
    const ResolutionWatchSection = (await import("@/components/resolution-watch-section")).default;
    const RecoverManySection = (await import("@/components/recover-many-section")).default;
    const ClosureSection = (await import("@/components/closure-section")).default;
    await EvidenceBrief(base);
    await IncidentSnapshot({ ...base, incident: { id: incident.id, title: incident.title, status: incident.status, severity: incident.severity, customer_count: 1, conversation_count: 3 } });
    await IncidentFixMatches(base);
    await IncidentRecoveryPlan(base);
    await ResolutionWatchSection(base);
    await RecoverManySection(base);
    await ClosureSection(base);
    const Page = (await import("@/app/app/workspaces/[slug]/incidents/[incidentId]/page")).default;
    const el = await Page({ params: Promise.resolve({ slug: SLUG, incidentId: incident.id }) });
    expect(el).toBeTruthy();
  }, 180_000);
});
