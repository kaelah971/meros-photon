# Plan Copilot Demo — authorized fixture only

Extends `docs/radar-demo-scenario.md`. Same fixture workspace, same paired
phone, same cleanup. No production sends, no approvals, no customer messages.

## The three-turn flow (paired phone, staff console open beside it)

1. Owner: **"What's happening with checkout?"**
   Expected: grounded summary — incident title/status, affected
   customers/conversations, known facts, unknowns. No invented causes.
2. Owner: **"What should we do?"**
   Expected: read-only next steps plus the existing validated draft if one
   exists ("Validated draft plan vN (DRAFT, needs human review)").
3. Owner: **"Draft a recovery plan for this."** (or "Can you put together a plan for me?")
   Expected: explicit phrase drafts at once; inferred phrasing gets a
   confirmation first (`Reply YES` bound to that incident), and a plain
   `Yes` completes it — no memorized command needed. Result: `DRAFT —
   planning only, needs human review, not approved`, top diagnostic steps,
   overall risk, open unknowns, and a staff-console review link.
   Unchanged evidence returns the existing draft (no duplicate).

## Proof to capture

- Phone screenshots of all three turns.
- Staff-console screenshot of the draft plan matching the version, steps,
  and risk quoted in chat.
- `incident_recovery_plans` row: fingerprint equals the current brief
  fingerprint; rerun with unchanged evidence creates zero new rows.
- Negative proof (in-console, no sends): an approval-flavored message
  ("approve the recovery plan") is refused with a staff-console redirect;
  a vague model-inferred request gets the explicit-phrase confirmation,
  never a draft.

## Safety lines that must hold on the screenshots

- Every draft message says DRAFT / planning-only / needs human review.
- No message claims approval, execution, customer sends, or verification.
- No customer names, message text, phone numbers, or keys visible.

## Cleanup

Same as the Radar scenario: revoke Radar opt-in, revoke the Photon
binding, delete the `[DEMO FIXTURE]` organization, verify no production
workspace was touched.
