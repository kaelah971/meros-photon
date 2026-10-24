// Demo-fixture setup via AUTHORIZED product workflows only — no direct DB
// writes, no threshold bypasses, no real customer data. DRY RUN by default
// (prints the plan, touches nothing).
//
// Stages (each needs explicit flags; nothing runs by accident):
//   --stage=stage    create labeled org + workspace + 3 customer identities.
//                    NO reports, NO preference changes.
//   --stage=status   read-only: operator pairing + prefs readiness.
//   --stage=trigger  send the 3 controlled reports (needs --confirm-trigger=YES,
//                    passing human gate, and no prior trigger marker).
//   --stage=cleanup  print the manual cleanup checklist (revoke/delete stay
//                    human dashboard actions).
//
// Usage:
//   node .fast-build/demo-fixture-setup.mjs                                   # dry run
//   node .fast-build/demo-fixture-setup.mjs --execute --stage=stage
//     --owner-email ... --owner-pass '...' [--origin ...]
//   HUMAN GATE (manual): pair phone, enable Radar opt-in, quiet hours OFF.
//   node .fast-build/demo-fixture-setup.mjs --execute --stage=status ...
//   node .fast-build/demo-fixture-setup.mjs --execute --stage=trigger ...
//     --confirm-trigger=YES
//
// Never logs credentials. Refuses repeat triggers (marker file) and refuses
// to trigger before pairing/thread/opt-in/quiet-hours checks pass.

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [];
  }).filter((e) => e.length === 2),
);
const EXECUTE = args.execute === true || args.execute === "true";
const STAGE = typeof args.stage === "string" ? args.stage : "";
const ORIGIN = String(args.origin || "https://meros-photon.vercel.app").replace(/\/+$/, "");
const STAMP = new Date().toISOString().slice(0, 10);
const RECORD_PATH = ".fast-build/demo-fixture.json";
const TRIGGER_MARKER = ".fast-build/demo-trigger.log";
const REPORTS = [
  "Hi, my card payment keeps failing at checkout with an error every time I try.",
  "Hello — I tried paying twice today and checkout shows an error after I enter my card.",
  "Hey, is checkout broken? My payment failed three times this morning with an error message.",
];

function plan() {
  console.log(`mode: ${EXECUTE ? `EXECUTE stage=${STAGE || "(missing — refusing)"}` : "dry-run (no requests made)"}`);
  console.log(`origin: ${ORIGIN}`);
  console.log("stage:   create [DEMO FIXTURE] org + workspace + 3 customer identities (no reports, no pref changes)");
  console.log("gate:    HUMAN — pair phone, Radar opt-in ON, quiet hours OFF (verified by --stage=status)");
  console.log("trigger: 3 synthetic reports via real chat (guarded: gate checks + one-shot marker)");
  console.log("capture: ONE real phone alert, matched to outbound history (manual screenshot)");
  console.log("cleanup: revoke opt-in + binding, delete org (manual dashboard actions)");
  if (!EXECUTE) console.log("\nNothing was sent. Add --execute --stage=<stage> to proceed (owner approval required per stage).");
}

if (!EXECUTE || !["stage", "status", "trigger", "cleanup"].includes(STAGE)) {
  plan();
  if (EXECUTE && !STAGE) console.error("Refusing: --execute needs an explicit --stage=stage|status|trigger|cleanup.");
  process.exit(0);
}

const ownerEmail = args["owner-email"];
const ownerPass = args["owner-pass"];
if (!ownerEmail || !ownerPass || ownerPass === true) {
  console.error("Refusing: --owner-email and --owner-pass are required (values never logged).");
  process.exit(1);
}

const jar = new Map();
function storeCookies(res) {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}
async function api(path, { method = "GET", body = null, useJar = true } = {}) {
  const res = await fetch(ORIGIN + path, {
    method,
    headers: { "content-type": "application/json", ...(useJar && jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } : {}) },
    body: body ? JSON.stringify(body) : null,
  });
  storeCookies(res);
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
async function ownerSession() {
  let s = await api("/api/auth/sign-up/email", { method: "POST", useJar: false, body: { email: ownerEmail, password: ownerPass, name: "Demo Owner" } });
  if (s.status !== 200 && s.status !== 201) s = await api("/api/auth/sign-in/email", { method: "POST", useJar: false, body: { email: ownerEmail, password: ownerPass } });
  if (s.status !== 200 && s.status !== 201) throw new Error(`owner auth failed (HTTP ${s.status})`);
}

function loadRecord() {
  if (!existsSync(RECORD_PATH)) throw new Error("No fixture record — run --stage=stage first.");
  return JSON.parse(readFileSync(RECORD_PATH, "utf-8"));
}

if (STAGE === "stage") {
  await ownerSession();
  console.log("owner session: ok");
  const org = await api("/api/organizations", { method: "POST", body: { name: `[DEMO FIXTURE] ${STAMP}`, description: "Automated Radar demo fixture. Safe to delete after capture." } });
  if (org.status !== 201) throw new Error(`org create failed (HTTP ${org.status})`);
  const ws = await api("/api/workspaces", {
    method: "POST",
    body: { organizationId: org.json.organization.id, name: "Demo Support", slug: `demo-fixture-${STAMP}`, productName: "Demo Store", productDescription: "Synthetic fixture storefront." },
  });
  if (ws.status !== 201 && ws.status !== 200) throw new Error(`workspace create failed (HTTP ${ws.status})`);
  const customers = [];
  for (let i = 0; i < 3; i++) {
    jar.clear();
    const email = `demo-customer-${STAMP}-${i + 1}@example.com`;
    const pass = `Demo-${STAMP}-${i + 1}-x`;
    let c = await api("/api/auth/sign-up/email", { method: "POST", useJar: false, body: { email, password: pass, name: `Demo Customer ${i + 1}` } });
    if (c.status !== 200 && c.status !== 201) c = await api("/api/auth/sign-in/email", { method: "POST", useJar: false, body: { email, password: pass } });
    if (c.status !== 200 && c.status !== 201) throw new Error(`customer ${i + 1} signup failed (HTTP ${c.status})`);
    customers.push({ email, pass });
  }
  writeFileSync(RECORD_PATH, JSON.stringify({ org: org.json.organization, workspaceSlug: `demo-fixture-${STAMP}`, customers, createdAt: new Date().toISOString() }, null, 2));
  console.log(`staged: org + workspace + 3 identities. NO reports sent, NO preference changes.`);
  console.log(`HUMAN GATE next: pair the phone, enable Radar opt-in, quiet hours OFF, then --stage=status.`);
}

if (STAGE === "status") {
  await ownerSession();
  const rec = loadRecord();
  const st = await api(`/api/photon/operator/status?workspaceSlug=${encodeURIComponent(rec.workspaceSlug)}`);
  console.log(`operator status: HTTP ${st.status} ${JSON.stringify(st.json)}`);
  const gate = st.status === 200 && st.json.paired && st.json.threadReady && st.json.proactiveReady && st.json.preferences?.quietHoursEnabled === false;
  console.log(gate ? "GATE PASS: paired + thread + proactive, quiet hours OFF. Trigger allowed after explicit approval." : "GATE HOLD: complete pairing / thread / proactive opt-in / quiet-hours OFF first. (Radar toggle itself is confirmed in the staff console.)");
}

if (STAGE === "trigger") {
  if (args["confirm-trigger"] !== "YES") {
    console.error("Refusing: --stage=trigger needs --confirm-trigger=YES (human authorization).");
    process.exit(1);
  }
  if (existsSync(TRIGGER_MARKER) && args["allow-retrigger"] !== "YES") {
    console.error(`Refusing: trigger already ran (${readFileSync(TRIGGER_MARKER, "utf-8").trim()}). Pass --allow-retrigger=YES to run again.`);
    process.exit(1);
  }
  await ownerSession();
  const rec = loadRecord();
  const st = await api(`/api/photon/operator/status?workspaceSlug=${encodeURIComponent(rec.workspaceSlug)}`);
  const gate = st.status === 200 && st.json.paired && st.json.threadReady && st.json.proactiveReady && st.json.preferences?.quietHoursEnabled === false;
  if (!gate) throw new Error(`Human gate incomplete: ${JSON.stringify(st.json).slice(0, 200)} — refusing to trigger.`);
  for (let i = 0; i < 3; i++) {
    jar.clear();
    const cu = rec.customers[i];
    const c = await api("/api/auth/sign-in/email", { method: "POST", useJar: false, body: { email: cu.email, password: cu.pass } });
    if (c.status !== 200) throw new Error(`customer ${i + 1} sign-in failed (HTTP ${c.status})`);
    const chat = await api("/api/chat", { method: "POST", body: { workspaceSlug: rec.workspaceSlug, message: REPORTS[i], clientMessageId: `demo-${STAMP}-c${i + 1}` } });
    console.log(`customer ${i + 1} report: HTTP ${chat.status}`);
    await new Promise((r) => setTimeout(r, 1500));
  }
  writeFileSync(TRIGGER_MARKER, `triggered ${new Date().toISOString()} workspace=${rec.workspaceSlug}\n`);
  console.log("Triggered. CAPTURE (manual): ONE phone alert → match to outbound history → screenshot.");
}

if (STAGE === "cleanup") {
  console.log("Manual cleanup (dashboard + phone):");
  console.log("1. Preferences: Radar opt-in OFF (and proactive OFF if it was off before).");
  console.log("2. Photon: revoke the fixture binding.");
  console.log("3. Delete the [DEMO FIXTURE] organization.");
  console.log("4. Restore the original operator pairing if it was moved.");
  console.log("5. Verify: no other workspace's bindings/outbounds changed.");
}
