import { NextResponse } from "next/server";
import { getMemwalServerUrl, isMainnetRelayer, isNeonConfigured, isWalrusConfigured } from "@/lib/env";
import { checkMemwalHealth } from "@/lib/walrus";
import { geminiStatus } from "@/lib/gemini";
import { aiStatus } from "@/lib/ai-provider";
import { isPhotonConfigured } from "@/lib/photon/config";
import { dbAvailable } from "@/lib/db";

/**
 * Deployment verification. Reports configuration/reachability booleans only:
 * no secret values, no keys, no connection strings. Performs NO Walrus
 * writes and NO Gemini calls — a short read-only Neon probe plus a public
 * MemWal /health + /version probe are the only I/O beyond config checks.
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
  // Operational probe (no writes, no memory reads): distinguishes a healthy
  // but empty namespace from relayer outage / auth / incompatibility.
  // `configured` alone previously masked all runtime failures as healthy.
  let probe: Awaited<ReturnType<typeof checkMemwalHealth>> | null = null;
  if (isWalrusConfigured()) {
    try {
      probe = await checkMemwalHealth({ timeoutMs: 8_000 });
    } catch {
      probe = null;
    }
  }
  return NextResponse.json({
    ok: true,
    app: "meros",
    neon: { configured: isNeonConfigured(), reachable: databaseReachable },
    gemini: geminiStatus(),
    ai: aiStatus(),
    walrus: {
      configured: isWalrusConfigured(),
      serverUrl,
      mainnet: isMainnetRelayer(serverUrl),
      operational: probe?.operational ?? false,
      ...(probe
        ? {
            errorKind: probe.errorKind,
            latencyMs: probe.latencyMs,
            ...(probe.apiVersion ? { apiVersion: probe.apiVersion } : {}),
            ...(probe.relayerVersion ? { relayerVersion: probe.relayerVersion } : {}),
            ...(probe.writes ? { writes: probe.writes } : {}),
          }
        : { errorKind: "not_configured" as const }),
    },
    auth: { configured: authConfigured },
    photon: { configured: isPhotonConfigured() },
  });
}
