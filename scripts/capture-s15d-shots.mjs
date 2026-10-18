#!/usr/bin/env node
/** S15D visual QA: evidence page + PNG at desktop/tablet/mobile. Fixtures deleted afterwards. */
import { readFileSync, writeFileSync } from "node:fs";
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
  const email = `shots15d-${STAMP}@example.test`;
  const su = await api("/api/auth/sign-up/email", { method: "POST", body: { email, password: "correct-horse-123", name: "shots15d" } });
  if (!su.res.ok) throw new Error(`signup failed: ${JSON.stringify(su.data).slice(0, 200)}`);
  const session = (su.setCookies.find((c) => c.startsWith("meros.session_token=")) ?? "").split(";")[0];
  const org = await api("/api/organizations", { method: "POST", body: { name: "S15D Shots" }, cookie: session });
  const ws = await api("/api/workspaces", {
    method: "POST",
    body: { organizationId: org.data.organization.id, name: "Shot Workspace", slug: `shot15d-${STAMP}`, productName: "Demo" },
    cookie: session,
  });
  const wsSlug = ws.data.workspace.slug;
  const inc = await api("/api/incidents", {
    method: "POST", body: { workspaceSlug: wsSlug, title: "[fixture] Checkout 500s on Visa pay", severity: "high" }, cookie: session,
  });
  const incId = inc.data.incident.id;

  // Populated-view fixtures: customer + conversation + 2 messages + link +
  // current brief (synthetic content, deleted afterwards with the org).
  const { default: pg } = await import("pg");
  const { createHash } = await import("node:crypto");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const wsRow = (await pool.query("select id from workspaces where slug = $1", [wsSlug])).rows[0];
  const wsId = wsRow.id;
  const custHash = createHash("sha256").update(`shot15d-${STAMP}`, "utf8").digest("hex");
  const custId = createHash("sha256").update(`meros:v1:cu:${wsId}:${custHash}`, "utf8").digest("hex").slice(0, 32);
  await pool.query("insert into customers (id, workspace_id, bootstrap_identity_hash) values ($1, $2, $3)", [custId, wsId, custHash]);
  const conv = (await pool.query(
    "insert into conversations (workspace_id, customer_id, title, status) values ($1, $2, 'Visa checkout fails', 'open') returning id"
  , [wsId, custId])).rows[0];
  await pool.query(
    "insert into messages (conversation_id, client_id, role, content) values ($1, $2, 'user', $3), ($1, $4, 'user', $5)",
    [conv.id, `shot-${STAMP}-1`, "Visa checkout fails with HTTP 500 every time today", `shot-${STAMP}-2`, "Still 500 on Visa, second attempt failed too"]
  );
  await pool.query("insert into incident_conversations (incident_id, conversation_id, added_by_user_id) values ($1, $2, null)", [incId, conv.id]);
  const msgs = (await pool.query("select id from messages where conversation_id = $1 order by created_at", [conv.id])).rows;
  const briefFindings = {
    facts: [
      { observation: "Visa checkout returns HTTP 500", identifiers: ["500", "Visa"], sources: [msgs[0].id] },
      { observation: "Same 500 on Visa checkout at peak", identifiers: ["500"], sources: [msgs[1].id] },
    ],
    corroborated: [{ pattern: "Same 500 on Visa checkout", sources: [msgs[0].id, msgs[1].id] }],
    contradictions: [{ description: "One reporter sees 402 instead of 500", between: [msgs[0].id, msgs[1].id] }],
    unknowns: ["Root cause unknown"],
    hypotheses: [{ text: "Might be a gateway timeout", basedOn: [msgs[0].id] }],
  };
  await pool.query(
    "insert into incident_evidence_briefs (incident_id, workspace_id, status, version, fingerprint, findings, source_count, generated_at) values ($1, $2, 'current', 1, $3, $4, 2, now())",
    [incId, wsId, `fp-shot-${STAMP}`, JSON.stringify(briefFindings)],
  );
  await pool.end();

  const browser = await chromium.launch();
  try {
    const parts = session.split("=");
    for (const [w, h] of [[390, 844], [768, 1024], [1440, 900]]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h } });
      await ctx.addCookies([{ name: parts[0], value: parts.slice(1).join("="), domain: "localhost", path: "/" }]);
      const pg = await ctx.newPage();
      await pg.goto(`${BASE}/app/workspaces/${wsSlug}/incidents/${incId}/evidence`, { waitUntil: "networkidle" });
      await sleep(1200);
      await pg.screenshot({ path: `${OUT}/s15d-evidence-${w}.png`, fullPage: true });
      await ctx.close();
    }
    // PNG direct fetch at phone-ish scale check via small viewport page embed
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.addCookies([{ name: parts[0], value: parts.slice(1).join("="), domain: "localhost", path: "/" }]);
    const pg = await ctx.newPage();
    const pngRes = await pg.request.get(`${BASE}/api/incidents/${incId}/evidence-image?workspaceSlug=${wsSlug}`);
    const buf = await pngRes.body();
    writeFileSync(`${OUT}/s15d-evidence-png-direct.png`, buf);
    console.log("png bytes:", buf.length, "status:", pngRes.status(), "type:", pngRes.headers()["content-type"]);
    await ctx.close();
  } finally {
    await browser.close();
  }
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(process.env.DATABASE_URL);
  const rows = await sql`select id from organizations where slug = ${org.data.organization.slug} limit 1`;
  if (rows[0]) await sql`delete from organizations where id = ${rows[0].id}`;
  await sql`delete from "user" where email = ${email}`;
  console.log("fixture org deleted; done");
}
main().catch((e) => { console.error("SHOT FAIL:", e instanceof Error ? e.message : e); process.exit(1); });
