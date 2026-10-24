# Plan Copilot Demo — authorized fixture only

Extends `docs/radar-demo-scenario.md`. Same fixture workspace, same paired
phone, same cleanup. No production sends, no approvals, no customer messages.

## The three-turn flow (paired phone, staff console open beside it)

1. Owner: **"What's happening with checkout?"**
   Expected: grounded summary — incident title/status, affected
   customers/conversations, known facts, unknowns. No invented causes.
2. Owner: **"What should we do?"**
   Expected: read-only next steps plus any existing draft recovery plan
   ("There's already a draft, still needs your review").
3. Owner: **"Draft a recovery plan for this."** (or "Can you put together a plan for me?")
   Expected: explicit phrase drafts at once; inferred phrasing gets a
   confirmation first (`Reply YES` bound to that incident), and a plain
   `Yes` completes it — no memorized command needed. Result: a warm summary
   ("Yeah, I've put together a draft"), the first grounded recommendation
   in one or two complete sentences, a reminder that human review is still
   needed, and one complete staff-console review link. Unchanged evidence
   returns the existing draft (no duplicate).

## Proof to capture

- Phone screenshots: the draft reply must end in complete sentences with
  the full review link visible — no cut-off recommendations, no dangling
  conjunctions, no dropped URLs.
- Staff-console screenshot of the draft plan matching the version, steps,
  and risk quoted in chat.
- `incident_recovery_plans` row: fingerprint equals the current brief
  fingerprint; rerun with unchanged evidence creates zero new rows.
- Negative proof (in-console, no sends): an approval-flavored message
  ("approve the recovery plan") is refused with a staff-console redirect;
  a vague model-inferred request gets the explicit-phrase confirmation,
  never a draft.

## Safety lines that must hold on the screenshots

- Every draft message says it needs human review and that nothing is approved or sent.
- No message claims approval, execution, customer sends, or verification.
- No customer names, message text, phone numbers, or keys visible.

## Cleanup

Same as the Radar scenario: revoke Radar opt-in, revoke the Photon
binding, delete the `[DEMO FIXTURE]` organization, verify no production
workspace was touched.
