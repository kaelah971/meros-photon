import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { WalrusNotConfiguredError, classifyMemwalError } from "../walrus";

const fakeState: { mode: "empty-then-auth" | "hang" } = { mode: "empty-then-auth" };

vi.mock("@mysten-incubation/memwal", () => ({
  MemWal: {
    create: () => ({
      recall: async ({ namespace }: { namespace: string }) => {
        if (fakeState.mode === "hang") return new Promise(() => {});
        if (namespace.includes("empty")) return { total: 0, results: [] };
        const err = new Error("401 from relayer: wrong private key") as Error & {
          status: number;
          serverCode: string;
        };
        err.status = 401;
        err.serverCode = "AUTH_REJECTED";
        throw err;
      },
    }),
  },
}));

const SAVED_ENV = { ...process.env };

function withWalrusEnv() {
  process.env.MEMWAL_PRIVATE_KEY = "0".repeat(64);
  process.env.MEMWAL_ACCOUNT_ID = "0xabc";
}

describe("classifyMemwalError (privacy-safe taxonomy)", () => {
  beforeEach(() => withWalrusEnv());
  afterEach(() => {
    process.env = { ...SAVED_ENV };
    vi.resetModules();
  });

  it("not_configured for missing credentials", () => {
    const out = classifyMemwalError(new WalrusNotConfiguredError());
    expect(out.kind).toBe("not_configured");
    expect(out.message).not.toMatch(/0x|private|secret/i);
  });

  it("auth for 401 / AUTH_REJECTED", () => {
    const err = new Error(
      "401 from relayer: typically wrong private key, key not registered on this account",
    ) as Error & { status: number; serverCode: string };
    err.status = 401;
    err.serverCode = "AUTH_REJECTED";
    expect(classifyMemwalError(err).kind).toBe("auth");
  });

  it("auth for clock-drift 401", () => {
    const err = new Error("timestamp out of bounds") as Error & { status: number };
    err.status = 401;
    expect(classifyMemwalError(err).kind).toBe("auth");
  });

  it("incompatible for 426 / MemWalCompatibilityError", () => {
    const err = new Error("Walrus Memory relayer rejected this SDK (426)") as Error & {
      status: number;
    };
    err.status = 426;
    err.name = "MemWalCompatibilityError";
    expect(classifyMemwalError(err).kind).toBe("incompatible");
  });

  it("rate_limited for 429", () => {
    const err = new Error("Too Many Requests") as Error & { status: number };
    err.status = 429;
    expect(classifyMemwalError(err).kind).toBe("rate_limited");
  });

  it("timeout for aborts and 504", () => {
    const abort = new Error("This operation was aborted");
    abort.name = "AbortError";
    expect(classifyMemwalError(abort).kind).toBe("timeout");
    const t504 = new Error("Walrus Memory request timed out") as Error & { status: number };
    t504.status = 504;
    t504.name = "MemWalRequestTimeout";
    expect(classifyMemwalError(t504).kind).toBe("timeout");
  });

  it("unavailable for 503 without auth header", () => {
    const err = new Error("Walrus Memory server error (503)") as Error & { status: number };
    err.status = 503;
    expect(classifyMemwalError(err).kind).toBe("unavailable");
  });

  it("unavailable for network failures", () => {
    expect(classifyMemwalError(new Error("fetch failed")).kind).toBe("unavailable");
  });

  it("unavailable for relayer-edge 404 (service not serving)", () => {
    const err = new Error("Health check failed: 404") as Error & { status: number };
    err.status = 404;
    const out = classifyMemwalError(err);
    expect(out.kind).toBe("unavailable");
    expect(out.message).not.toMatch(/secret/i);
  });

  it("never echoes raw server bodies", () => {
    const err = new Error("Walrus Memory server error (500): <secret-blob-payload>") as Error & {
      status: number;
      cause: string;
    };
    err.status = 500;
    err.cause = "super-secret-raw-body";
    const out = classifyMemwalError(err);
    expect(out.kind).toBe("unavailable");
    expect(out.message).not.toMatch(/secret-blob-payload|super-secret/);
  });
});

describe("recallBounded preserves failure kind (mocked client)", () => {
  beforeEach(async () => {
    withWalrusEnv();
    vi.resetModules();
    fakeState.mode = "empty-then-auth";
  });
  afterEach(() => {
    process.env = { ...SAVED_ENV };
  });

  it("ok with zero hits classifies as empty, auth error stays auth", async () => {
    const { recallBounded } = await import("../walrus");
    const empty = await recallBounded("ns-empty", "q", { timeoutMs: 2000 });
    expect(empty.status).toBe("ok");
    expect(empty.errorKind).toBe("empty");
    const denied = await recallBounded("ns-denied", "q", { timeoutMs: 2000 });
    expect(denied.status).toBe("error");
    expect(denied.errorKind).toBe("auth");
    expect(denied.error).not.toMatch(/private|secret/i);
  });

  it("hang becomes timeout kind, never a hang", async () => {
    fakeState.mode = "hang";
    const { recallBounded } = await import("../walrus");
    const out = await recallBounded("ns", "q", { timeoutMs: 80 });
    expect(out.status).toBe("timeout");
    expect(out.errorKind).toBe("timeout");
  });
});

describe("checkMemwalHealth never throws without credentials", () => {
  afterEach(() => {
    process.env = { ...SAVED_ENV };
    vi.resetModules();
  });

  it("not_configured when keys missing (no network)", async () => {
    delete process.env.MEMWAL_PRIVATE_KEY;
    delete process.env.MEMWAL_ACCOUNT_ID;
    const { checkMemwalHealth } = await import("../walrus");
    const probe = await checkMemwalHealth({ timeoutMs: 1000 });
    expect(probe.operational).toBe(false);
    expect(probe.errorKind).toBe("not_configured");
  });
});
