-- Meros P0 minimal Neon schema.
-- Operational metadata ONLY. Walrus is the durable memory store.
-- If this database is wiped, sessions/evidence metadata is lost but
-- Walrus memories remain.

create table if not exists users (
  id text primary key,               -- sha256 hex internal user id
  access_code_hash text not null,    -- db-scoped hash, never the raw code
  namespace text not null,           -- meros:user:<hash>
  created_at timestamptz not null default now()
);

create table if not exists memory_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references users(id) on delete cascade,
  namespace text not null,
  type text not null default 'PROFILE',
  text text not null,
  status text not null default 'pending'
    check (status in ('pending','saving','stored','failed')),
  blob_id text,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists memory_jobs_user_idx on memory_jobs (user_id, created_at desc);

-- Meros P5 multi-tenant foundation.
-- Relational records ONLY (identity registry + future auth/conversations).
-- Walrus remains the source of truth for long-term AI memory.
-- All IDs are immutable content-derived hex (see lib/tenant.ts); slugs and
-- names are presentation/routing and NEVER namespace keys.

create table if not exists organizations (
  id text primary key,               -- sha256-derived, immutable
  slug text not null unique,         -- public routing key (e.g. 'acme')
  name text not null,
  description text,                  -- short company description (P9 onboarding)
  created_at timestamptz not null default now()
);

create table if not exists workspaces (
  id text primary key,               -- sha256-derived from slug, immutable
  organization_id text not null references organizations(id) on delete cascade,
  slug text not null unique,         -- public routing key (e.g. 'acme')
  name text not null,
  product_name text,
  product_description text,
  support_context text,
  created_at timestamptz not null default now()
);

create table if not exists customers (
  id text primary key,               -- sha256-derived from (workspace_id, bootstrap hash), immutable
  workspace_id text not null references workspaces(id) on delete cascade,
  display_name text,                 -- nullable; bootstrap carries no name yet
  bootstrap_identity_hash text not null,  -- salted hash, NEVER the raw access code
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, bootstrap_identity_hash)
);

create index if not exists customers_workspace_idx on customers (workspace_id);

-- Meros P7 real customer identity. A workspace customer maps to a Better
-- Auth user; the (workspace_id, auth_user_id) pair is the product identity.
-- bootstrap_identity_hash is now NULLABLE legacy (P5 access-code rows keep
-- their values; auth-backed rows use auth_user_id instead).
alter table customers add column if not exists auth_user_id text references "user"(id) on delete cascade;
alter table customers alter column bootstrap_identity_hash drop not null;
create unique index if not exists customers_workspace_auth_unique on customers (workspace_id, auth_user_id);

-- Meros P6 owner accounts. NOTE: the pre-existing `users` table above holds
-- P0 customer bootstrap identities and is left untouched; platform owners
-- live in `platform_users` so no FK migration is ever needed.

create table if not exists platform_users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  display_name text,
  password_hash text not null,      -- scrypt MCF-style, never plaintext
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists platform_users_email_unique
  on platform_users (lower(email));

-- LEGACY (P6): platform_users + owner_sessions below are RETAINED but UNUSED.
-- Runtime owner auth is Better Auth (user/session/account tables, appended
-- at the end of this file). organization_members now references "user"(id).
create table if not exists organization_members (
  organization_id text not null references organizations(id) on delete cascade,
  user_id text not null references "user"(id) on delete cascade,
  role text not null default 'owner' check (role in ('owner', 'admin', 'support')),
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create table if not exists owner_sessions (
  token_hash text primary key,      -- sha256 of the opaque cookie token
  user_id uuid not null references platform_users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists owner_sessions_user_idx on owner_sessions (user_id);
create table "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" boolean not null, "image" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null);

create table "session" ("id" text not null primary key, "expiresAt" timestamptz not null, "token" text not null unique, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade);

create table "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz, "scope" text, "password" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null);

create table "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" timestamptz not null, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null);

create index "session_userId_idx" on "session" ("userId");

create index "account_userId_idx" on "account" ("userId");

create index "verification_identifier_idx" on "verification" ("identifier");

-- Meros P8 persistent support operations. Neon is product state ONLY:
-- conversations, messages, issues, and Fix Card metadata live here.
-- Walrus remains the long-term AI memory store; provenance blobs stored
-- below are references, never memory content mirrors.

create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null references workspaces(id) on delete cascade,
  customer_id text not null references customers(id) on delete cascade,
  status text not null default 'open' check (status in ('open', 'resolved')),
  title text not null default 'Support conversation',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_message_at timestamptz,
  resolved_at timestamptz
);

create index if not exists conversations_customer_idx
  on conversations (workspace_id, customer_id, last_message_at desc nulls last, created_at desc);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  client_id text,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  model text,
  memory_private_used boolean not null default false,
  memory_shared_used boolean not null default false,
  memory_knowledge_used boolean not null default false,
  memory_provenance jsonb,
  created_at timestamptz not null default now(),
  -- plain UNIQUE: NULL client_ids never conflict with each other,
  -- while real client ids dedupe retried sends per conversation.
  unique (conversation_id, client_id)
);

create index if not exists messages_conversation_idx
  on messages (conversation_id, created_at, id);

create table if not exists support_issues (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null references workspaces(id) on delete cascade,
  customer_id text not null references customers(id) on delete cascade,
  conversation_id uuid not null unique references conversations(id) on delete cascade,
  status text not null default 'open' check (status in ('open', 'resolved')),
  title text not null default 'Support issue',
  resolution_summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists support_issues_workspace_idx
  on support_issues (workspace_id, status, updated_at desc);

create table if not exists fix_cards (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null references workspaces(id) on delete cascade,
  customer_id text not null references customers(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete cascade,
  issue_id uuid references support_issues(id) on delete set null,
  candidate_text text not null,
  status text not null default 'pending_review'
    check (status in ('pending_review', 'shared', 'kept_private', 'failed')),
  walrus_blob_id text,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by_user_id text references "user"(id) on delete set null
);

create index if not exists fix_cards_workspace_idx
  on fix_cards (workspace_id, status, created_at desc);

-- Staff edit-before-share: the exact reviewed Symptom/Cause/Resolution text
-- written to shared memory (null when the generated candidate was shared
-- unedited). Idempotent: safe to re-run.
alter table if exists fix_cards add column if not exists reviewed_text text;

-- Shared-fix correction/supersession: a corrected version is a NEW row with
-- its own Walrus blob; the old row is marked superseded (never deleted —
-- Walrus blobs are immutable and the old blob stays for audit). Idempotent.
alter table if exists fix_cards drop constraint if exists fix_cards_status_check;
alter table if exists fix_cards add constraint fix_cards_status_check
  check (status in ('pending_review', 'shared', 'kept_private', 'failed', 'superseded'));
alter table if exists fix_cards add column if not exists superseded_by_fix_card_id uuid references fix_cards(id) on delete set null;

-- P9 onboarding: optional company description on organizations.
-- Idempotent: safe to re-run against databases created before P9.
alter table if exists organizations add column if not exists description text;

-- P9 chat: per-answer knowledge-plane flag for history fidelity.
-- Idempotent: safe to re-run.
alter table if exists messages add column if not exists memory_knowledge_used boolean not null default false;

-- Multimodal composer: per-message attachment METADATA only (filename,
-- media type, kind). Raw bytes are request-scoped and never persisted.
-- Idempotent: safe to re-run.
alter table if exists messages add column if not exists attachments jsonb not null default '[]';

-- P9 workspace product knowledge. Neon is canonical source + metadata
-- (titles, URLs, statuses, blob refs). Walrus holds ONLY the semantic
-- retrieval index per workspace knowledge namespace. Raw website text is
-- never the sole source of truth — canonical_content lives here.
create table if not exists workspace_knowledge (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null references workspaces(id) on delete cascade,
  type text not null check (type in ('manual', 'website', 'documentation', 'faq', 'policy')),
  title text not null,
  source_url text,
  canonical_content text not null,
  status text not null default 'pending'
    check (status in ('pending', 'ready', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists workspace_knowledge_ws_idx
  on workspace_knowledge (workspace_id, created_at desc);

create table if not exists workspace_knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  knowledge_id uuid not null references workspace_knowledge(id) on delete cascade,
  workspace_id text not null references workspaces(id) on delete cascade,
  content text not null,
  position integer not null,
  walrus_blob_id text,
  created_at timestamptz not null default now()
);

create index if not exists workspace_knowledge_chunks_kb_idx
  on workspace_knowledge_chunks (knowledge_id, position);

-- Meros Photon S1 operator iMessage bindings + message history.
-- Maps an iMessage sender to ONE authenticated staff user + workspace.
-- Raw sender handles and pairing codes are NEVER persisted; only hashes.
-- photon_messages is the durable history + at-least-once dedupe log:
-- Spectrum retries a delivery with the SAME platform message id, so the
-- unique (direction, provider_message_id) constraint makes a redelivery
-- return the existing row instead of triggering a second reply.
-- (NULL provider ids never conflict, mirroring messages.client_id.)
-- Idempotent: safe to re-run. Zero Walrus writes.

create table if not exists photon_operator_bindings (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null references workspaces(id) on delete cascade,
  operator_user_id text not null references "user"(id) on delete cascade,
  sender_hash text,
  status text not null default 'pending'
    check (status in ('pending', 'active', 'revoked')),
  pairing_code_hash text,
  pairing_expires_at timestamptz,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  unique (workspace_id, sender_hash)
);

create index if not exists photon_bindings_sender_idx
  on photon_operator_bindings (sender_hash, status);

create table if not exists photon_messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id text references workspaces(id) on delete cascade,
  binding_id uuid references photon_operator_bindings(id) on delete set null,
  direction text not null check (direction in ('inbound', 'outbound')),
  webhook_id text,
  provider_message_id text,
  thread_id text,
  sender_hash text,
  body_text text not null default '',
  status text not null default 'received'
    check (status in ('received', 'replied', 'rejected', 'sent', 'failed')),
  reply_to_id uuid references photon_messages(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (direction, provider_message_id)
);

create index if not exists photon_messages_binding_idx
  on photon_messages (binding_id, created_at desc);

-- One outbound reply per inbound message: second claimants lose the race
-- and must NOT send. NULL reply_to_ids never conflict with each other.
create unique index if not exists photon_messages_reply_unique
  on photon_messages (reply_to_id);

-- Meros Photon S2 durable operator conversation address + proactive sends.
-- bindings.thread_id is the last inbound thread observed for an ACTIVE
-- binding: the durable conversation address used for server-initiated
-- outbound after cold starts (adapter rebuilds the thread from the chat
-- GUID encoded in it; no process-local state is ever required).
-- messages.idempotency_key scopes proactive-send dedupe: same key returns
-- the existing attempt instead of sending twice. NULL keys never conflict.
-- Idempotent: safe to re-run. Zero Walrus writes.

alter table if exists photon_operator_bindings
  add column if not exists thread_id text;

alter table if exists photon_messages
  add column if not exists idempotency_key text;

create unique index if not exists photon_messages_idempotency_unique
  on photon_messages (idempotency_key);

-- Meros Photon S3 per-operator notification preferences.
-- One row per (workspace, operator). Missing row = defaults:
-- proactive ON, quiet hours OFF (Africa/Lagos offered as the UI default).
-- Additive + idempotent. Zero Walrus writes.

create table if not exists operator_preferences (
  workspace_id text not null references workspaces(id) on delete cascade,
  operator_user_id text not null references "user"(id) on delete cascade,
  proactive_enabled boolean not null default true,
  quiet_hours_enabled boolean not null default false,
  quiet_start text not null default '22:00',
  quiet_end text not null default '07:00',
  timezone text not null default 'Africa/Lagos',
  updated_at timestamptz not null default now(),
  primary key (workspace_id, operator_user_id)
);

alter table if exists operator_preferences
  add column if not exists radar_enabled boolean not null default false;

-- S15B Automatic Incident Radar: per-operator explicit opt-in for
-- possible-incident iMessage alerts. Default FALSE (missing row or false
-- means OFF). Independent of proactive_enabled and quiet-hours gates,
-- which always apply on top. Additive + idempotent.

-- Meros S4 Incident Center: first-class durable incidents.
-- incidents own nothing but themselves: customers, conversations, fix
-- cards, and knowledge rows stay canonical in their own tables and are
-- linked below (no duplication, workspace checks on every link).
-- merged_into_incident_id is set ONLY on merged rows; split_from links a
-- child created by an explicit split action. Additive + idempotent.

create table if not exists incidents (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null references workspaces(id) on delete cascade,
  title text not null,
  description text not null default '',
  severity text not null default 'medium'
    check (severity in ('low', 'medium', 'high', 'critical')),
  status text not null default 'detected'
    check (status in ('detected', 'investigating', 'ready_for_action',
                       'recovering', 'monitoring', 'resolved',
                       'dismissed', 'merged', 'split')),
  resolution_summary text,
  resolved_at timestamptz,
  merged_into_incident_id uuid references incidents(id) on delete set null,
  split_from_incident_id uuid references incidents(id) on delete set null,
  created_by_user_id text references "user"(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists incidents_workspace_idx
  on incidents (workspace_id, status, updated_at desc);

create table if not exists incident_customers (
  incident_id uuid not null references incidents(id) on delete cascade,
  customer_id text not null references customers(id) on delete cascade,
  added_by_user_id text references "user"(id) on delete set null,
  added_at timestamptz not null default now(),
  primary key (incident_id, customer_id)
);

create table if not exists incident_conversations (
  incident_id uuid not null references incidents(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  added_by_user_id text references "user"(id) on delete set null,
  added_at timestamptz not null default now(),
  primary key (incident_id, conversation_id)
);

create table if not exists incident_evidence (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references incidents(id) on delete cascade,
  kind text not null check (kind in ('message', 'conversation', 'fix_card', 'knowledge', 'note')),
  ref_conversation_id uuid references conversations(id) on delete cascade,
  ref_message_id uuid references messages(id) on delete cascade,
  ref_fix_card_id uuid references fix_cards(id) on delete set null,
  ref_knowledge_id uuid references workspace_knowledge(id) on delete cascade,
  label text not null default '',
  note text not null default '',
  created_by_user_id text references "user"(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists incident_evidence_incident_idx
  on incident_evidence (incident_id, created_at);

create table if not exists incident_events (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references incidents(id) on delete cascade,
  kind text not null,
  actor_user_id text references "user"(id) on delete set null,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists incident_events_incident_idx
  on incident_events (incident_id, created_at);

-- Meros S5 automatic issue detection + candidate clusters.
-- Candidates are reviewable suggestions, never incidents: confirmation stays
-- human via the S4 domain. Evidence is reference-only (message/conversation
-- rows stay canonical in their own tables). A candidate surfaces for review
-- only with >= 2 distinct conversations. Dismissed rows are terminal history:
-- unchanged evidence never re-surfaces them; materially new reports form new
-- candidates without touching old dismissals. Additive + idempotent.

create table if not exists issue_candidates (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null references workspaces(id) on delete cascade,
  title text not null,
  summary text not null default '',
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'dismissed')),
  confidence text not null default 'medium'
    check (confidence in ('low', 'medium', 'high')),
  rationale text not null default '',
  accepted_incident_id uuid references incidents(id) on delete set null,
  dismissed_at timestamptz,
  dismissed_by_user_id text references "user"(id) on delete set null,
  dismissal_note text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists issue_candidates_workspace_idx
  on issue_candidates (workspace_id, status, last_seen_at desc);

create table if not exists issue_candidate_members (
  candidate_id uuid not null references issue_candidates(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  customer_id text not null references customers(id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (candidate_id, conversation_id)
);

create table if not exists issue_candidate_messages (
  candidate_id uuid not null references issue_candidates(id) on delete cascade,
  message_id uuid not null references messages(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  customer_id text not null references customers(id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (candidate_id, message_id)
);

-- One message attributes to exactly one candidate. Concurrent deliveries of
-- the same persisted message converge: exactly one insert wins, losers
-- re-read the winner instead of duplicating. Idempotent + additive.
create unique index if not exists issue_candidate_messages_message_unique
  on issue_candidate_messages (message_id);

-- S5 follow-up: created_at was missing from the first revision.
-- Standalone ALTER so existing tables gain it (CREATE ... IF NOT EXISTS
-- never revisits a table that already exists). Idempotent.
alter table if exists issue_candidates
  add column if not exists created_at timestamptz not null default now();

-- Meros S6 incident evidence briefs: one durable brief per incident.
-- Findings are strictly source-backed (message ids must exist in linked
-- conversations); anything uncited is rejected, never stored. Fingerprint
-- covers the exact source set so unchanged evidence never regenerates.
-- Status: pending (building) | current | stale (newer evidence waiting) |
-- failed (kept only when no usable brief exists yet). Additive + idempotent.

create table if not exists incident_evidence_briefs (
  incident_id uuid primary key references incidents(id) on delete cascade,
  workspace_id text not null references workspaces(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'current', 'stale', 'failed')),
  version integer not null default 1,
  fingerprint text not null default '',
  findings jsonb not null default '{}',
  source_count integer not null default 0,
  generated_at timestamptz,
  error text,
  updated_at timestamptz not null default now()
);

-- Meros S7 incident snapshot deliveries: one durable row per explicit
-- operator send of an evidence snapshot. The row is BOTH the delivery
-- record and the idempotency guard: unique(idempotency_key) means a
-- double-click, browser retry, or concurrent request with the same client
-- key returns the existing attempt instead of resending. The snapshot body
-- is derived deterministically from the persisted brief version +
-- fingerprint (never regenerated AI); 'sent' means accepted by Photon
-- (handset delivery is NOT confirmed). Additive + idempotent.

create table if not exists incident_snapshot_deliveries (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references incidents(id) on delete cascade,
  workspace_id text not null references workspaces(id) on delete cascade,
  binding_id uuid references photon_operator_bindings(id) on delete set null,
  brief_fingerprint text not null default '',
  brief_version integer not null default 1,
  idempotency_key text not null,
  status text not null default 'sending'
    check (status in ('sending', 'sent', 'failed')),
  provider_message_id text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists incident_snapshot_deliveries_key_unique
  on incident_snapshot_deliveries (idempotency_key);
create index if not exists incident_snapshot_deliveries_incident_idx
  on incident_snapshot_deliveries (incident_id, created_at desc);

-- Meros S7 proactive foundation (default-disabled): a bounded opt-in for
-- FUTURE automatic incident evidence notifications. Default false; nothing
-- in S7 reads it on any send path, and no automatic send exists yet.
-- Standalone ALTER so existing tables gain it. Additive + idempotent.
alter table if exists operator_preferences
  add column if not exists evidence_auto_notify boolean not null default false;

-- Meros S8 incident fix-card matches: read-only recommendations linking a
-- confirmed incident's evidence-brief fingerprint to authorized historical
-- Fix Cards (same workspace only). One row per (incident, fingerprint,
-- card); a new fingerprint inserts new rows while old rows stay as history.
-- 'current' = rows matching the brief's present fingerprint; anything else
-- renders stale. No autonomous action ever reads this table. Additive +
-- idempotent.

create table if not exists incident_fix_matches (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references incidents(id) on delete cascade,
  workspace_id text not null references workspaces(id) on delete cascade,
  brief_fingerprint text not null default '',
  brief_version integer not null default 1,
  ref_kind text not null default 'fix_card'
    check (ref_kind in ('fix_card')),
  ref_id uuid not null references fix_cards(id) on delete cascade,
  tier text not null
    check (tier in ('verified_fix', 'documented_unverified', 'possible_match')),
  payload jsonb not null default '{}',
  generated_at timestamptz not null default now()
);
create unique index if not exists incident_fix_matches_unique
  on incident_fix_matches (incident_id, brief_fingerprint, ref_id);
create index if not exists incident_fix_matches_incident_idx
  on incident_fix_matches (incident_id, generated_at desc);

-- Meros S9 recovery plans: staged, human-reviewable proposals. Planning
-- and review only — NOTHING here executes. One ACTIVE proposal per
-- (incident, evidence fingerprint) via the partial unique index below;
-- rejected/superseded rows stay as audit history. Plan states are
-- independent of the incident lifecycle. Additive + idempotent.

create table if not exists incident_recovery_plans (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references incidents(id) on delete cascade,
  workspace_id text not null references workspaces(id) on delete cascade,
  plan_version integer not null default 1,
  status text not null default 'draft'
    check (status in ('draft', 'under_review', 'staged', 'rejected', 'superseded')),
  brief_fingerprint text not null default '',
  brief_version integer not null default 1,
  payload jsonb not null default '{}',
  created_by_user_id text references "user"(id) on delete set null,
  reviewed_by_user_id text references "user"(id) on delete set null,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists incident_recovery_plans_active_unique
  on incident_recovery_plans (incident_id, brief_fingerprint)
  where status in ('draft', 'under_review', 'staged');
create index if not exists incident_recovery_plans_incident_idx
  on incident_recovery_plans (incident_id, plan_version desc);

-- Meros S10 approval + execution control plane. Approvals authorize an
-- EXACT staged scope (plan version + fingerprint + steps + params); any
-- drift invalidates. Only `manual_external_record` is a supported action
-- type — Meros runs no automatic provider-backed recovery. Execution rows
-- are claimed durably on idempotency keys before any manual work is
-- recorded; unknown_outcome stays until an independent verifier confirms.
-- Additive + idempotent. No incident lifecycle coupling.

create table if not exists incident_plan_approvals (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references incident_recovery_plans(id) on delete cascade,
  incident_id uuid not null references incidents(id) on delete cascade,
  workspace_id text not null references workspaces(id) on delete cascade,
  plan_version integer not null default 1,
  brief_fingerprint text not null default '',
  scope_hash text not null default '',
  scope jsonb not null default '{}',
  status text not null default 'requested'
    check (status in ('requested', 'approved', 'rejected', 'revoked', 'expired', 'invalidated')),
  risk_ack boolean not null default false,
  high_impact boolean not null default false,
  requested_by_user_id text references "user"(id) on delete set null,
  decided_by_user_id text references "user"(id) on delete set null,
  expires_at timestamptz,
  decided_at timestamptz,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists incident_plan_approvals_active_unique
  on incident_plan_approvals (plan_id)
  where status in ('requested', 'approved');
create index if not exists incident_plan_approvals_plan_idx
  on incident_plan_approvals (plan_id, created_at desc);

create table if not exists incident_action_executions (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references incidents(id) on delete cascade,
  workspace_id text not null references workspaces(id) on delete cascade,
  plan_id uuid not null references incident_recovery_plans(id) on delete cascade,
  approval_id uuid not null references incident_plan_approvals(id) on delete cascade,
  action_type text not null default 'manual_external_record'
    check (action_type in ('manual_external_record')),
  params jsonb not null default '{}',
  idempotency_key text not null default '',
  status text not null default 'unknown_outcome'
    check (status in ('pending', 'in_progress', 'provider_accepted', 'verified_success', 'verified_failure', 'unknown_outcome')),
  actor_user_id text references "user"(id) on delete set null,
  verifier_user_id text references "user"(id) on delete set null,
  provider_ref text,
  result_note text,
  verification_evidence text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists incident_action_executions_idem_unique
  on incident_action_executions (workspace_id, idempotency_key);
create index if not exists incident_action_executions_plan_idx
  on incident_action_executions (plan_id, created_at desc);

-- Meros S11 Resolution Watch: durable, evidence-backed tracking of whether
-- the customer problem improved, persisted, or returned after a recorded
-- S10 intervention. Action verification is never resolution: confirmed
-- status needs supporting customer evidence plus authorized verification.
-- Observations are append-only with per-message dedupe; history survives
-- evidence drift. Additive + idempotent. No incident lifecycle coupling.

create table if not exists incident_resolution_watches (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references incidents(id) on delete cascade,
  workspace_id text not null references workspaces(id) on delete cascade,
  plan_id uuid references incident_recovery_plans(id) on delete set null,
  approval_id uuid references incident_plan_approvals(id) on delete set null,
  execution_id uuid references incident_action_executions(id) on delete set null,
  baseline_fingerprint text not null default '',
  baseline_summary text not null default '',
  baseline_symptoms jsonb not null default '[]',
  status text not null default 'awaiting_evidence'
    check (status in ('awaiting_evidence', 'watching', 'improvement_indicated', 'still_affected', 'insufficient_evidence', 'resolution_confirmed')),
  last_observation_at timestamptz,
  last_evaluation_at timestamptz,
  confirmed_by_user_id text references "user"(id) on delete set null,
  confirmed_at timestamptz,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists incident_resolution_watches_active_unique
  on incident_resolution_watches (incident_id)
  where status != 'resolution_confirmed';
create index if not exists incident_resolution_watches_incident_idx
  on incident_resolution_watches (incident_id, created_at desc);

create table if not exists incident_watch_observations (
  id uuid primary key default gen_random_uuid(),
  watch_id uuid not null references incident_resolution_watches(id) on delete cascade,
  incident_id uuid not null references incidents(id) on delete cascade,
  workspace_id text not null references workspaces(id) on delete cascade,
  kind text not null default 'operator_note'
    check (kind in ('customer_improvement', 'customer_persistence', 'regression', 'operator_note', 'verification', 'system_note')),
  message_id uuid references messages(id) on delete set null,
  conversation_id uuid references conversations(id) on delete set null,
  excerpt text,
  created_by_user_id text references "user"(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index if not exists incident_watch_observations_msg_unique
  on incident_watch_observations (watch_id, message_id)
  where message_id is not null;
create index if not exists incident_watch_observations_watch_idx
  on incident_watch_observations (watch_id, created_at, id);

-- Meros S12 closure + postmortems: durable review records for safe,
-- human-controlled incident resolution. Drafts are refreshed from current
-- S4–S11 state (fingerprint-gated); finalized rows are immutable history
-- that survives reopening. One draft per incident; finalized rows are
-- append-only. Additive + idempotent. No lifecycle coupling.

create table if not exists incident_postmortems (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references incidents(id) on delete cascade,
  workspace_id text not null references workspaces(id) on delete cascade,
  watch_id uuid references incident_resolution_watches(id) on delete set null,
  status text not null default 'draft'
    check (status in ('draft', 'finalized')),
  source_fingerprint text not null default '',
  brief_fingerprint text not null default '',
  content jsonb not null default '{}',
  created_by_user_id text references "user"(id) on delete set null,
  finalized_by_user_id text references "user"(id) on delete set null,
  finalized_at timestamptz,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists incident_postmortems_draft_unique
  on incident_postmortems (incident_id)
  where status = 'draft';
create unique index if not exists incident_postmortems_final_unique
  on incident_postmortems (incident_id, source_fingerprint)
  where status = 'finalized';
create index if not exists incident_postmortems_incident_idx
  on incident_postmortems (incident_id, status, created_at desc);

-- Meros S13 Operator Memory: provenance links from finalized postmortems
-- to Fix Cards proposed as reusable knowledge. The card lifecycle itself
-- (pending → shared/kept_private/failed/superseded) stays in fix_cards;
-- this table records WHY a card exists: which incident + postmortem it
-- came from, the intended tier, and whether the closure was verified.
-- One candidate per postmortem (dedupe); history is append-only.
-- Additive + idempotent. No lifecycle coupling.

create table if not exists incident_memory_links (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references incidents(id) on delete cascade,
  workspace_id text not null references workspaces(id) on delete cascade,
  postmortem_id uuid not null references incident_postmortems(id) on delete cascade,
  fix_card_id uuid not null references fix_cards(id) on delete cascade,
  tier text not null default 'documented_unverified'
    check (tier in ('verified_fix', 'documented_unverified')),
  verified boolean not null default false,
  source_fingerprint text not null default '',
  created_by_user_id text references "user"(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index if not exists incident_memory_links_postmortem_unique
  on incident_memory_links (postmortem_id);
create unique index if not exists incident_memory_links_card_unique
  on incident_memory_links (fix_card_id);
create index if not exists incident_memory_links_incident_idx
  on incident_memory_links (incident_id, created_at desc);

-- Meros S14 Knowledge Health: advisory findings about knowledge quality —
-- recurring problems without documented solutions, possibly conflicting
-- guidance, and stale memory provenance. Findings dedupe on
-- (workspace, entity_key); changed evidence supersedes the prior open row
-- (history preserved, never deleted). Additive + idempotent.

create table if not exists knowledge_findings (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null references workspaces(id) on delete cascade,
  type text not null default 'gap'
    check (type in ('gap', 'contradiction', 'stale')),
  confidence text not null default 'low'
    check (confidence in ('high', 'low')),
  status text not null default 'open'
    check (status in ('open', 'acknowledged', 'dismissed', 'addressed', 'superseded')),
  title text not null default '',
  detail jsonb not null default '{}',
  fingerprint text not null default '',
  entity_key text not null default '',
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  reviewed_by_user_id text references "user"(id) on delete set null,
  review_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists knowledge_findings_open_unique
  on knowledge_findings (workspace_id, entity_key)
  where status in ('open', 'acknowledged');
-- Meros S15E Recover Many: staff-reviewed, per-recipient recovery
-- staging. One review workflow may cover several individually eligible
-- customers. Batch approval binds exact plan/brief/recipients/payloads;
-- per-recipient rows track eligibility, drafts, approval and publish
-- state independently. Additive + idempotent. No lifecycle coupling.

alter table if exists messages
  add column if not exists author_kind text not null default 'ai'
  check (author_kind in ('ai', 'staff'));

create table if not exists incident_recovery_batches (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references incidents(id) on delete cascade,
  workspace_id text not null references workspaces(id) on delete cascade,
  plan_id uuid references incident_recovery_plans(id) on delete set null,
  plan_version integer not null default 0,
  brief_fingerprint text not null default '',
  scope_hash text not null default '',
  fingerprint text not null default '',
  status text not null default 'draft'
    check (status in ('draft', 'approved', 'revoked', 'superseded')),
  high_impact boolean not null default false,
  created_by_user_id text references "user"(id) on delete set null,
  approved_by_user_id text references "user"(id) on delete set null,
  approved_at timestamptz,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists incident_recovery_batches_active_unique
  on incident_recovery_batches (incident_id)
  where status in ('draft', 'approved');
create index if not exists incident_recovery_batches_incident_idx
  on incident_recovery_batches (incident_id, created_at desc);

create table if not exists incident_recovery_recipients (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references incident_recovery_batches(id) on delete cascade,
  incident_id uuid not null references incidents(id) on delete cascade,
  workspace_id text not null references workspaces(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  customer_id text not null references customers(id) on delete cascade,
  eligibility text not null default 'needs_review'
    check (eligibility in ('eligible', 'needs_review', 'excluded')),
  reason_code text not null default 'unevaluated',
  evidence_refs jsonb not null default '[]',
  draft_text text not null default '',
  payload_hash text not null default '',
  status text not null default 'draft'
    check (status in ('draft', 'approved', 'published_to_conversation', 'failed', 'unknown')),
  idempotency_key text not null default '',
  provider_message_id text,
  decided_by_user_id text references "user"(id) on delete set null,
  decided_at timestamptz,
  error_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists incident_recovery_recipients_batch_conv_unique
  on incident_recovery_recipients (batch_id, conversation_id);
create unique index if not exists incident_recovery_recipients_idem_unique
  on incident_recovery_recipients (workspace_id, idempotency_key);
create index if not exists incident_recovery_recipients_batch_idx
  on incident_recovery_recipients (batch_id, created_at);