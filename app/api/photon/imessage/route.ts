import { after } from "next/server";
import { PhotonNotConfiguredError } from "@/lib/photon/config";

// Official Photon serverless webhook pattern: the Chat SDK adapter verifies
// the Spectrum signature (IMESSAGE_WEBHOOK_SECRET) and rejects unsigned /
// stale / bad deliveries itself. Processing continues in the background via
// `after`, so Spectrum gets a fast acknowledgement; retries are at-least-once
// and deduped durably in Neon (see lib/photon/history.ts).
export async function POST(request: Request): Promise<Response> {
  let bot: ReturnType<typeof import("@/lib/photon/bot").getBot>;
  try {
    const { getBot } = await import("@/lib/photon/bot");
    bot = getBot();
  } catch (e) {
    if (e instanceof PhotonNotConfiguredError) {
      return Response.json({ ok: false, error: e.message, needed: e.needed }, { status: 503 });
    }
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : "photon unavailable" },
      { status: 503 },
    );
  }
  return bot.webhooks.imessage(request, {
    waitUntil: (task) => after(() => task),
  });
}
