<div align="center">

# MEROS

**Solve it once. Remember it for everyone.**

Memory-native customer support — turning confirmed resolutions into reusable organizational memory, while keeping customer context private.

[![MEROS PHOTON](https://img.shields.io/badge/MEROS_PHOTON-Live_App-00E599?style=for-the-badge&logo=vercel&logoColor=white)](https://meros-photon.vercel.app)
[![OPEN MEROS](https://img.shields.io/badge/OPEN_MEROS-Original_Demo-888888?style=for-the-badge&logo=vercel&logoColor=white)](https://usemeros.vercel.app)
[![WATCH DEMO](https://img.shields.io/badge/WATCH_DEMO-YouTube-FF0000?style=for-the-badge&logo=youtube&logoColor=white)](https://youtu.be/9kmpZT66M4k?si=e17SXph7HeJx7L5x)
[![READ THE STORY](https://img.shields.io/badge/READ_THE_STORY-Medium-000000?style=for-the-badge&logo=medium&logoColor=white)](https://medium.com/@kaelah679/how-meros-turns-support-conversations-into-shared-memory-20fa5ae4e4b1)

![Walrus Mainnet](https://img.shields.io/badge/Walrus-Mainnet-00C853?style=flat-square)
![38 Mainnet Memories](https://img.shields.io/badge/Mainnet_Memories-38-00C853?style=flat-square)
![MemWal SDK](https://img.shields.io/badge/MemWal-SDK-4D7CFE?style=flat-square)
![Gemini](https://img.shields.io/badge/Gemini-Powered-4285F4?style=flat-square)
![Neon](https://img.shields.io/badge/Neon-Postgres-00E599?style=flat-square)
![Better Auth](https://img.shields.io/badge/Better_Auth-Sessions-111111?style=flat-square)
![Next.js](https://img.shields.io/badge/Next.js-15-000000?style=flat-square&logo=next.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-Strict-3178C6?style=flat-square&logo=typescript&logoColor=white)

[Live App (Photon)](https://meros-photon.vercel.app) · [Original Meros demo](https://usemeros.vercel.app) · [Demo Video](https://youtu.be/9kmpZT66M4k?si=e17SXph7HeJx7L5x) · [Medium Article](https://medium.com/@kaelah679/how-meros-turns-support-conversations-into-shared-memory-20fa5ae4e4b1) · [Walrus Proof](#walrus-memory-proof) · [Photon operations](#meros-photon--incident-operations) · [Architecture](#architecture) · [Demo Flow](#demo-flow-for-judges) · [Running Locally](#running-locally)

> **Two deployments, one lineage.** [Meros Photon](https://meros-photon.vercel.app) is the current operations product (S1–S13 below: incident lifecycle, approval-controlled recovery, Resolution Watch, evidence-backed closure, Operator Memory). [usemeros.vercel.app](https://usemeros.vercel.app) is the preserved original Walrus Meros hackathon demo (Alice → staff → Bob shared-memory loop, Walrus Mainnet proof). They are not the same deployment; Memory Mainnet proof below belongs to the original demo and is kept as history.

</div>

---

## Walrus Memory Proof

Live on **Walrus Memory Mainnet** — 38 blobs, above the 10-memory minimum. Proven by the Alice → Bob cross-customer shared-memory flow.

| | |
|---|---|
| **Network** | Walrus Memory Mainnet |
| **Integration** | MemWal SDK (`@mysten-incubation/memwal`) |
| **Connection** | `MemWal.create(...)` |
| **Durable writes** | `rememberAndWait(...)` |
| **Semantic recall** | `recall(...)` |
| **Mainnet memories / blobs** | 38 |
| **Hackathon required minimum** | 10 |
| **Demo proof** | Alice → Bob cross-customer shared-memory flow |

**Walrus Memory Agent ID:**
`0xb812495947fc6e4276569d60da39da7cc86a3a1b47351abf9a6635987791229a`

**MemWal Delegate Public Key:**
`9123dfc8a526eed234961f63f533665679bbda9c7faafa1d201a0dfa7b4084c5`

---

Meros remembers each customer privately and turns confirmed, staff-approved resolutions into shared support memory. Returning customers continue with context. New customers with a recurring issue start from the proven fix — without seeing anyone else's history.

## The problem

Support forgets in two directions.

Customers return and repeat their environment, the original symptom, and steps that already failed. Teams solve a recurring issue once, then rediscover the same fix weeks later because the resolution disappeared with the closed conversation. A transcript archive does not fix this: useful facts stay buried, stale guesses look like facts, and personal context has no boundary.

## What Meros does

Meros keeps two separate memories for support:

- **Private memory** — each customer's durable context, recalled across sessions.
- **Shared memory** — only confirmed, sanitized, human-approved fixes, recalled for future customers with the same symptom.

Every answer shows which memory influenced it, and any answer can be rerun with memory disabled to show what changed.

> Share the fix. Keep the customer private.

---

## Meros Photon — incident operations

Meros Photon ([live](https://meros-photon.vercel.app)) extends the memory loop above into a full incident-operations product. After a support conversation becomes a tracked incident, Photon carries it through investigation, approval-controlled recovery, resolution monitoring, evidence-backed closure, and reusable operator memory — with a human decision at every consequential step.

### Incident workspace (staff console)

![Photon staff console](docs/screenshots/s13-console-1440x900.png)

Open issues, customers, conversations, pending Fix Cards, and shared fixes at a glance, plus iMessage operator pairing, notification preferences, and the customer support URL.

### Incident detail — evidence, plans, watch, closure

![Photon incident detail, desktop](docs/screenshots/s13-incident-1440x900.png)

One page carries the whole lifecycle: linked customers/conversations, the source-backed Evidence Brief, visual snapshots, Related Fix Cards, staged Recovery Plans with approval controls, Resolution Watch, and Closure Readiness with the postmortem under review. Empty states are honest — nothing is invented when evidence is missing.

![Photon incident detail, mobile](docs/screenshots/s13-incident-390x844.png)

The same page at 390px: sections stack, actions wrap, nothing overlaps or clips.

### Fix Card review — shared resolutions

![Photon Fix Card review queue](docs/screenshots/s13-fixcards-1440x900.png)

Resolved issues with a grounded, reusable fix appear here for staff approval — nothing becomes shared on its own. S13 operator-memory candidates proposed from closed incidents land in this same queue.

### What Photon adds (S1–S13)

- **Photon operator integration** — iMessage pairing, staff presence, quiet hours, and explicit test notifications. No automatic customer messages, ever.
- **Incident detection & investigation (S4/S5)** — customer reports become tracked incidents with a validated lifecycle (`detected → investigating → ready_for_action → recovering → monitoring → resolved`), linked conversations/customers, and append-only audit history.
- **Evidence briefs & snapshots (S6/S7)** — source-backed briefs assembled from linked reports (every claim cites a message), plus visual evidence snapshots sent only by explicit operator action.
- **Approval-controlled recovery (S9/S10)** — grounded recovery proposals, then plan-specific approvals with risk acknowledgment, expiry, and scope hashing. No automatic execution exists anywhere: approved work is recorded as manual, operator-reported steps with independent verification.
- **Resolution Watch (S11)** — durable post-intervention monitoring that distinguishes customer-reported improvement, persistence, and regression from real follow-up evidence. Silence is never proof.
- **Evidence-backed closure & postmortems (S12)** — closure requires an eligible `monitoring` incident, a confirmed Resolution Watch, fresh evidence, and a current postmortem draft. The generic status route cannot bypass review; reopening preserves finalized history.
- **Operator Memory (S13)** — verified closures yield grounded memory candidates (explicit staff proposal from a finalized postmortem), reviewed through the existing Fix Card flow, recalled in later incidents with provenance (`Operator memory · verified outcome · postmortem <id>`) and workspace isolation.

### Privacy and approval boundaries

- Workspace isolation on every read and mutation; cross-workspace recall is structurally excluded.
- No automatic publication: Fix Cards, memories, and closures all require explicit staff decisions; failed Walrus writes are reported as failures, never successes.
- Redaction gates block emails, secrets, key patterns, and namespace leaks; raw transcripts are never inserted into shared memory.
- Administrative closures are audited as non-verified and can never become shared memory.
- Recalled memory is untrusted context for investigation, never instructions; nothing auto-executes, auto-messages, or auto-closes.

### Known limitations

- No provider-backed recovery executors exist: recovery is manual-operator work tracked in Meros, not automation.
- Postmortem root causes stay `unknown`/`unverified` — Meros has no root-cause verification mechanism and never claims proof.
- S13 memories recall as `documented_unverified` under S8 tier semantics (a `verified_fix` tier additionally requires a resolved linked support issue, which incident-derived memory does not fabricate).
- Screenshots above are synthetic fixtures (marked `[fixture]`, since deleted), captured with Playwright via `scripts/capture-s13-shots.mjs` across 360–1440px viewports plus a short-height pass; the bottom-left “N” badge in shots is the Next.js dev indicator, absent in production.

---

## Product Screens

Real product UI captured from the live app at desktop viewport. Shots use a fresh demo workspace (removed afterwards); the memory behavior is the same Alice → staff → Bob loop described below.

### Landing — memory-native support

![Meros landing hero](docs/screenshots/meros-landing.png)

Private memory, shared fixes, and product knowledge, orbiting one promise: solve it once, remember it for everyone.

### Workspace console — staff overview

![Meros staff workspace console](docs/screenshots/meros-workspace.png)

Live issue, customer, and conversation counts plus the customer support URL that opens the chat below.

### Customer chat — private-memory experience

![Meros customer support chat](docs/screenshots/meros-private-memory.png)

Signed-in sessions recall private memory across conversations, and each answer discloses exactly which memory it used.

### Fix Card review — shared resolutions

![Meros Fix Card review queue](docs/screenshots/meros-shared-fix.png)

Resolved issues with a grounded, reusable fix appear here for staff approval — nothing becomes shared on its own.

### Product knowledge — organizational memory

![Meros product knowledge view](docs/screenshots/meros-knowledge.png)

Canonical workspace material lives in Neon; Walrus holds only the semantic index.

### Memory, proven — the reusable-memory loop

![Meros reusable memory loop](docs/screenshots/meros-memory-proof.png)

Alice resolves, staff approve, the fix becomes shared memory, and Bob skips the long path — while Alice's private context stays locked.

*Captured with Playwright via `scripts/capture-readme-shots.mjs`; the throwaway demo workspace was deleted afterwards.*

---

## How it works: Alice → staff → Bob

The core loop, end to end:

1. **Alice** reports a CSV import failure at `/support/<workspace>`. The conversation and messages persist in Neon.
2. Meros recalls in parallel: Alice's **private memory**, staff-approved **shared fixes**, and workspace **product knowledge**, then asks Gemini to answer with that context.
3. Alice confirms the resolution works.
4. Meros drafts a sanitized **Fix Card candidate** (Symptom / Cause / Resolution).
5. Staff open the workspace console and review the exact candidate text. They can edit it before anything is shared.
6. Staff choose **Save shared** or **Keep private**. `Keep private` performs zero Walrus writes.
7. On approval, the reviewed fix is written as a new blob into the workspace **shared Walrus namespace**.
8. **Bob** later signs in on the same workspace and describes the same symptom.
9. Meros recalls the proven shared fix and checks that path first.
10. Bob gets the resolution. Nothing private about Alice travels with it.

Without memory: generic troubleshooting from scratch.

With Meros: the organization starts from what already worked.

---

## Memory architecture

Three durable semantic planes live in Walrus. One short-lived thread lives in Neon.

| Plane | Scope | Namespace pattern |
|---|---|---|
| Product knowledge | One workspace | `meros:v2:workspace:<workspace-id>:knowledge` |
| Shared support memory | One workspace, staff-approved fixes only | `meros:v2:workspace:<workspace-id>:shared:fixes` |
| Customer private memory | One customer in one workspace | `meros:v2:workspace:<workspace-id>:customer:<customer-id>` |
| Current conversation | One support thread | Persisted in Neon; recalled as recent turns, not semantic memory |

IDs are immutable content-derived hex (`lib/tenant.ts`). Namespaces are derived server-side from those IDs. Clients never submit IDs or namespaces.

```mermaid
flowchart TB
    Customer([Customer message]) --> Thread[Support conversation<br/>Neon persisted thread]
    Thread --> Recall[Recall in parallel<br/>server-derived namespaces]
    Recall --> Priv[Private memory<br/>this customer only]
    Recall --> Shared[Shared fixes<br/>staff-approved only]
    Recall --> Know[Product knowledge<br/>this workspace only]
    Priv & Shared & Know --> Gemini[Gemini<br/>reasons over recalled context]
    Gemini --> Answer[Answer + provenance<br/>private / shared / knowledge]
```

On confirmed resolution:

```mermaid
flowchart LR
    Conv[Resolved conversation] --> Card[Grounded Fix Card candidate]
    Card --> Review[Staff review + edit]
    Review -->|Save shared| Walrus[(Walrus shared namespace<br/>new immutable blob)]
    Review -->|Keep private| PrivateOnly[Stays private<br/>zero Walrus writes]
    Walrus --> Future[Future customers<br/>recall the proven fix]
```

## Why Walrus

Walrus is the memory layer, not an accessory store.

- **Durable semantic memory.** Private facts, shared fixes, and product knowledge are written with `rememberAndWait` and recalled semantically by issue context. A write counts as stored only after Walrus confirms completion with a blob reference.
- **Namespace isolation as the privacy boundary.** One customer's facts live under that customer's namespace. Another customer in the same workspace resolves to a different namespace and cannot recall them. One workspace cannot recall another workspace's planes.
- **Immutable history.** Blobs are never edited in place. Corrections write a new blob; the old record stays auditable while active recall filters it out.

What Walrus does **not** do:

- It does not route requests, own product state, or authenticate humans.
- Neon owns relational state: users, orgs, workspaces, customers, conversations, messages, issues, Fix Card metadata, blob references.
- Gemini reasons over recalled context and produces answers, extractions, and candidate summaries. Gemini is not the memory store.
- Better Auth owns human identity and sessions. Memory identity (`workspace → customer`) is derived server-side from that session.

Recalled memory is treated as untrusted data in prompts: fenced, labeled, never instructions. The same fencing applies to uploaded file content.

---

## Memory on vs off: Compare without memory

Each assistant answer carries provenance — the **Memory Lens** ("Why this answer?") lists whether private, shared, or product-knowledge hits influenced it, with blob references.

**Compare without memory** reruns the same user question through `POST /api/compare` with the same conversation context but **zero Walrus recall calls**. The result is shown beside the original:

- **Memory on:** recalls a proven past resolution and asks the sharper first question.
- **Memory off:** has only the current thread and model knowledge, so it typically falls back to generic troubleshooting.

This is the causal proof judges can run on any answer: same request, same thread, memory removed.

---

## Privacy by design

- Private memory stays in `…:customer:<customer-id>`. Cross-customer recall is structurally impossible, not a query filter.
- Shared memory is scoped to one workspace (`…:shared:fixes`). Workspaces cannot read each other.
- Nothing becomes shared because Gemini generated it. Generation proposes; only a human disposes.
- Sharing requires, in order: a confirmed resolution → a Fix Card candidate → staff review of the exact text → explicit **Save shared**.
- Candidates pass redaction (emails, secrets, key patterns, namespace/ID leaks) and grounding checks (resolution must match user-confirmed action; Symptom/Cause claims must trace to customer-provided evidence, clause by clause).
- Raw uploaded attachment bytes are request-scoped: they ride one Gemini request as labeled user data and are never stored in Walrus. Only filename/type/kind metadata may persist.
- Customer identities and private chat history are never inserted into shared Fix Cards.

---

## Correcting shared memory

Walrus blobs are immutable, so Meros never rewrites a shared fix. Correction is a supersession:

1. Staff edit a shared card and save the correction.
2. Meros writes a **new** corrected blob to the shared namespace.
3. Neon marks the old Fix Card row `superseded` and sets `superseded_by_fix_card_id` to the new row. The old blob ID is preserved for audit.
4. Chat recall loads the workspace deny-list via `listSupersededSharedBlobs` and drops those blob IDs with `dropSupersededSharedHits` before building context.
5. The Shared console shows active fixes plus superseded history — recallable vs. auditable, never mixed.

A wrong fix therefore stays visible as history but stops influencing answers.

---

## Multimodal support

The customer composer supports text plus attachments and voice, kept small on purpose — memory remains the product:

- **Images:** PNG, JPG/JPEG, WEBP
- **Documents:** PDF, TXT, CSV, MD
- **Voice:** browser-recorded audio (WebM, MP4/M4A, MP3, OGG/OGA, WAV)
- **Limits:** up to 3 files per message, 2 MiB per file, voice clips up to 180 seconds
- **Reasoning:** attachments are sent as native Gemini multimodal parts on the current turn only, labeled as untrusted user data
- **Persistence:** only `{ filename, mimeType, kind }` metadata may be stored with the message; raw bytes never reach DB rows or Walrus

---

## Architecture

| Layer | Responsibility |
|---|---|
| Walrus (MemWal, Mainnet) | Durable semantic memory: private / shared / knowledge planes, recall + `rememberAndWait` writes |
| Neon Postgres | Relational and canonical state: identity registry, conversations, messages, issues, Fix Cards, knowledge source text, blob references |
| Gemini | Answer generation, fact extraction, Fix Card drafting; primary `gemini-3.5-flash-lite` with `gemini-3.7-flash` fallback on retryable failures |
| Better Auth | Human identity and sessions; product identity is derived server-side from the session |
| Next.js App Router | Product UI, API routes, server gates |

Key flows:

- `POST /api/chat` — authenticate → persist user message → bounded recall (10s per plane) → Gemini answer → persist answer + provenance → optional Fix Card candidate on explicit resolution.
- `POST /api/memory/capture` — after the answer renders, extract durable facts and `rememberPrivate` into the customer's namespace; endpoint-level skips stay silent so the UI only warns on a real failed write.
- `POST /api/compare` — same question, same thread, no Walrus calls; baseline for the memory-on/off proof.
- `POST /api/fix-cards/[id]/review` — staff-only; `shared` writes a new blob, `kept_private` writes nothing, correction supersedes.
- `POST /api/workspaces/[slug]/knowledge` — workspace product material, canonical in Neon, indexed in the knowledge namespace.

---

## Tech stack

From `package.json` — no hidden dependencies:

- `next` 15 (App Router), `react` 19
- `@mysten-incubation/memwal` (Walrus Memory client), `@mysten/seal`, `@mysten/sui`
- `@neondatabase/serverless` + `pg` (Neon access)
- `better-auth` (sessions)
- `@google/genai` (Gemini)
- `tailwindcss`, `typescript`, `vitest`

---

## Repository structure

```text
app/                  Product routes + API routes
  support/[workspaceSlug]/  Authenticated customer chat
  app/workspaces/[slug]/    Staff console (overview, conversations, customers, fix-cards, shared, knowledge)
  api/chat|compare|memory|fix-cards|workspaces/  Memory and workflow endpoints
components/
  support-chat.tsx      Customer chat, Memory Lens, compare, private-capture status
  fix-card-review.tsx   Staff edit-before-share + correction UI
  customer-gate.tsx     Signed-out customer sign-in gate
lib/
  walrus.ts             remember/recall, bounded recall, namespace writes
  tenant.ts             Immutable IDs + v2 namespace derivation
  tenant-store.ts       Server-side workspace→customer resolution
  chat-memory.ts        Recall normalization + superseded-blob filter
  support-memory.ts     Grounding, redaction, extraction validation
  support-ops.ts        Conversations, issues, Fix Card persistence
  knowledge.ts          Product knowledge canonical + index
  attachments.ts        Validation + Gemini parts (bytes never persist)
  gemini.ts             Generation with timeouts + model fallback
db/
  schema.sql            Neon tables incl. fix_cards supersession columns
  better-auth-schema.sql Auth tables
docs/                 PRD, product idea, brand messaging, design notes
scripts/
  db-migrate.mjs        Additive/idempotent schema setup
```

---

## Running locally

```bash
npm install
npm run db:migrate
npm run dev
```

Open the app at the origin configured in `BETTER_AUTH_URL` (local default `http://localhost:3002`).

Verify:

```bash
npm test
npm run typecheck
npm run build
```

## Environment variables

Copy `.env.example` to `.env.local` and fill in real values. **Never commit `.env.local`.**

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Neon Postgres connection string |
| `MEMWAL_PRIVATE_KEY` | Walrus delegate key (hex or `suiprivkey1…`), server-only |
| `MEMWAL_ACCOUNT_ID` | Walrus Memory account object ID (`0x…`), server-only |
| `MEMWAL_SERVER_URL` | Walrus relayer URL; defaults to Mainnet relayer when unset |
| `MEROS_ID_SALT` | Salt for legacy bootstrap hashing; changing it remaps legacy namespaces |
| `GEMINI_API_KEY` | Gemini key for answers, extraction, Fix Card drafting |
| `GEMINI_MODEL` | Primary model ID; defaults to `gemini-3.5-flash-lite` |
| `GEMINI_FALLBACK_MODEL` | Fallback model ID; used only after retryable primary failures |
| `BETTER_AUTH_URL` | Public origin of the deployment; requests must match it |
| `BETTER_AUTH_SECRET` | Session signing secret; required in production, stable across restarts |
| `MEROS_ENABLE_LEGACY_DEV_IDENTITY` | Local diagnostics only (`/chat`, `/dev`, raw access-code endpoints). Unset means session-only. Never honored in production. |

`GET /api/health` reports safe config booleans only — no secrets, no Walrus/Gemini calls.

---

## Tests

```bash
npm test
```

The suite mixes fast pure tests and marked live integration tests (live Neon; Walrus-backed where marked). Scope covers tenant and namespace isolation, private capture status semantics, Fix Card grounding and review gates, shared-fix supersession and recall filtering, product-knowledge recall, multimodal validation and isolation, auth and session behavior, recall timeouts, Gemini retry bounds, and fixture hygiene that keeps test rows scoped to tracked IDs/emails.

---

## Demo flow for judges

1. Open `/support/<workspace>` as **Alice**. Ask the CSV import question without giving away the cause.
2. Work the thread, then confirm the fix in your own words (e.g. that re-exporting as comma-delimited UTF-8 worked).
3. Open the staff console at `/app/workspaces/<workspace>/fix-cards`. Open the pending Fix Card.
4. Inspect the exact Symptom/Cause/Resolution text, edit if needed, then **Save shared**. Note the new Walrus blob reference.
5. Sign out, then sign in as **Bob** on the same `/support/<workspace>` — a clean account with no private history.
6. Ask the equivalent symptom question without mentioning delimiters. Bob should get the proven fix first.
7. Open **Why this answer?** and confirm a `shared` provenance entry with the new blob.
8. Run **Compare without memory** on that answer and confirm the baseline returns to generic troubleshooting.
9. Optional: correct the shared card, confirm the old row shows superseded history, and confirm recall now uses only the corrected blob.

## Deployment / live demo

- **Live app (Photon):** https://meros-photon.vercel.app
- **Original Meros demo (preserved):** https://usemeros.vercel.app
- **Demo video:** https://youtu.be/9kmpZT66M4k?si=e17SXph7HeJx7L5x
- **Medium article:** https://medium.com/@kaelah679/how-meros-turns-support-conversations-into-shared-memory-20fa5ae4e4b1

---

## Built for

Walrus Session 8 — Chatbots That Remember

## License

No license file is present in the repository. All rights reserved by default until a license is added.
