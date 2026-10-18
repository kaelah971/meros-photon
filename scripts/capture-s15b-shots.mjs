#!/usr/bin/env node
/** S15B visual QA: operator panel Radar toggle + readiness line. Fixtures deleted afterwards. */
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
  return { res, data, setCookies: res.headers.getSetCookie?.() ?? [] };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  loadEnv();
  const email = `shots15b-${STAMP}@example.test`;
  const su = await api("/api/auth/sign-up/email", { method: "POST", body: { email, password: "correct-horse-123", name: "shots15b" } });
  if (!su.res.ok) throw new Error(`signup failed: ${JSON.stringify(su.data).slice(0, 200)}`);
  const session = (su.setCookies.find((c) => c.startsWith("meros.session_token=")) ?? "").split(";")[0];
  if (!session) throw new Error("no session cookie");
  const org = await api("/api/organizations", { method: "POST", body: { name: "S15B Shots" }, cookie: session });
  const ws = await api("/api/workspaces", {
    method: "POST",
    body: { organizationId: org.data.organization.id, name: "Shot Workspace", slug: `shot15b-${STAMP}`, productName: "Demo" },
    cookie: session,
  });
  const wsSlug = ws.data.workspace.slug;
  const browser = await chromium.launch();
  try {
    for (const [w, h] of [[390, 844], [1440, 900]]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h } });
      const [k, ...v] = session.split("=");
      await ctx.addCookies([{ name: k, value: v.join("="), domain: "localhost", path: "/" }]);
      const pg = await ctx.newPage();
      await pg.goto(`${BASE}/app/workspaces/${wsSlug}`, { waitUntil: "networkidle" });
      await sleep(1000);
      const panel = pg.locator("section[aria-label='iMessage Operator']");
      await panel.scrollIntoViewIfNeeded().catch(() => null);
      await pg.screenshot({ path: `${OUT}/s15b-operator-${w}.png` });
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(process.env.DATABASE_URL);
  const rows = await sql`select id from organizations where slug = ${org.data.organization.slug} limit 1`;
  if (rows[0]) await sql`delete from organizations where id = ${rows[0].id}`;
  await sql`delete from "user" where email = ${email}`;
  console.log("done, fixtures deleted");
}
main().catch((e) => { console.error("SHOT FAIL:", e instanceof Error ? e.message : e); process.exit(1); });
