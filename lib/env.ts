// Server-side environment access. Never import this from client components.
// Intentionally does NOT throw at import time so `next build` passes without
// credentials. Routes check `isWalrusConfigured()` and return an honest 503.

export const MAINNET_RELAYER_URL = "https://relayer.memory.walrus.xyz";

export function getMemwalServerUrl(): string {
  const v = process.env.MEMWAL_SERVER_URL?.trim();
  return v || MAINNET_RELAYER_URL;
}

export function isMainnetRelayer(url: string): boolean {
  return url.includes("relayer.memory.walrus.xyz");
}

export function getMemwalPrivateKey(): string | null {
  return process.env.MEMWAL_PRIVATE_KEY?.trim() || null;
}

export function getMemwalAccountId(): string | null {
  return process.env.MEMWAL_ACCOUNT_ID?.trim() || null;
}

export function isWalrusConfigured(): boolean {
  return Boolean(getMemwalPrivateKey() && getMemwalAccountId());
}

export function walrusBlocker(): {
  reason: string;
  needed: string[];
} {
  const needed: string[] = [];
  if (!getMemwalPrivateKey()) needed.push("MEMWAL_PRIVATE_KEY");
  if (!getMemwalAccountId()) needed.push("MEMWAL_ACCOUNT_ID");
  return {
    reason:
      "Walrus Memory credentials are not configured on the server. " +
      "Write/recall cannot run without a Mainnet account + delegate key.",
    needed,
  };
}

export function getIdSalt(): string {
  return process.env.MEROS_ID_SALT?.trim() || "meros-p0-v1";
}

export function isNeonConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}

/**
 * Legacy access-code identity (P0/P5 bootstrap) is a LOCAL DEV diagnostic
 * only. It is enabled solely when the flag is explicitly "true" AND the
 * runtime is not production — production refuses legacy identity even if
 * the flag is accidentally set. Disabled by default (unset/false).
 */
export function isLegacyDevIdentityEnabled(): boolean {
  return (
    process.env.MEROS_ENABLE_LEGACY_DEV_IDENTITY === "true" &&
    process.env.NODE_ENV !== "production"
  );
}

export function isGeminiConfigured(): boolean {
  return Boolean(
    process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim(),
  );
}

export function isDeepseekConfigured(): boolean {
  return Boolean(process.env.DEEPSEEK_API_KEY?.trim());
}

export type AiProviderId = "deepseek" | "gemini";

/**
 * Active AI provider. Explicit AI_PROVIDER wins ("deepseek" | "gemini");
 * otherwise auto: DeepSeek when its key is present, else Gemini.
 * Explicit "deepseek" without a key stays deepseek so callers throw
 * honestly instead of silently falling back to Gemini.
 */
export function getActiveProvider(): AiProviderId {
  const explicit = process.env.AI_PROVIDER?.trim().toLowerCase();
  if (explicit === "deepseek" || explicit === "gemini") return explicit;
  return isDeepseekConfigured() ? "deepseek" : "gemini";
}
