/**
 * Meros database migration: `npm run db:migrate`.
 *
 * Applies db/better-auth-schema.sql + db/schema.sql additively and
 * idempotently against DATABASE_URL. Better Auth tables go FIRST because
 * schema.sql holds foreign keys to `"user"` (customers.auth_user_id,
 * organization_members, fix_cards.reviewed_by, photon bindings) that fail
 * on a fresh database when the auth tables do not exist yet.
 * Statement failures meaning
 * "already exists" (42P07 / 42710) are tolerated so re-runs are safe;
 * anything else exits nonzero. NEVER drops, truncates, or reseeds —
 * existing production data is left untouched. Creates zero Walrus writes.
 *
 * Usage: DATABASE_URL=... npm run db:migrate
 *
 * NOTE: plain JavaScript on purpose — runs with stock `node`, no tsx needed.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadLocalEnv() {
  // Local-dev convenience only: fall back to .env.local when the variable
  // is not already set (production env always wins; file is gitignored).
  if (process.env.DATABASE_URL) return;
  try {
    for (const line of readFileSync(join(root, ".env.local"), "utf8").split("\n")) {
      const i = line.indexOf("=");
      if (i > 0 && line.slice(0, i).trim() === "DATABASE_URL") {
        process.env.DATABASE_URL = line.slice(i + 1).trim();
        return;
      }
    }
  } catch {
    // No .env.local — caller must provide DATABASE_URL.
  }
}

async function main() {
  loadLocalEnv();
  const url = (process.env.DATABASE_URL || "").trim();
  if (!url) {
    console.error("db:migrate: DATABASE_URL is not set.");
    process.exit(1);
  }
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(url);

  const files = ["db/better-auth-schema.sql", "db/schema.sql"];
  let applied = 0;
  let skipped = 0;
  for (const file of files) {
    const text = readFileSync(join(root, file), "utf8");
    // Split on semicolons; strip full-line comments first.
    const noComments = text
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    // Split ONLY on semicolons at end of line: inline `--` comments may
    // contain semicolons mid-line (e.g. column docs) that must be preserved.
    const statements = noComments
      .split(/;[ \t]*\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const stmt of statements) {
      try {
        await sql.query(stmt);
        applied += 1;
      } catch (e) {
        const code = e && typeof e === "object" && "code" in e ? String(e.code) : "";
        if (code === "42P07" || code === "42710") {
          skipped += 1; // already exists — idempotent re-run
        } else {
          console.error(`db:migrate: failed on ${file}:`, e instanceof Error ? e.message : e);
          process.exit(1);
        }
      }
    }
  }
  console.log(`db:migrate: ok (applied=${applied} already-existed=${skipped})`);
}

void main();
