import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Regression guard for the fresh-Photon-DB failure (Oct 2026):
// `npm run db:migrate` died with `relation "user" does not exist` because
// schema.sql was applied BEFORE better-auth-schema.sql, while schema.sql
// holds FKs to `"user"` (customers.auth_user_id, organization_members,
// fix_cards.reviewed_by, photon bindings). Static checks only — no DB, no
// migration run. Rerun safety comes from the runner tolerating 42P07/42710
// plus every schema.sql statement being IF NOT EXISTS / IF EXISTS guarded
// or duplicate-tolerant.

const root = process.cwd();
const runnerSrc = readFileSync(join(root, "scripts", "db-migrate.mjs"), "utf8");
const schemaSrc = readFileSync(join(root, "db", "schema.sql"), "utf8");
const authSrc = readFileSync(join(root, "db", "better-auth-schema.sql"), "utf8");

function migrationFiles(): string[] {
  const m = runnerSrc.match(/const files\s*=\s*\[([\s\S]*?)\]/);
  if (!m) throw new Error("migration file list not found in db-migrate.mjs");
  return [...m[1].matchAll(/"([^"]+)"/g)].map((g) => g[1]);
}

describe("migration ordering (static)", () => {
  it("applies Better Auth schema before application schema", () => {
    expect(migrationFiles()).toEqual(["db/better-auth-schema.sql", "db/schema.sql"]);
  });

  it("the first-applied file creates the user table it references", () => {
    const createIdx = authSrc.indexOf('create table "user"');
    expect(createIdx, "better-auth-schema.sql must create \"user\"").toBeGreaterThanOrEqual(0);
    const firstRef = authSrc.indexOf('references "user"');
    expect(
      firstRef === -1 || createIdx < firstRef,
      "no FK to \"user\" may precede its creation in better-auth-schema.sql",
    ).toBe(true);
  });

  it("runner stays additive: tolerates already-exists, never drops", () => {
    expect(runnerSrc).toMatch(/42P07/);
    expect(runnerSrc).toMatch(/42710/);
    // Statement-level check only: the header comment documents the
    // no-drop guarantee in prose ("NEVER drops, truncates"), so match
    // executable verbs, not substrings.
    expect(runnerSrc).not.toMatch(/\bdrop\s+table\b/i);
    expect(runnerSrc).not.toMatch(/\btruncate\b/i);
  });

  it("schema.sql FKs to the auth user table are covered by the ordering", () => {
    // Every cross-file FK target must exist after the first file runs.
    expect(authSrc).toMatch(/create table "user"/);
    expect(schemaSrc).toMatch(/references "user"/);
  });
});
