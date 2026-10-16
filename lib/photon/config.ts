// Photon / Spectrum Cloud iMessage configuration (S1).
// Mirrors lib/env.ts conventions: no throw at import time (so `next build`
// passes without credentials), boolean gates + honest 503s at request time.
// Never returns secret VALUES — only presence booleans and missing names.

export function getPhotonProjectId(): string | null {
  return process.env.IMESSAGE_PROJECT_ID?.trim() || null;
}

export function getPhotonProjectSecret(): string | null {
  return process.env.IMESSAGE_PROJECT_SECRET?.trim() || null;
}

export function getPhotonWebhookSecret(): string | null {
  return process.env.IMESSAGE_WEBHOOK_SECRET?.trim() || null;
}

/**
 * S1 needs all three: project credentials to SEND (adapter app build) and
 * the per-webhook signing secret to RECEIVE (signature verification inside
 * the official adapter's handleWebhook). Partial config is treated as
 * unconfigured so the route fails honestly instead of half-working.
 */
export function isPhotonConfigured(): boolean {
  return Boolean(
    getPhotonProjectId() && getPhotonProjectSecret() && getPhotonWebhookSecret(),
  );
}

export class PhotonNotConfiguredError extends Error {
  needed: string[];
  constructor() {
    const needed: string[] = [];
    if (!getPhotonProjectId()) needed.push("IMESSAGE_PROJECT_ID");
    if (!getPhotonProjectSecret()) needed.push("IMESSAGE_PROJECT_SECRET");
    if (!getPhotonWebhookSecret()) needed.push("IMESSAGE_WEBHOOK_SECRET");
    super(
      "Photon iMessage is not configured on the server. " +
        "Live iMessage receive + reply needs Spectrum Cloud credentials.",
    );
    this.name = "PhotonNotConfiguredError";
    this.needed = needed;
  }
}
