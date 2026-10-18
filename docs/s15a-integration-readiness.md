# S15A — Integration Verification & Hardening Readiness Record

Date: 2026-10-18. Baseline: `73336d8` (S14), production `https://meros-photon.vercel.app`.
No S1–S14 code was changed in S15A. This document records what was verified,
what was fixed (local-only), and the exact entry points for S15B–S15E.

Status legend used throughout: IMPLEMENTED · VERIFIED · PARTIALLY VERIFIED ·
NOT IMPLEMENTED · BLOCKED.

---

## 1. Verified end-to-end capability matrix

| # | Capability chain | Status | Evidence |
|---|---|---|---|
| 1 | Customer message → persisted conversation/message | VERIFIED | `support-ops.createConversation/addUserMessage`; S5 + S6 live tests persist and link real rows |
| 2 | S5 detection → two matching conversations form one reviewable candidate | VERIFIED | `s5-detection.test.ts`: "two wordings of the same issue form one surfaced candidate" + live Neon persistence test |
| 3 | Generic/unrelated complaints stay separate | VERIFIED | S5: "two unrelated issues … stay separate"; generic-words guard |
| 4 | Duplicate delivery does not duplicate membership | VERIFIED | S5: "retry of the same message dedupes", "concurrent processing does not duplicate"; `addMessageToCandidate` message-id `on conflict do nothing` + winner lookup |
| 5 | Workspace isolation in detection/clustering | VERIFIED | S5: "cross-workspace isolation: same text, separate candidates"; all candidate SQL workspace-scoped |
| 6 | Candidate acceptance preserves sources into S4 | VERIFIED | `issue-candidates/[id]/review`: `accept_new`/`accept_existing` links every member conversation via idempotent `addIncidentConversation`, then `markCandidateAccepted`; S5 live test "persists a candidate, dedupes members, accepts into S4" |
| 7 | Incident → current Evidence Brief (grounded sources) | VERIFIED | S6 suite (currently passing); brief fingerprint/version gating; `briefSourceLinks` inner-joins live messages |
| 8 | Brief → S7 snapshot text matches persisted brief | VERIFIED | `buildSnapshot` is a pure function of the persisted brief row (version + fingerprint carried through); send route requires `expectedFingerprint` match and returns the fresh snapshot instead of sending stale text on mismatch |
| 9 | Stale briefs cannot be sent as current | VERIFIED | Snapshot states `empty/pending/failed/stale`; non-current briefs yield explicit non-sendable text; send route fingerprint gate |
| 10 | Historical matches cite authorized cards | VERIFIED | S8: `loadCards`/`resolveCardsByBlobs` workspace-scoped, usable statuses only; superseded blobs deny-listed; match payload carries `cardStatus/cardResolved/cardExcerpt`; tier computed in code, never from model claims |
| 11 | Invalid AI output never creates fake facts | VERIFIED | `validateBriefFindings`, `validateMatchJudgment` (rejects invented refs, requires verbatim symptom overlap), `validateRecoveryPlan`, `validateWatchJudge`, `validateSynthesis`, `validateContradictionJudge` — all covered by unit tests |
| 12 | S9 staged plan → S10 scoped approval → manual intervention → independent verification | VERIFIED | S10 suite: scope hashing, self-approval block, idempotent claim, independent verifier; live Neon round-trip |
| 13 | Verified action → S11 Resolution Watch → confirmed resolution | VERIFIED | S11 suite incl. live Neon: improvement/persistence/regression classification, silence-never-confirms, independent confirmation |
| 14 | Confirmed resolution → S12 closure + postmortem | VERIFIED | S12 suite incl. live end-to-end: eligibility gates, draft→finalize→resolve with dedupe, reopen preserves history; generic `transition` to `resolved` requires verified postmortem or explicit administrative reason (S4 test updated) |
| 15 | Finalized postmortem → S13 reviewed memory → later S8 recall with provenance | VERIFIED | S13 suite incl. live loop: propose → share → new incident `refreshMatchesIfNeeded` builds a match row citing the memory card; fix-matches UI renders `Operator memory · verified outcome · postmortem <id>` |
| 16 | S8/S12/S13 history → S14 Knowledge Health findings | VERIFIED | S14 suite incl. live Neon: gap/contradiction/stale detection, dedupe, auto-address, dismissal-holds, provenance repair; fix-cards page UI verified by screenshot this phase |
| 17 | Photon signed inbound webhook → deduped persistence | VERIFIED | `app/api/photon/imessage/route.ts` delegates to the Chat SDK adapter (Spectrum signature verification); `recordInbound` unique on `(direction, provider_message_id)`; reply slot `claimReplySlot` unique on `reply_to_id`; proactive slot unique on idempotency key. Photon S1/S2 test files pass |
| 18 | Operator pairing + stats intents | VERIFIED | `handleOperatorMessage`: pairing-code claim, binding-gated stats, unknown-sender pairing-only replies, degraded path when Neon is down; S1 tests |
| 19 | Proactive notification idempotency + quiet hours + preferences | VERIFIED | `sendOperatorNotification` gates: active binding → staff check → prefs/quiet-hours (tests bypass) → idempotency slot claim → `postToThread` → sent/failed marking. S2 tests; test-notify route is staff-clicked, binding-scoped, never customer data |
| 20 | No automatic sends/executions/closures anywhere | VERIFIED | Source-scan tests in S10–S14 suites assert no dispatch/execution/closure surface in domain libs; S14 refresh is staff-triggered only (no background hook) |

Full suite on S15A baseline: **422/423 pass** (36 files). The single failure is environmental (see §4, item 1); one additional timeout was a parallel-load flake that passes solo.

---

## 2. Automated vs live acceptance distinction

- **Automated (vitest, live Neon where marked):** every row above except the visual ones. Live tests use synthetic workspaces/users with `[fixture]`-style stamps and cascade-delete their orgs in `afterAll`.
- **Live acceptance (human):** production health `GET /api/health` → 200 with all subsystems configured/reachable (verified this phase); production alias serves `/` 200 (verified this phase).
- **Deliberately NOT done live:** no real iMessages sent, no customer sessions created, no production incidents fabricated, no Walrus writes outside tests, no recovery executions. The `photon/notify/test` route sends only to the calling operator's own binding on explicit click.

---

## 3. Actual integration defects discovered

### 3a. Local-only test-env defect (FIXED locally, uncommitted by design)

- **Finding:** `auth.test.ts` "baseURL and trustedOrigins follow BETTER_AUTH_URL" failed because gitignored `.env.local` contained a bare `BETTER_AUTH_URL` line with no value, so `setup-env.ts` never exported the key.
- **Fix applied:** set `BETTER_AUTH_URL=http://localhost:3002` in local `.env.local` only (matches the documented local default; file is gitignored, no commit). Suite then passes 16/16.
- **No code change needed.** Production is unaffected (Vercel env provides the real URL).

### 3b. No product-code defects found

- The S7 send fingerprint gate, S12 closure gate on the generic transition route, S8 workspace-scoped recall, and Photon dedupe slots all behave as specified on inspection.
- The `?? .vercel/` working-tree entry is CLI cache (ignored).

---

## 4. Remaining unverified behavior (honest limits)

1. **End-to-end iMessage delivery** (real Spectrum round-trip) is NOT verified — no test or fixture sends a real message. Unit coverage stops at the adapter boundary (`thread.post`/`postMessage` mocked or uncalled in tests). Signing/verification is delegated to `@photon-ai/chat-adapter-imessage@3.2.0`.
2. **`product-identity.test.ts` 5s timeout under parallel load** (passes solo in ~28s). Flake, not a product defect; worth a targeted timeout bump if it recurs.
3. **Full-suite default worker run crashed once** with a tinypool `ERR_IPC_CHANNEL_CLOSED`. Rerun with `--maxWorkers=2 --pool=forks` completed cleanly (36 files). Treat as resource exhaustion on this machine, not a code defect — but do not run the unbounded default again here.
4. **Customer-facing chat (`/support`) and candidate-review page** were not screenshot-verified this phase (fixtures require detection pipeline runs). Prior S13 shots cover console + incident detail; S15A shots cover fix-cards incl. Knowledge Health (desktop 1440, tablet 768, mobile 390) + incident detail. Candidate-review empty/populated states rely on S5 tests + code inspection.
5. **Keyboard-focus visibility** was not exhaustively audited; interactive elements use standard buttons/inputs with visible styles, but no dedicated focus-ring pass was done.

---

## 5. Photon adapter capability findings

Inspected: `lib/photon/{operator,bot,history,notify,preferences,bindings,config}.ts`, `app/api/photon/imessage/route.ts`, SDK `@photon-ai/chat-adapter-imessage@3.2.0` type surface.

| Capability | SDK supports | Meros implements | Notes |
|---|---|---|---|
| Signed inbound webhook verify | Yes (adapter) | Yes — route delegates; rejects unsigned/stale | VERIFIED by code + S1 tests |
| Text inbound → persisted message | Yes | Yes — `recordInbound`, body truncated 500 chars | VERIFIED |
| Inbound dedupe (redelivery) | At-least-once retries | Yes — unique `(direction, provider_message_id)`; NULL ids never conflict (each delivery new) | VERIFIED |
| Single reply slot (no double replies) | — | Yes — `claimReplySlot` unique on `reply_to_id`; losers must not send | VERIFIED |
| Reaction events (`onReaction`, `addReaction`) | Yes | **NOT implemented** — no subscription, no handling | Gap for S15C if reactions matter |
| Attachments/inbound files (`FilePart`) | Yes | **NOT implemented** — only `message.text` is read/persisted | Gap for S15D/S15E (images, voice notes) |
| Outbound text (`thread.post`, `postMessage`) | Yes | Yes — `boundPost` per thread; `postToThread` cold-start via chat GUID | VERIFIED |
| Expressive effects / voice notes / mini-app cards / typing | Yes | **NOT implemented** | S15D options, not requirements |
| `openDM` cold-start DM | Yes | **NOT implemented** — all sends go to known threadIds | Blocker only if S15E needs operator-initiated new threads |
| `fetchMessages` / `fetchThread` backfill | Yes | **NOT implemented** | Relevant to S15C history questions |
| Pairing codes + active binding resolution | — | Yes — TTL codes, `resolveActiveBinding(ForOperator)`, revocation stops proactive sends | VERIFIED |
| Preference + quiet-hours gates | — | Yes — per-operator prefs, malformed fails closed; tests bypass suppression only | VERIFIED |
| Binding/workspace authorization on every send | — | Yes — binding→workspace match + `requireStaff` defense in depth | VERIFIED |

---

## 6. Exact S15B build plan (Incident Radar)

**Goal:** notify operators when an S5 candidate surfaces; default-disabled, explicit opt-in.

- **Trigger seam (new, ~30 lines):** in `app/api/chat/route.ts` `after()` background chain, after `detectFromChat` returns a newly-surfaced candidate (`surfaced: true` transition — detect whether the candidate id is newly created vs already pending via the `DetectResult`; fail-isolated `try/catch`, zero chat-latency impact, mirrors the S6/S8/S9/S11 hook pattern).
- **Reuse as-is:** `sendOperatorNotification` with the existing `"incident_detected"` type (enum already anticipates this; **no sender exists yet**), `claimProactiveSlot` idempotency (key: `radar:{candidateId}`), quiet-hours + `proactiveEnabled` gates, binding/staff gates, `markOutboundSent/Failed`.
- **Required state/schema:** one additive piece — a workspace-level opt-in flag. Smallest seam: reuse the `evidence_auto_notify` stored-intent pattern (`operator_preferences.evidence_auto_notify`, default OFF) or add `radar_enabled` alongside it. Plus durable alert rows? `photon_messages` outbound rows already record each send; a per-candidate "already alerted" marker can reuse the candidate row (`issue_candidates`: add `alerted_at` nullable) to dedupe without a new table. Decision: one nullable column, no new table.
- **Security boundaries:** staff-only opt-in toggle route; messages contain only candidate title/counts + console link (no customer text — reuse redaction posture); never to unpaired senders; retries reuse the same idempotency key.
- **Focused acceptance tests:** default-off (no send without opt-in), opt-in send once, duplicate trigger dedupes, quiet-hours suppression, revoked binding stops sends, unauthorized toggle rejected, cross-workspace isolation.
- **Genuine external blockers:** none — all primitives exist. Only product decision: threshold definition (currently `SURFACE_MIN_CONVERSATIONS = 2`).

## 7. S15C/D/E reuse opportunities

### S15C — iMessage Muse Router (read-only intents first)
- **Reuse:** `handleOperatorMessage` intent-parser pattern (`parseStatsIntent`/`parsePairIntent` → add `parseIncidentIntent` etc.); `realDeps`-style Neon deps in `bot.ts`; read models `listIncidents` (active incidents), `getIncidentBrief` (current evidence), `realMatchStore().loadForBrief/loadLatest` (match explanations with tiers/reasons), `realApprovalDeps` + `realWatchDeps` (outstanding decisions/verifications).
- **Smallest seam:** new intent branches in `handleOperatorMessage` returning text replies via existing `replyOnce` (keeps dedupe + degraded behavior). No new tables.
- **Security:** binding→workspace→staff gates already wrap every branch; consequential actions need a separate validated approval design (do NOT extend reply slots into actions).
- **Blockers:** none for read-only. History questions would want `fetchMessages` (SDK-ready, unimplemented).

### S15D — Evidence Experience
- **Reuse:** `BriefRow`/`getIncidentBrief` + `buildSnapshot` (deterministic, fingerprint-carrying text already used for iMessage sends); `evidence-brief.tsx` component; staff+workspace gates; send-route fingerprint-match rule (iMessage text must equal the previewed snapshot — the consistency rule already exists server-side).
- **New surface:** one authenticated evidence page per incident (staff-only route) rendering the same snapshot model the iMessage path sends.
- **Missing (BLOCKED until decided):** PNG generation/media delivery — **no image library in the repo** (`sharp`/`canvas` absent; S7 is text-only by design). Needs a dependency + delivery-path decision; do NOT build in S15A.
- **Privacy:** no public URLs (staff session only); no PII beyond what the brief already cites.

### S15E — Recover Many
- **Reuse:** `listIncidentConversations/Customers` (eligible population), `createPendingFixCard`-style per-recipient draft rows (new lightweight table mirroring `incident_snapshot_deliveries` claim/send/fail idempotency per recipient — the exact S7 delivery pattern), S10 scope-hash pattern for exact-payload authorization, `postToThread` + `markOutboundSent/Failed` for sends, per-recipient outcome tracking rows.
- **New surface:** per-customer eligibility (linked + affected only), explicit exclusions with reasons, draft review, authorized send — all staff-gated. Never assume one incident ⇒ all customers eligible.
- **Blockers:** policy (who may authorize bulk customer sends), not technical.

---

## 8. Security and privacy constraints (carry into S15B–E)

- Every new route: `requireUser` + workspace resolution + `requireStaff`/membership check (follow incident routes, not legacy access-code paths).
- No customer text in proactive messages (titles/counts/links only); attachments never leave the request turn.
- No cross-workspace recall (`resolveCardsByBlobs`/Neon scoping already enforce; keep it).
- AI outputs in new features must reuse the strict validators; no new judges without `validate*` + known-ID checks.
- Idempotency keys on every send path; retries never duplicate customer-visible effects.

---

## 9. Release / demo risks

1. **Real iMessage delivery is the only unverified critical path.** Everything up to `postToThread` is tested; the last mile depends on Spectrum + the paired device. Mitigation: use the staff-clicked connectivity test on the demo device before any live demo.
2. **Parallel test flakiness on this machine** (tinypool crash, 5s timeout). CI with more headroom or `--maxWorkers=2` mitigates.
3. **Demo data discipline:** all fixtures so far are synthetic and deleted; no production Northstar customer data was touched in S15A. Keep it that way — S15B radar must never be demoed against real customer threads without consent.

---

## 10. Final report (S15A)

1. **Starting state:** clean tree at `73336d8` (= `origin/main`), prod healthy. Confirmed unchanged at end except the doc + capture script added below.
2. **Verification matrix:** §1 rows 1–20 (422/423 automated green; 1 env-only failure, fixed locally).
3. **Working integrations:** candidate→incident→brief→snapshot→match→plan→approval→execution→watch→closure→memory→recall→health, plus Photon webhook/dedupe/notify/prefs (see matrix).
4. **Genuine defects found:** one local-env defect (empty `BETTER_AUTH_URL` in gitignored `.env.local`), fixed locally, no commit. Zero product-code defects.
5. **Changes made:** `docs/s15a-integration-readiness.md` (this file) + `scripts/capture-s15a-shots.mjs` (fixture-seeded visual QA harness). No S1–S14 source touched.
6. **Tests/typecheck/build:** full suite 422/423 (env-only failure, since fixed locally); `tsc --noEmit` clean (re-run at ship); production build state unchanged (no source changes — no rebuild required beyond the last S14 build).
7. **Photon readiness:** §5 table. Text in/out, pairing, dedupe, prefs, quiet hours, idempotent proactive sends: ready. Reactions, attachments, openDM, fetch-backfill, rich sends: SDK-ready, unimplemented.
8. **S15B plan:** §6 — trigger hook in chat `after()` chain + existing `incident_detected` notify path + one opt-in column/flag + `alerted_at` marker; no new tables.
9. **S15C/D/E reuse:** §7 — operator-intent branches + read models; snapshot model + gated evidence page (PNG BLOCKED); per-recipient delivery rows mirroring snapshot deliveries.
10. **Blockers:** S15D PNG/media path (dependency + delivery decision); S15E bulk-send authorization policy. Nothing technical blocks S15B/C-read-only.
11. **Demo readiness:** demo-able today on staff console flows + connectivity test; hold real customer threads and bulk sends until S15B/E gates exist. **Do NOT begin S15B.**
