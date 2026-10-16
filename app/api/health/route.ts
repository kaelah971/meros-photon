import { NextResponse } from "next/server";
import { getMemwalServerUrl, isMainnetRelayer, isNeonConfigured } from "@/lib/env";
import { geminiStatus } from "@/lib/gemini";
import { isWalrusConfigured } from "@/lib/env";
import { isPhotonConfigured } from "@/lib/photon/config";
import { dbAvailable } from "@/lib/db";

/**
 * Deployment verification. Reports configuration/reachability booleans only:
 * no secret values, no keys, no connection strings. Performs NO Walrus
 * writes and NO Gemini calls — a short read-only Neon probe is the only
 * I/O beyond config checks.
 */
export async function GET() {
  const serverUrl = getMemwalServerUrl();
  let databaseReachable = false;
  if (isNeonConfigured()) {
    try {
      databaseReachable = await dbAvailable();
      if (databaseReachable) {
        // Read-only probe: list tables without touching data.
        const { neon } = await import("@neondatabase/serverless");
        const sql = neon(process.env.DATABASE_URL!.trim());
        await sql`select 1 as ok`;
      }
    } catch {
      databaseReachable = false;
    }
  }
  const authConfigured = Boolean(process.env.BETTER_AUTH_SECRET?.trim());
  return NextResponse.json({
    ok: true,
    app: "meros",
    neon: { configured: isNeonConfigured(), reachable: databaseReachable },
    gemini: geminiStatus(),
    walrus: {
      configured: isWalrusConfigured(),
      serverUrl,
      mainnet: isMainnetRelayer(serverUrl),
    },
    auth: { configured: authConfigured },
    photon: { configured: isPhotonConfigured() },
  });
}
