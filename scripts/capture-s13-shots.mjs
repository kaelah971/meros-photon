#!/usr/bin/env node
/**
 * S13 visual QA + README screenshots.
 *
 * Captures REAL product UI (dev server) at mobile/tablet/desktop viewports.
 * Fixtures are synthetic, prefixed [fixture], and DELETED afterwards —
 * never presented as genuine production customer outcomes.
 *
 * Usage: npm run dev -- -p 3002  (in another shell), then:
 *   node scripts/capture-s13-shots.mjs
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
  const shots = [];
  const email = `shots-${STAMP}@example.test`;
  const password = "correct-horse-123";

  // 1. Staff signup (Better Auth email).
  const su = await api("/api/auth/sign-up/email", { method: "POST", body: { email, password, name: "shots" } });
  if (!su.res.ok) throw new Error(`signup failed: ${JSON.stringify(su.data).slice(0, 200)}`);
  const session = (su.setCookies.find((c) => c.startsWith("meros.session_token=")) ?? "").split(";")[0];
  if (!session) throw new Error("no session cookie from signup");
  console.log("signed up", email);

  // 2. Org + workspace.
  const org = await api("/api/organizations", { method: "POST", body: { name: "Screenshot Demo" }, cookie: session });
  if (!org.res.ok) throw new Error(`org failed: ${JSON.stringify(org.data).slice(0, 200)}`);
  const orgSlug = org.data.organization.slug;
  const ws = await api("/api/workspaces", {
    method: "POST",
    body: { organizationId: org.data.organization.id, name: "Shot Workspace", slug: `shot-ws-${STAMP}`, productName: "Demo Product" },
    cookie: session,
  });
  if (!ws.res.ok) throw new Error(`workspace failed: ${JSON.stringify(ws.data).slice(0, 300)}`);
  const wsSlug = ws.data.workspace.slug;
  console.log("workspace", wsSlug);

  // 3. Fixture incident (empty-state sections) + one with a note.
  const inc = await api("/api/incidents", {
    method: "POST",
    body: { workspaceSlug: wsSlug, title: "[fixture] Checkout 500s on Visa pay", severity: "high" },
    cookie: session,
  });
  if (!inc.res.ok) throw new Error(`incident failed: ${JSON.stringify(inc.data).slice(0, 300)}`);
  const incId = inc.data.incident.id;
  await api(`/api/incidents/${incId}/transition`, {
    method: "POST", body: { workspaceSlug: wsSlug, to: "investigating" }, cookie: session,
  });

  const browser = await chromium.launch();
  try {
    // Public pages across viewports.
    for (const [w, h] of [[360, 740], [375, 667], [390, 844], [430, 932], [768, 1024], [1440, 900]]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h } });
      const pg = await ctx.newPage();
      await pg.goto(`${BASE}/`, { waitUntil: "networkidle" });
      await pg.screenshot({ path: `${OUT}/s13-landing-${w}.png` });
      shots.push(`s13-landing-${w}.png`);
      await pg.goto(`${BASE}/login`, { waitUntil: "networkidle" });
      await pg.screenshot({ path: `${OUT}/s13-login-${w}.png` });
      shots.push(`s13-login-${w}.png`);
      await ctx.close();
    }

    // Authenticated staff flows.
    const cookieParts = session.split("=");
    for (const [w, h, full] of [[390, 844, true], [768, 1024, true], [1440, 900, true], [1440, 500, false]]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h } });
      await ctx.addCookies([{ name: cookieParts[0], value: cookieParts.slice(1).join("="), domain: "localhost", path: "/" }]);
      const pg = await ctx.newPage();
      await pg.goto(`${BASE}/app/workspaces/${wsSlug}`, { waitUntil: "networkidle" });
      await sleep(800);
      await pg.screenshot({ path: `${OUT}/s13-console-${w}x${h}${full ? "" : "-short"}.png`, fullPage: full });
      shots.push(`s13-console-${w}x${h}${full ? "" : "-short"}.png`);
      await pg.goto(`${BASE}/app/workspaces/${wsSlug}/incidents/${incId}`, { waitUntil: "networkidle" });
      await sleep(1200);
      await pg.screenshot({ path: `${OUT}/s13-incident-${w}x${h}${full ? "" : "-short"}.png`, fullPage: full });
      shots.push(`s13-incident-${w}x${h}${full ? "" : "-short"}.png`);
      await pg.goto(`${BASE}/app/workspaces/${wsSlug}/fix-cards`, { waitUntil: "networkidle" });
      await sleep(800);
      await pg.screenshot({ path: `${OUT}/s13-fixcards-${w}x${h}.png`, fullPage: full });
      shots.push(`s13-fixcards-${w}x${h}.png`);
      await ctx.close();
    }
  } finally {
    await browser.close();
  }

  // 4. Delete fixture org (cascades workspaces/incidents/cards).
  const { neon } = await import("@neondatabase/serverless");
  const { organizationIdForSlug } = await import("../lib/tenant.js").catch(() => ({ organizationIdForSlug: null }));
  void organizationIdForSlug;
  const sql = neon(process.env.DATABASE_URL);
  const rows = await sql`select id from organizations where slug = ${orgSlug} limit 1`;
  if (rows[0]) await sql`delete from organizations where id = ${rows[0].id}`;
  const { default: { readFileSync: _r } } = await import("node:fs").catch(() => ({ default: { readFileSync } }));
  void _r;
  await sql`delete from "user" where email = ${email}`;
  console.log("fixture org deleted");

  console.log(`captured ${shots.length} shots`);
}

main().catch((e) => {
  console.error("SHOT FAIL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
