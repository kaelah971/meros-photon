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