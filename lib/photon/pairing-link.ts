// Pure pairing-link helpers: sms: compose URLs, QR payloads, countdowns.
// No secrets, no network, no storage — safe to run anywhere (client, tests).

/** The exact message the operator sends from Messages. Never auto-sent. */
export function pairingMessage(code: string): string {
  return `pair ${code.trim().toUpperCase()}`;
}

/**
 * OS-supported Messages compose link with a prefilled (unsent) body.
 * With a verified contact: `sms:<contact>&body=…`. Without one, `sms:&body=…`
 * opens the composer so the operator picks the recipient by hand.
 * Opening NEVER sends — the operator reviews and presses Send. Depending on
 * the device/contact, delivery may fall back to SMS; nothing here promises
 * iMessage transport.
 */
export function composeLink(code: string, contact: string | null): string {
  const to = contact?.trim() ? contact.trim() : "";
  return `sms:${to}&body=${encodeURIComponent(pairingMessage(code))}`;
}

/** QR encodes the same compose flow — scanning only opens Messages. */
export function qrPayloadForPairing(code: string, contact: string | null): string {
  return composeLink(code, contact);
}

/** Seconds until expiry (<=0 means expired). Pure — drives the countdown. */
export function pairingSecondsLeft(expiresAt: string, nowMs: number = Date.now()): number {
  const t = new Date(expiresAt).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((t - nowMs) / 1000));
}

export function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, totalSeconds);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

/**
 * Server-side contact sanitizer for MEROS_IMESSAGE_CONTACT. Only plain
 * dialable characters survive; anything else (urls, letters, injections)
 * yields null and the UI falls back to manual recipient selection.
 */
export function sanitizePairingContact(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!/^[+]?[0-9(][0-9 ()-]{5,24}$/.test(t)) return null;
  return t;
}
