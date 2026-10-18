#!/usr/bin/env node
/**
 * S15A targeted visual verification.
 *
 * Captures REAL product UI (dev server) at mobile + desktop viewports,
 * focusing on the NEW S14 Knowledge Health section with populated state.
 * Fixtures are synthetic ([fixture]-marked) and DELETED afterwards.
 *
 * Usage: npm run dev -- -p 3002 (in another shell), then:
 *   node scripts/capture-s15a-shots.mjs
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.SHOT_BASE ?? "http://localhost:3002";
const OUT = "docs/screenshots";
const STAMP = Date.now().toString(36);

function loadEnv() {
  try {
    for (const line of readFileSync(".env.local", "utf8").split("\n")) {
      const i = line.indexOf("=");
      if (i > 0) {
        const k = line.slice(0, i).trim();
        if (k && !(k in process.env)) process.env[k] = line.slice(i + 1).trim();
      }
    }
  } catch { /* no .env.local */ }
}

async function api(path, { method = "GET", body = null, cookie = "" } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", origin: BASE, ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : null,
  });
  const data = await res.json().catch(() => ({}));
  const setCookies = res.headers.getSetCookie?.() ?? [];
  return { res, data, setCookies };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  loadEnv();
  const email = `shots15a-${STAMP}@example.test`;
  const su = await api("/api/auth/sign-up/email", { method: "POST", body: { email, password: "correct-horse-123", name: "shots15a" } });
  if (!su.res.ok) throw new Error(`signup failed: ${JSON.stringify(su.data).slice(0, 200)}`);
  const session = (su.setCookies.find((c) => c.startsWith("meros.session_token=")) ?? "").split(";")[0];
  if (!session) throw new Error("no session cookie");

  const org = await api("/api/organizations", { method: "POST", body: { name: "S15A Shots" }, cookie: session });
  const orgSlug = org.data.organization.slug;
  const ws = await api("/api/workspaces", {
    method: "POST",
    body: { organizationId: org.data.organization.id, name: "Shot Workspace", slug: `shot15a-${STAMP}`, productName: "Demo Product" },
    cookie: session,
  });
  const wsSlug = ws.data.workspace.slug;
  const wsId = ws.data.workspace.id;
  const inc = await api("/api/incidents", {
    method: "POST", body: { workspaceSlug: wsSlug, title: "[fixture] Checkout 500s on Visa pay", severity: "high" }, cookie: session,
  });
  const incId = inc.data.incident.id;

  // Seed two [fixture] knowledge findings directly (layout QA only).
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(process.env.DATABASE_URL);
  const detail = (reason, extraRefs = {}) => JSON.stringify({
    explanation: "[fixture] Synthetic finding for layout verification only.",
    reason, whySurfaced: "[fixture] seeded row", unverified: ["[fixture] nothing unverified"],
    refs: { incidentIds: [incId], cardIds: [], postmortemIds: [], ...extraRefs },
  });
  await sql`
    insert into knowledge_findings (workspace_id, type, confidence, status, title, detail, fingerprint, entity_key, first_seen_at, last_seen_at)
    values (${wsId}, 'gap', 'high', 'open', '[fixture] Refund delays lack documented solution',
      ${detail("no_knowledge")}::jsonb, ${"fp-fix-" + STAMP}, ${"gap:" + incId}, now(), now()),
      (${wsId}, 'contradiction', 'low', 'open', '[fixture] Possible contradiction — needs review',
      ${detail("ambiguous_overlap")}::jsonb, ${"fp-fixc-" + STAMP}, ${"contradiction:aa+bb"}, now(), now())`;
  console.log("seeded findings");

  const browser = await chromium.launch();
  try {
    const parts = session.split("=");
    for (const [w, h, full] of [[390, 844, true], [1440, 900, true]]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h } });
      await ctx.addCookies([{ name: parts[0], value: parts.slice(1).join("="), domain: "localhost", path: "/" }]);
      const pg = await ctx.newPage();
      await pg.goto(`${BASE}/app/workspaces/${wsSlug}/fix-cards`, { waitUntil: "networkidle" });
      await sleep(1200);
      await pg.screenshot({ path: `${OUT}/s15a-fixcards-${w}.png`, fullPage: full });
      await pg.goto(`${BASE}/app/workspaces/${wsSlug}/incidents/${incId}`, { waitUntil: "networkidle" });
      await sleep(1200);
      await pg.screenshot({ path: `${OUT}/s15a-incident-${w}.png`, fullPage: full });
      await ctx.close();
    }
    const ctx = await browser.newContext({ viewport: { width: 768, height: 1024 } });
    await ctx.addCookies([{ name: parts[0], value: parts.slice(1).join("="), domain: "localhost", path: "/" }]);
    const pg = await ctx.newPage();
    await pg.goto(`${BASE}/app/workspaces/${wsSlug}/fix-cards`, { waitUntil: "networkidle" });
    await sleep(1200);
    await pg.screenshot({ path: `${OUT}/s15a-fixcards-768.png`, fullPage: true });
    await ctx.close();
  } finally {
    await browser.close();
  }

  const rows = await sql`select id from organizations where slug = ${orgSlug} limit 1`;
  if (rows[0]) await sql`delete from organizations where id = ${rows[0].id}`;
  await sql`delete from "user" where email = ${email}`;
  console.log("fixture org deleted; done");
}

main().catch((e) => { console.error("SHOT FAIL:", e instanceof Error ? e.message : e); process.exit(1); });
