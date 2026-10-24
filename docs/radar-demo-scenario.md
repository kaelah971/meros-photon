# Radar Demo Scenario — AUTHORIZED FIXTURE ONLY ([DEMO FIXTURE] <date>)

> Labels: synthetic fixture, isolated demo workspace. Never a production
> customer, never a production incident. No real iMessage is sent by any
> automated step — the single handset screenshot requires a human with the
> paired phone in hand.

## Required operator configuration (human does this once)

1. Create organization/workspace named `[DEMO FIXTURE] YYYY-MM-DD`; record IDs + cleanup owner.
2. Pair exactly one explicitly authorized operator device (`/api/photon/imessage` binding); confirm staff membership.
3. Radar OFF. Operator prefs: proactive ON, quiet hours OFF for the demo window.
4. Three controlled test-customer accounts with known cleanup owners. No real identities.

## Staged execution (scripted, human-gated)

`.fast-build/demo-fixture-setup.mjs` automates fixture work through authorized
product workflows only (signup → org → workspace → chat). It NEVER sends by
default (dry-run prints the plan). Stages:

- `--execute --stage=stage` — creates the labeled org, workspace, and 3
  customer identities. Sends NOTHING, changes NO preferences.
- **Human gate (manual):** pair the phone, enable Radar opt-in, quiet hours
  OFF. Verify with `--execute --stage=status` (checks pairing, thread,
  proactive readiness, quiet-hours policy; refuses to bless an open gate).
- `--execute --stage=trigger --confirm-trigger=YES` — re-verifies the gate,
  then sends the 3 controlled reports through real chat. One-shot marker
  refuses repeat runs without `--allow-retrigger=YES`.
- `--execute --stage=cleanup` prints the manual revoke/delete checklist.

The exact 5-minute phone sequence below assumes the gate has passed and the
trigger has fired exactly once.

| Time | Action | Expected transition |
|---|---|---|
| 0:00 | Phone sends `help`, `stats`, `show me` | Read-only replies; no approve/execute/close offered |
| 1:00 | Customers A+B send matching naturally-worded checkout-failure reports in `/support/<demo-slug>` | S5 candidate `created` → `joined`; Radar evaluated, `ineligible` (2 < 3) |
| 2:00 | Customer C sends a matching report | `joined` (3rd distinct conversation) → `eligible` → ONE `MEROS / INCIDENT RADAR` alert to the paired thread |
| 2:30 | Staff accepts candidate, opens incident evidence page | Evidence brief + PNG download, source-linked messages |
| 3:30 | Recover Many: edit one draft | Approval invalidated until human re-approves |
| 4:00 | With explicit human OK, publish ONE draft to ONE test customer | Customer sees Meros-team message; other drafts untouched |
| 4:30 | Record one watch observation; revoke Radar + binding; delete fixture org | Cleanup verified; no prod workspace touched |

## Expected Photon alert (persisted proof)

- `outbound_messages` row: `status='sent'`, `provider_message_id` set, `idempotency_key='radar:<candidateId>:<operatorId>'`.
- Rerun/retry with the same key → `deduped`/`already_attempted`, never a second post.
- Report wording: "accepted by provider — handset delivery not confirmed."

## How to verify actual iPhone receipt (human only)

1. On the paired phone, screenshot the single Radar message in the bound thread.
2. Confirm counts/title match the candidate page; confirm no customer names or message text in the alert.
3. Attach the screenshot to the release log. Screenshots are the ONLY handset proof — provider acceptance is not delivery.

## Safe cleanup

Revoke Radar opt-in → revoke Photon binding → delete `[DEMO FIXTURE]` organization → verify no other workspace's bindings/outbounds changed. Record all four in the release log.
