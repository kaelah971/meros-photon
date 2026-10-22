import { NextResponse } from "next/server";
import { generateJson } from "@/lib/gemini";
import { previewUserId } from "@/lib/identity";
import { identityError, resolveProductIdentity } from "@/lib/product-identity";
import type { AuthenticatedCustomer } from "@/lib/tenant-store";
import type { ChatTurn } from "@/lib/gemini";
import {
  dropKnownFacts,
  validateExtractedFacts,
  type ExtractedFact,
} from "@/lib/support-memory";
import { WalrusNotConfiguredError, classifyMemwalError, rememberPrivate, type MemwalFailureKind } from "@/lib/walrus";
import { isWalrusConfigured } from "@/lib/env";

const EXTRACTION_SYSTEM = `You extract durable support-memory facts from one support turn. Return a JSON array (max 3 items) of {"type","text"}.
Types: PROFILE (stable user environment/preference), ISSUE (problem symptom), ATTEMPT (troubleshooting step tried + outcome), RESOLUTION (confirmed fix), CORRECTION (new fact superseding older info).
Rules:
- Only high-confidence facts explicitly stated by the USER or clearly observed in the turn. Never assistant guesses, never generic advice.
- "text" is a compact standalone fact (10-500 chars), no [TYPE] prefix, no names/emails/secrets.
- Skip anything already listed under ALREADY KNOWN.
- If nothing durable, return [].`;

export type CaptureResult = {
  type: string;
  text: string;
  status: "stored" | "failed" | "skipped";
  blobId?: string;
  error?: string;
  /** Privacy-safe write-failure category (auth/timeout/unavailable/...). */
  errorKind?: MemwalFailureKind;
};

/**
 * Explicit, high-confidence capture only. The chat UI calls this AFTER
 * rendering the answer (non-blocking for chat latency); this endpoint still
 * awaits real Walrus completion per fact and reports honest per-fact status.
 */
export async function POST(req: Request) {
  let body: {
    workspaceSlug?: unknown;
    message?: unknown;
    answer?: unknown;
    history?: unknown;
    knownTexts?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  // Facts land in the CURRENT workspace/customer scope only.
  let tenant: AuthenticatedCustomer;
  try {
    tenant = await resolveProductIdentity(body);
  } catch (e) {
    const err = identityError(e);
    return NextResponse.json({ ok: false, error: err.message }, { status: err.status });
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  const answer = typeof body.answer === "string" ? body.answer.trim() : "";
  if (!message || message.length < 12) {
    return NextResponse.json({ ok: true, facts: [], note: "turn too short to capture" });
  }
  // Fail honest when credentials are missing: per-fact handlers below must
  // not downgrade this to ok:true/failed (that masked deploys with no keys).
  if (!isWalrusConfigured()) {
    const blocker = new WalrusNotConfiguredError();
    return NextResponse.json(
      { ok: false, error: blocker.message, needed: blocker.needed },
      { status: 503 },
    );
  }
  const history: ChatTurn[] = Array.isArray(body.history)
    ? (body.history as ChatTurn[]).filter((t) => t && typeof t.text === "string").slice(-4)
    : [];
  const knownTexts = Array.isArray(body.knownTexts)
    ? (body.knownTexts as unknown[]).filter((t): t is string => typeof t === "string")
    : [];

  let raw: unknown;
  try {
    raw = await generateJson({
      systemInstruction: EXTRACTION_SYSTEM,
      userText: [
        `ALREADY KNOWN:\n${knownTexts.slice(0, 8).join("\n") || "(none)"}`,
        `USER: ${message.slice(0, 2000)}`,
        `ASSISTANT: ${answer.slice(0, 2000)}`,
        history.length > 0
          ? `RECENT: ${history.map((h) => `${h.role}: ${h.text.slice(0, 500)}`).join("\n")}`
          : "",
      ].join("\n\n"),
    });
  } catch (e) {
    // Extraction runs before any Walrus write. A failure here means no
    // private write was attempted, so report a skipped capture (ok:true,
    // zero facts) rather than a failed save. The chat answer already
    // succeeded; the client stays silent on skipped captures.
    const reason = e instanceof Error ? e.message : "extraction failed";
    console.log(`[capture] extraction unavailable — skipped (${reason})`);
    return NextResponse.json({
      ok: true,
      facts: [],
      skipped: "extraction",
      note: "extraction unavailable — skipped",
      userPreview: previewUserId(tenant.customerId),
    });
  }

  const facts: ExtractedFact[] = dropKnownFacts(validateExtractedFacts(raw), knownTexts);
  if (facts.length === 0) {
    return NextResponse.json({
      ok: true,
      facts: [],
      userPreview: previewUserId(tenant.customerId),
    });
  }

  const results: CaptureResult[] = [];
  try {
    for (const f of facts) {
      try {
        const done = await rememberPrivate(tenant.privateNamespace, f.text);
        results.push({ type: f.type, text: f.text, status: "stored", blobId: done.blobId });
      } catch (e) {
        // Never mask a missing-credential deploy as a per-fact write fail.
        if (e instanceof WalrusNotConfiguredError) throw e;
        const classified = classifyMemwalError(e);
        console.log(`[capture] private write ${classified.kind} (${f.type})`);
        results.push({
          type: f.type,
          text: f.text,
          status: "failed",
          error: classified.message,
          errorKind: classified.kind,
        });
      }
    }
  } catch (e) {
    if (e instanceof WalrusNotConfiguredError) {
      return NextResponse.json(
        { ok: false, error: e.message, needed: e.needed },
        { status: 503 },
      );
    }
    throw e;
  }

  return NextResponse.json({
    ok: true,
    facts: results,
    userPreview: previewUserId(tenant.customerId),
    workspace: tenant.workspace,
  });
}
