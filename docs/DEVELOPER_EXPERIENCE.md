# Building Meros Photon: a developer experience and engineering report

**Project:** [Meros Photon](https://github.com/kaelah971/meros-photon) · **Production:** [meros-photon.vercel.app](https://meros-photon.vercel.app)  
**Coverage:** original Meros memory prototype (October 7–9, 2026); Photon integration and production iteration (October 16–24, 2026)  
**Snapshot:** October 24, 2026 · deployed code `5711a08`  
**Audience:** Photon / Spectrum engineers, developer advocates, agent builders, and technical reviewers

> **Summary:** We built an incident-operations copilot that detects recurring customer complaints, proactively reaches an authorized owner in iMessage through Photon/Spectrum, answers natural questions about the issue, and produces a source-grounded recovery-plan draft after explicit confirmation. We verified an unsolicited notification on a physical iPhone. Getting there surfaced real problems involving project/line onboarding, delivery observability, ambiguous incident context, serverless idempotency, transcript truncation, and message-length constraints. This is an evidence-based field report, not a claim that every infrastructure path is proven.

## Reading this report: evidence labels

- **LIVE VERIFIED** — observed in the deployed product, durable production records, and/or the operator's real device.
- **HANDSET VERIFIED** — an actual device screenshot or operator observation, separate from transport-provider acceptance.
- **CODE VERIFIED** — confirmed by inspected repository implementation at the referenced commit.
- **TEST VERIFIED** — exercised by a focused automated test; not automatically a production observation.
- **REPORTED / HISTORICAL** — recorded in build logs, prior release reports, or earlier demos; historical context is not current production proof.
- **UNVERIFIED** — cannot currently distinguish causes or confirm the behavior from the available evidence.

The source-of-truth code links below target the [repository](https://github.com/kaelah971/meros-photon) and the October 24 production release. Timings and deployment identifiers come from the release/test reports. Values like provider acceptance, UI state, and a user-reported screenshot do **not** substitute for other forms of evidence.

## 1. Why we built this

The original Meros explored a different but related problem: support conversations forget useful context. It combined private per-customer semantic memory and carefully reviewed shared Fix Cards so one person's confirmed resolution could help the next customer without leaking personal history. The earlier **Walrus Session 8** entry used Walrus/MemWal, Neon, Better Auth and AI-assisted support, with a reported Alice → staff → Bob shared-memory demonstration and 38 Mainnet blobs. **That was the original Meros, not proof of the later Photon release.** [Original deployment](https://usemeros.vercel.app).

The Photon continuation asked a sharper operational question:

> What if an AI agent could notice a problem before the operator opened a dashboard, send a meaningful alert over a real messaging channel, maintain context through natural follow-up questions, and safely prepare the next step?

Meros Photon kept the existing support/incident domain, then layered **Photon Spectrum Cloud iMessage** over durable customer reports, incident intelligence and human review. The result is not a generic SMS command bot. The intended interaction is event-initiated: **a business event starts the conversation**.

This separation matters. The product case study uses three **controlled synthetic customer reports** but exercises real deployed detection, storage, provider transport, physical handset receipt and a saved draft. It is a systems integration demonstration, **not** evidence that an actual carrier lost a parcel or that an incident was resolved autonomously.

## 2. Architecture and integration decisions

### What owns what

| Component | Responsibility | Boundary / lesson |
|---|---|---|
| `@photon-ai/chat-adapter-imessage` + `chat` | Maps Spectrum iMessage transport to the Chat SDK bot and handles the signed webhook delivery | A configured send path does not prove an inbound path or handset delivery |
| Next.js App Router | HTTP routes, UI and webhook request lifecycle | Uses the official `waitUntil: (task) => after(() => task)` pattern; serverless invocation state is ephemeral |
| Neon Postgres | Sessions' relational application state, phone bindings, inbound/outbound history, conversations, evidence, plans | Durable unique keys and records survive duplicate deliveries and cold starts |
| Better Auth + staff gates | Owner session and workspace membership | A phone number alone is not authorization; binding and current staff access must agree |
| DeepSeek Flash | Current production language/structured inference and plan assistance | May phrase verified facts and propose drafts; does not approve or execute business actions |
| Gemini | Existing provider modules / retained alternative configuration | When `AI_PROVIDER=deepseek`, there is **no automatic Gemini fallback** |
| Walrus / MemWal | Scoped private/shared semantic-memory architecture | Public relayer health is not authenticated write/recall proof |
| Vercel | Deployment/runtime | GitHub push did **not** automatically deploy; releases used clean local worktrees and one authenticated CLI production deployment |

**Key repository paths:** [`app/api/photon/imessage/route.ts`](../app/api/photon/imessage/route.ts), [`lib/photon/bot.ts`](../lib/photon/bot.ts), [`lib/photon/operator.ts`](../lib/photon/operator.ts), [`lib/photon/history.ts`](../lib/photon/history.ts), [`lib/radar.ts`](../lib/radar.ts), [`lib/photon/converse.ts`](../lib/photon/converse.ts), [`lib/photon/plan-copilot.ts`](../lib/photon/plan-copilot.ts), [`lib/evidence-brief.ts`](../lib/evidence-brief.ts), [`lib/recovery-plans.ts`](../lib/recovery-plans.ts).

### Why the official adapter mattered

The Photon adapter let us use **Cloud-mode iMessage from a serverless Next.js application** without hosting an Apple device or long-running Mac listener. A Cloud project supplies `IMESSAGE_PROJECT_ID`, `IMESSAGE_PROJECT_SECRET` and a **separate registered-webhook signing secret**. The actual route delegates signature verification to the official adapter. Photon documents signed HTTPS webhooks, at-least-once retries, and processing through `after()` / `waitUntil`: [adapter documentation](https://github.com/photon-hq/vercel-chat-adapter-imessage), [Chat SDK Photon integration](https://chat-sdk.dev/adapters/vendor-official/photon).

The crucial integration detail was **identity across boundaries**:

```text
Apple/iMessage sender
  -> Photon shared number + project delivery
  -> signed Spectrum webhook
  -> Chat SDK handler
  -> sender hash / active Photon binding
  -> Better Auth operator ID
  -> current staff membership in a workspace
  -> authorized incident/customer read model
  -> Neon reply slot + provider post
```

A phone being paired is not enough if staff membership has been revoked. Similarly, a successful outbound notification doesn't prove that Photon registered or forwarded a later inbound message. Keeping those checks separate made the incident easier to diagnose.

### Why a database-backed outbox / dedupe mattered

Spectrum retries and background serverless handlers make application-level exactly-once effects unsafe to assume. Meros uses:

- a uniqueness constraint on **inbound provider message ID**, so a redelivered webhook maps back to the original inbound record;
- a unique **`reply_to_id`** slot, so racing deliveries cannot both send operator replies;
- **`radar:<candidateId>:<operatorId>`** keys, so one Radar candidate/operator pair does not generate repeated proactive alerts;
- explicit `sent`/`failed` persistence without claiming that `sent` means a phone displayed the message.

**CODE VERIFIED:** [`lib/photon/history.ts`](../lib/photon/history.ts) and [`lib/radar.ts`](../lib/radar.ts). **LIVE VERIFIED:** the NovaCart controlled trigger produced one Radar outbound record with a provider message ID and zero reported duplicate sends. We did not intentionally replay the real provider message in production to prove every possible retry race.

### Detection and the human decision boundary

The Radar threshold is **at least three distinct customers and three distinct conversations in a sliding 60-minute period**, from persisted candidate membership. A candidate must still be pending and sufficiently specific. Sending also requires active pairing, staff authorization, explicit Radar opt-in, proactive notifications, and a quiet-hours check. The bot sends a **possible issue** alert, never a message claiming an incident is already confirmed. See [`lib/radar.ts`](../lib/radar.ts).

After staff accept a candidate, the evidence brief contains source-attributed findings and unknowns. Recovery-plan steps are validated against authorized evidence references. A natural plan request cannot silently approve anything: explicit request matching or a **prompt-bound confirmation** authorizes drafting only, then live workspace checks run again. Final approval and any remediation remain with the human.

## 3. Chronological build log

| Date / milestone | Observed work and outcome | Evidence class |
|---|---|---|
| **Oct 7–9** | Original Meros memory demonstration: private recall, staff-reviewed shared fixes, original Walrus/MemWal submission. | HISTORICAL; separate deployment |
| **Oct 16 — Photon S1** | Separate `meros-photon` repository established; official Chat SDK adapter, signed webhook route, pairing, Neon `photon_operator_bindings` and `photon_messages`, initial dedupe and tests. | CODE / historical test reports |
| **Oct 17 — onboarding/routing** | An initial Photon project/line path did not deliver expected inbound events. A replacement/routing-test project received a `TEST` message and allowed cutover/pairing; exact provider-side reason was not proven. | REPORTED; upstream cause UNVERIFIED |
| **Oct 22 — bidirectional proof** | Earlier real iMessage interaction yielded four recorded inbound replies and provider-accepted outbound replies. | LIVE database evidence reported |
| **Oct 24 P0–P3** | DeepSeek Flash selected as current primary, automatic Radar seam verified, grounded-plan judge contract fixed, and plan copilot integrated. Release `299e1cf`. | CODE / TEST, then deployed |
| **Oct 24 P5** | More natural context handling: Radar alert follow-ups and an explicit human YES confirmation flow. Release `3f9c666`. | CODE / TEST, then deployed |
| **Oct 24 NovaCart Radar test** | Three new synthetic customers, one pattern `7cc3dd78`, three reports in ~55 seconds, one unsolicited alert. Owner confirmed real iPhone receipt. | LIVE + HANDSET VERIFIED |
| **Oct 24 inbound delay** | Radar outbound at **07:17:30 UTC**, later inbound recorded **08:17:08 UTC**, reply accepted **08:17:12 UTC**. Once recorded, Meros completed its reply path in ~4 seconds. | LIVE metadata; upstream hop attribution UNVERIFIED |
| **Oct 24 incident review** | Staff accepted the tracking candidate as incident `8847f10d…`, current evidence brief built (v2, 3 source reports), and plan Draft v1 persisted. | LIVE dashboard/database |
| **Oct 24 P7** | Live misselection of older Visa CKT-422 incident fixed by current-message topic priority and unknown-topic clarification. Releases `08545ae`, `1cc31d4`. | Reproduction / regression / HANDSET retest |
| **Oct 24 P7.1** | “YES” was lost because history loaded only first 300 characters and the incident-bound ref was positioned later; fixed prompt ordering. Release `2f42eb1`. | Failing-before/passing-after test + HANDSET retest |
| **Oct 24 P7.2** | Plan summary and long review URL exceeded 500-character budget; fixed sentence/meaning preservation and exact-length budgeting. Releases `abd4155`, `5711a08`. | Regression tests + final HANDSET screenshot |
| **Oct 24 demo** | Product footage, iPhone proof and review video assembled; V2 accepted by project owner. | Human acceptance report; public distribution not independently verified |

**Time caveat:** “~60-minute upstream delay” describes the observed gap between the operator's earlier reply and the persisted receipt. The exact queue location (Apple-to-Photon versus Photon-to-webhook) was **not instrumented**. A confirmed cause should not be attributed to a particular vendor or SDK from that gap alone.

## 4. Failures, root causes, and what changed

### 4.1 Outbound worked, inbound appeared to fail

**Symptom.** The NovaCart operator received an unsolicited Radar iMessage and replied, but no webhook or inbound row initially appeared in the inspected production window. In an earlier October 17 setup, inbound delivery had also been hard to observe despite an apparently correct webhook registration.

**What we did.** We checked the persistent project webhook URL, staff binding, sender enrollment, shared-line assumptions, production request traces and Neon `photon_messages`; importantly, we did **not** modify credentials or rewrite the receive handler based on speculation. The currently deployed URL was correct:

```text
https://meros-photon.vercel.app/api/photon/imessage
```

**Outcome.** The October 24 reply ultimately landed in Neon at 08:17:08 UTC. Meros's outbound response was accepted at 08:17:12 UTC. One inbound and one corresponding outbound were recorded, with no duplicate. **We did not need a code fix.**

**What is / isn't concluded.** The registered endpoint, sender binding and SDK receive path worked once the event arrived. A delay occurred before the durable inbound record. We cannot isolate the Apple relay, Photon proxy, webhook queue, or unretained Vercel logging without provider-side event timestamps. The earlier project cutover's exact failure also remains unverified. Photon has [publicly discussed](https://photon.codes/blog/how-we-rebuilt-our-shared-imessage-routing-to-handle-10m-messages-a-day) shared-number routing and observability issues, but that history is **context**, not proof it caused this message delay.

**Developer lesson.** Separate *message authored on device*, *provider ingested*, *webhook forwarded*, *application persisted*, *response posted*, and *handset received*. Each is a different timestamp and failure domain.

### 4.2 Grounded recovery-plan judge rejected useful drafts

**Symptom.** The prior Visa checkout incident's recovery proposal failed a judge/validation stage, despite an available evidence brief.

**Root cause (reproduced).** The generator converted source-attributed observations to **plain strings**, dropping the authorized message IDs, while the unchanged safety validator required supported `evidenceRefs`. The model therefore had no safe IDs to cite; generated steps could fail validation.

**Fix.** Feed the judge structured observations `{ text, sourceIds }` and explicit authorized citation IDs. Preserve the validator instead of weakening it. Use diagnostic steps if no historical match exists, and report safe failure categories without echoing raw customer/provider content.

**Proof.** A synthetic DeepSeek response passed the unchanged validator with three source-cited, low-risk diagnostic steps. Subsequently, the NovaCart tracking incident produced a saved Draft v1. **Do not treat the synthetic validator test as proof of real remediation.** See [`lib/recovery-plans.ts`](../lib/recovery-plans.ts) and [`docs/release-p0-p3.md`](release-p0-p3.md).

**Developer lesson.** Preserve provenance IDs across model input **and** output contracts. A strict validator is useful only when the generation interface carries the evidence needed to satisfy it.

### 4.3 The agent asked for command-like confirmation

**Symptom.** “Can you put together a plan for me?” initially fell into a model-inferred intent path that demanded an unnatural exact draft command. That contradicted the product promise: conversation, not a CLI.

**Fix.** Introduced a deterministic, incident-bound confirmation. A model may infer a possible plan request and ask the owner whether to proceed; **only an explicit matched request or a validated YES to the most recent matching bot prompt** can create a draft. Each confirmation rechecks the record inside the paired workspace.

**Developer lesson.** The answer to unsafe model autonomy isn't necessarily rigid commands. Human language can stay flexible while authorization remains deterministic.

### 4.4 Wrong incident from a newer history reference

**Symptom (real phone).** “Can you put together a plan for the tracking issue?” caused Meros to propose a plan for an unrelated, previously discussed **Visa checkout CKT-422** incident.

**Root cause (reproduced).** Context selection scanned assistant messages newest-first for reference tokens. A newer bot mention of Visa outranked the current phrase *tracking issue*, because current-message topic words had no priority.

**Fix.** Score the current message's meaningful topic against authorized incident titles, then use validated recent history only when the message is genuinely deictic (“this issue,” “that one”). Ties ask for clarification; an explicitly named but **unmatched** topic must not silently fall back to older Visa history. Accepted-candidate references can resolve forward to their linked incident.

**Safety outcome.** Tests proved the wrong-incident YES must never draft another incident. The final real-device retest selected the tracking incident correctly.

**Developer lesson.** The dangerous failure isn't a weird answer; it is a context mistake crossing into a **mutating action**. Resolve the target as carefully as the permission.

### 4.5 “YES” failed because the bot forgot its own prompt

**Symptom (real phone).** Meros asked for a draft, owner replied “YES,” and Meros incorrectly claimed drafting needed the staff console.

**Root cause (before/after test).** The bot persisted the whole outbound body but loaded only **300 characters per turn** into conversation history. The more conversational confirmation put the incident-bound `#shortref` at roughly character 350, beyond the loaded excerpt. The matcher correctly refused an unbound YES; it fell through to general classification.

**Fix.** Make the complete confirmation compact and put the bound reference early, safely within the bounded history excerpt; keep ordinary history small and preserve the deterministic matcher. The fixed prompt was also short enough to keep its full review link.

**Proof.** Tests composed the **real formatted response**, applied the exact production 300-character slicing, then ran the YES matcher and end-to-end plan path. Initially failed, then passed. The next real phone test produced the correct Draft v1.

**Developer lesson.** Cross-layer message budgets are a hidden contract. A confirmation identifier stored in a 500-character reply is useless if the consumer can only load the first 300.

### 4.6 Fixed-height iMessage copy cut off a recommendation

**Symptom (real phone).** The plan reply ended “same order, carrier, and delivery address, or are…” immediately before a long URL; a subsequent attempt cut after “same order, carrier,” changing the meaning.

**Root cause (reproduced).** The composer assembled multiple steps and fixed framing text without correctly reserving the full absolute URL and *all* body prefixes before applying a 500-character cap. A comma-based fallback was not semantically safe for lists.

**Fix.** Compose within the available budget **before** final formatting, include every fixed byte and the URL, prefer complete sentences, and only use stronger clause boundaries when the remaining text is meaningful. If no faithful compact summary fits, return an honest acknowledgment and the complete review link. The final response displays a complete evidence-derived recommendation.

**Developer lesson.** Short-channel UX needs **semantic** truncation, not just character truncation. Completing a sentence matters more than maximizing characters.

### 4.7 AI provider change was not a messaging transport change

**Symptom / concern.** During the inbound delay, it was tempting to blame the recent switch from Gemini to DeepSeek.

**What we verified.** The provider was reachable in a local smoke suite for text, structured JSON, a synthetic image and an expected malformed-model error. Production health showed `ai.provider=deepseek`, `ai.model=deepseek-flash`, `configured=true`. Meanwhile no inbound webhook had yet been recorded. **Inference:** a model cannot be the cause of an event that never reached the model handler.

**Boundary.** Configured Gemini credentials do not mean Gemini automatically takes over when `AI_PROVIDER=deepseek` is explicit. Treat provider model IDs and current availability as runtime-verifiable, not assumptions.

### 4.8 Local demo and production hygiene

**Observed friction.** Building demos under deadline pressures tempted shortcuts: command-line credential flags, writing fixture account passwords into an easy-to-stage folder, unguarded multiple test sends, and using production customer data for a show. The final preparation separated dry-run/stage/status/trigger/cleanup, banned CLI password arguments, and recorded fixture resource IDs incrementally. The hardened local script and ignore rules were **intentionally left uncommitted** during the October 24 production app releases and were not deployed.

**Observed outcome.** The real NovaCart test used three new *synthetic* customer identities in the existing workspace, triggered exactly one Radar alert, and left test records labeled for later authorized cleanup. Recording automation was read-only; incident and plan were not approved or executed. A clean detached Git worktree protected unrelated local changes during each Vercel CLI production deployment.

**Developer lesson.** Test harnesses and recording workflows can be operational hazards too. Privilege, fixture ownership, idempotency, source provenance and cleanup must be designed explicitly.

## 5. What we verified on a physical phone

The strongest proof is not a screenshot of a model answer; it is the sequence of **persisted business events plus a visible external transport effect**.

| Step | Concrete evidence | Interpretation |
|---|---|---|
| 3 synthetic messages | Three authenticated customer conversations; three `/api/chat` writes succeeded | Real app workflow exercised, not three direct SQL inserts |
| New candidate | `7cc3dd78…` with 3 distinct customers and 3 conversations in ~55 seconds | Eligible pending pattern; **not** an automatically confirmed incident |
| Outbound Radar | One durable outbound `sent` attempt and provider message ID | Photon accepted the alert; does not itself prove handset delivery |
| iPhone alert | Owner screenshot of the unsolicited “MEROS / INCIDENT RADAR” message | **HANDSET VERIFIED** for this message |
| Inbound question | One inbound provider message record at 08:17:08 UTC | The reply reached application persistence, after an observed delay |
| Reply | Linked outbound at 08:17:12 UTC | Application replied in ~4s from persisted inbound receipt |
| Human acceptance | Tracking candidate accepted through staff UI as incident `8847f10d-a20c-493f-8af9-5f07afa2f319` | Human, not AI, crossed incident confirmation boundary |
| Evidence | Current brief v2 linked to 3 reports; fingerprint reported as `1b29322e…` | Source-backed plan basis; cannot assume root cause verified |
| Draft | Exactly one saved recovery plan, version 1, status `draft`, for the tracking incident | Durable draft exists, not just chat prose |
| Repeat request | Existing draft surfaced again with one complete recommendation and review URL | Idempotent reuse / clearer presentation; no approval or remediation |

**Data protection:** this public report uses short identifiers and no real phone number, webhook secret, customer password, private conversation body, or unredacted personal address. Raw device captures should be redacted before publishing. The customer's reported parcel issue was entirely synthetic.

## 6. Test strategy and confidence

We favored **bounded regression tests against observed failures** instead of repeatedly running a huge suite after every prompt change. The October 24 release reports recorded examples such as:

- P0–P3 targeted verification: `38/38` final combined release seams, plus separate earlier suites; these overlapping counts are **not additive**.
- P5 natural conversation and alert-context flows, including authorization and pending-candidate behavior.
- P7: wrong-incident reproduction, explicit topic vs. history, ambiguous/unknown topics and accepted-candidate continuity.
- P7.1: real prompt → `fitConverse` → persisted text → `slice(0, 300)` → deterministic YES path, failing before and passing after.
- P7.2: long recommendation, long URL, complete-sentence preservation, failure redaction and unchanged-plan parity; release reports cited **196 passing tests across 9 focused files**.

**Confidence boundary:** passing focused tests is not a substitute for observing device delivery, Vercel's deployment status, current provider model availability, or persistent plan rows. Production test checks and handset screenshots closed those gaps selectively.

## 7. Developer experience: what helped, what hurt

### What helped

1. **Official adapter + ordinary Next.js webhook route.** The signed Chat SDK endpoint made serverless integration familiar and avoided recreating provider signature logic.
2. **Separation of delivery from product intelligence.** We could prove provider transport independently of model invocation, evidence generation and human action.
3. **Durable IDs in Neon.** Provider ID, reply slot, pairing binding, candidate ID and brief fingerprint let us reconstruct failures after short-lived runtime logs vanished.
4. **Explicit security gates.** Phone pairing, staff membership, candidate review, confirmation, idempotency and proposal validation were independently testable.
5. **A physical-device acceptance test.** It revealed UX and context-selection failures that mocks alone had not exposed; the demo then became an actual product proof.

### Where developer experience could improve

These are **requests and observations**, not allegations of a proven Photon product defect.

| Opportunity | Why it matters | Concrete improvement |
|---|---|---|
| **Inbound routing visibility** | We saw accepted outbound with a long gap before durable inbound; application logs couldn't identify the upstream hop | One trace showing device/provider ingest, project/line owner resolution, webhook attempts, status/retries, and timestamps (redacted by default) |
| **Shared-number onboarding diagnostics** | The original project/line setup and later routing-test project behaved differently, without a confirmed root cause | Explicit enrollment, shared-line status, inbound routing readiness and a safe read-only self-test |
| **Send vs. delivered language** | Provider accepted is easy to misreport as phone delivered | Clearly named transport stages in the SDK/dashboard; no inferred handset receipt |
| **Webhook starter template** | A working signed serverless endpoint needs `after`, retry/dedupe and production origin correctness | Next.js template with exact official adapter version, provider-message idempotency and an end-to-end harness |
| **Failure taxonomy / troubleshooting** | “No webhook” can mean multiple independent infrastructure states | A supported diagnostic decision tree with example read-only API queries and retry semantics |
| **Stateful messaging examples** | A natural-language YES may need to bind to a business record and survive history truncation | End-to-end example for bounded conversation state, safe confirmation and explicit mutation gates |
| **Privacy-preserving diagnostics** | Debugging phone and workspace routing can expose PII | Stable hashed IDs plus correlation tokens by default, with safe support/export tooling |

Photon's own [shared iMessage routing engineering article](https://photon.codes/blog/how-we-rebuilt-our-shared-imessage-routing-to-handle-10m-messages-a-day) is valuable context for what inbound routing has to solve at scale. It does **not** establish the cause of our October 24 delay. Similarly, upstream Spectrum issues about webhook platform casing apply to **specific versions and SDK paths**; they should not be retroactively blamed for an adapter version/path that doesn't use the affected lookup.

## 8. Safety, privacy, and limitations

**The boundaries we intentionally maintained:**

- Radar opt-in is separate from proactive notification opt-in; both, along with pairing/staff and quiet hours, control sends.
- The AI does not convert a pending Radar candidate into a confirmed incident; staff accept it.
- The AI does not send customer replies, approve recovery plans, execute fixes, or declare a verified recovery from iMessage.
- A request about a named but unmatched incident must clarify, not silently reuse a different historical case.
- A model-inferred YES never authorizes a write without a fresh, validated incident-bound prompt.
- Evidence and recovery steps cite only allowed source IDs; speculation is never a verified root cause.
- Historical memories and customer data are treated as untrusted context; workspace and per-customer privacy boundaries remain distinct.

**Still unverified / not claimed:**

- **Where** the inbound delay occurred in upstream Apple/Photon delivery and whether it would recur across broad traffic.
- End-to-end **authenticated Walrus write and recall** in the current deployment. The public Mainnet relayer `/health` response is a weaker check; earlier failures were encountered when authenticated operations were attempted.
- Any real carrier delivery recovery, customer satisfaction improvement, autonomous remediation, or live production customer behavior. The NovaCart customer reports were synthetic.
- The public release licensing of the selected demo soundtrack and the status of any potentially visible login email in the recorded footage. Those require final publishing review, separately from application proof.
- A reproducible auto-deploy pipeline: the production Vercel Git connection did not trigger deployments in this build; the authenticated CLI was used instead.

## 9. What I'd build next as a developer advocate

This project suggests a useful Photon-focused education path, grounded in the pain experienced by one integration:

1. **A 15-minute Next.js + Photon iMessage quickstart:** project creation → secure webhook → first bidirectional message → paired human operator.
2. **A delivery-debugging guide:** how to distinguish Apple delivery, Spectrum webhook forwarding, serverless invocation, model execution and stored reply, without revealing phone numbers.
3. **An idempotent proactive-agent example:** event qualification, quiet hours, opt-in, per-recipient dedupe, recorded provider acceptance and explicit handset proof.
4. **A safe natural-language action pattern:** read-only conversation, incident-scoped YES confirmation, evidence-grounded draft, and staff approval as separate actions.
5. **An evidence-first demo checklist:** synthetic-vs-real labels, screenshots, persistent receipt IDs, and a truthful limitations section.

These are **proposed teaching artifacts**, not a statement that Photon lacks all of them today.

## 10. Conclusion

Meros Photon now demonstrates a concrete developer possibility: **an application event can initiate a useful, contextual conversation over iMessage**, instead of waiting for a human to discover an issue inside another dashboard.

The hardest engineering lessons came from the boundaries between systems. An inbound message wasn't processed until it truly arrived. An older chat mention could dangerously override the operator's current topic. A 300-character history excerpt could remove an authorization token from a 500-character message. A naive string truncator could change a recovery recommendation's meaning. Each was visible only because we tested the **real product on a real handset** and investigated the specific failure rather than replacing the whole stack.

The deployed proof ends at a **human-reviewable draft**, not execution. That boundary is intentional. Photon provided the channel, Meros supplied the business context and state transitions, and the human remained responsible for consequential decisions.

---

### Primary materials

- [Meros Photon repository](https://github.com/kaelah971/meros-photon) and production commit [`5711a08`](https://github.com/kaelah971/meros-photon/commit/5711a08)
- [Official Photon / Chat SDK iMessage adapter](https://github.com/photon-hq/vercel-chat-adapter-imessage)
- [Chat SDK vendor integration guide](https://chat-sdk.dev/adapters/vendor-official/photon)
- [Photon shared-routing engineering article](https://photon.codes/blog/how-we-rebuilt-our-shared-imessage-routing-to-handle-10m-messages-a-day) — architectural context only
- [`docs/radar-demo-scenario.md`](radar-demo-scenario.md) and [`docs/plan-copilot-demo.md`](plan-copilot-demo.md) — repository's controlled-test procedures (not all steps reflect the NovaCart demo's exact path)
- October 24, 2026 deployment, Pi regression and NovaCart real-device reports, plus operator screenshots; private raw receipts intentionally omitted from this public document
