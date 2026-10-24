# Meros Photon — P0–P3 Release Candidate (local, unpushed)

Base: `main @ be0ab2a` plus one local release commit. No push, no deploy.

## What shipped

**P0 — DeepSeek Flash primary.** `lib/deepseek.ts` (OpenAI-compatible chat
completions, 20s/attempt + 45s phase ceilings, abort-linked, no outer retry
stacking), provider router in `lib/gemini.ts` (existing import paths
preserved — all `*-gemini.ts` callers get DeepSeek with zero edits),
`lib/env.ts` (`AI_PROVIDER` explicit wins, else auto: DeepSeek key present →
deepseek), `lib/ai-provider.ts`, health `ai` field, `.env.example` keys.
Vision: supported images ride as `image_url` data-URL parts so the model
receives actual pixels; text docs decode to fenced text; audio/unsupported
stay honest labels. No `@google/genai` import, no Gemini call, no byte
logging in DeepSeek mode.
Live-verified: `/models` lists `deepseek-flash`; text, `json_object`, 1px
synthetic PNG (color correctly described), and bad-model 400 all behaved.

**P1 — Automatic Incident Radar.** No Radar/Photon rebuild: traced
chat route → `detectFromChat` → `shouldEvaluateRadar` →
`evaluateRadarForOutcome` → `realRadarDeps` → `maybeSendRadarAlert` →
`sendOperatorNotification` → durable `outbound_messages`, plus the
deferred-recovery sweep. Rules intact: 3 customers + 3 conversations in a
sliding 60-min window, pending candidate, active binding, staff, opt-in,
quiet hours, per-operator idempotency keys. Extended
`radar-imessage-flow.test.ts` 4 → 12 (ineligible-at-2, duplicates,
concurrent same-key single-send, opt-out/quiet-hours with zero slot use,
provider failure recorded + never retried, judge-throw defer + recovery,
accepted-candidate ineligible, workspace isolation).
Demo: `docs/radar-demo-scenario.md`.

**P2 — Evidence-grounded recovery plans.** Root cause: the judge got bare
observation strings while the validator strips invented IDs — every step
failed. Fixed contract: structured `{text, sourceIds}` observations and
corroborated patterns; prompt renders `[cite only: ids]` and allows
zero-match diagnostic plans. Validator untouched; failures now carry safe
categories (`judge returned unusable proposal (<category>)`), never raw
content. Live synthetic DeepSeek generation passed the real validator
(3 diagnostic steps, citations correct, low risk).
Tests: `recovery-plan-grounding.test.ts` 9/9, `s9` 24/24.

**P3 — iMessage plan copilot.** New `plan_request` intent with a
deterministic explicit-request gate: only a fast-path match authorizes
generation; model-inferred intent gets an exact-phrase confirmation.
Reuses `generatePlanIfNeeded` (idempotent per brief fingerprint);
`next_steps` surfaces existing validated drafts read-only. Replies are
built deterministically (phrase model bypassed on plan data), always
DRAFT / planning-only / needs-human-review, with staff-console links.
Never approves, executes, messages customers, or changes incident state.
Tests: `plan-copilot.test.ts` 10/10; existing converse suites unaffected.
Demo: `docs/plan-copilot-demo.md`.

## Human approval boundaries (enforced, not promised)

- Approvals, sends, execution, close/accept/dismiss happen in the staff
  console only; iMessage is read-only plus draft-request.
- Drafts are planning-only artifacts; every reply says so.
- An LLM never authorizes a database mutation (deterministic gate).
- Provider acceptance is reported as acceptance, never handset delivery.

## Known limitations / NOT live-verified

- Real iPhone handset delivery (requires the human demo procedures).
- Authenticated production browser proof (see acceptance doc checklist).
- Pinned model `deepseek-flash` verified on `/models` 2026-10-24; recheck
  if the account's model list changes.

## Production acceptance checklist (before claiming live)

1. Set production env (dashboard, names only): `AI_PROVIDER=deepseek`,
   `DEEPSEEK_MODEL=deepseek-flash`, `DEEPSEEK_API_KEY=<secret>` — currently
   ABSENT in production (only `GEMINI_*` present); without them production
   keeps serving Gemini.
2. Deploy the release commit via the existing Vercel project
   (`kaelah-s-projects/meros-photon`); confirm build green.
3. `GET /api/health`: `ai.provider === "deepseek"`, configured true.
4. Run the Radar 5-minute phone test (`radar-demo-scenario.md`) on a
   `[DEMO FIXTURE]` workspace; capture the handset screenshot.
5. Run the 3-turn copilot flow (`plan-copilot-demo.md`); match chat quotes
   against the staged plan row; verify zero new rows on unchanged rerun.
6. Revoke Radar opt-in + binding; delete the fixture org; verify no
   production workspace touched.
