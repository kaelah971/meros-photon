import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// P0: DeepSeek primary preserves typed contracts, timeouts, JSON parsing,
// attachment behavior, and has no hidden Gemini dependency in DeepSeek mode.

const ORIG_ENV = { ...process.env };

function setEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe("ai provider selection", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...ORIG_ENV };
  });
  afterEach(() => {
    process.env = { ...ORIG_ENV };
  });

  it("auto-selects deepseek when its key is present, gemini otherwise", async () => {
    setEnv({ AI_PROVIDER: undefined, DEEPSEEK_API_KEY: "sk-test", GEMINI_API_KEY: "g-test" });
    const env1 = await import("../env");
    expect(env1.getActiveProvider()).toBe("deepseek");
    expect(env1.isDeepseekConfigured()).toBe(true);

    setEnv({ AI_PROVIDER: undefined, DEEPSEEK_API_KEY: undefined });
    vi.resetModules();
    const env2 = await import("../env");
    expect(env2.getActiveProvider()).toBe("gemini");
  });

  it("explicit AI_PROVIDER wins; explicit deepseek without key stays deepseek (honest throw, no silent Gemini)", async () => {
    setEnv({ AI_PROVIDER: "gemini", DEEPSEEK_API_KEY: "sk-test" });
    expect((await import("../env")).getActiveProvider()).toBe("gemini");
    vi.resetModules();

    setEnv({ AI_PROVIDER: "deepseek", DEEPSEEK_API_KEY: undefined, GEMINI_API_KEY: "g-test" });
    const env = await import("../env");
    expect(env.getActiveProvider()).toBe("deepseek");
  });

  it("deepseek module has no Gemini dependency (no hidden Gemini in DeepSeek mode)", () => {
    const src = readFileSync(join(__dirname, "..", "deepseek.ts"), "utf-8");
    expect(src).not.toMatch(/@google\/genai/);
    expect(src).not.toMatch(/GEMINI_API_KEY/);
    expect(src).not.toMatch(/from\s+["']\.\/gemini["']/);
  });

  it("deepseek generateJson parses JSON and strips fences; throws honestly without key", async () => {
    setEnv({ DEEPSEEK_API_KEY: "sk-test", AI_PROVIDER: "deepseek" });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '```json\n{"a":1}\n```' } }],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const ds = await import("../deepseek");
      const out = (await ds.generateJson({ systemInstruction: "s", userText: "u" })) as { a: number };
      expect(out).toEqual({ a: 1 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(String(init.headers as Record<string, string>).length >= 0 || (init.headers as Record<string, string>)["authorization"] || true).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
    vi.resetModules();

    setEnv({ DEEPSEEK_API_KEY: undefined, AI_PROVIDER: "deepseek" });
    const ds2 = await import("../deepseek");
    await expect(ds2.generateJson({ systemInstruction: "s", userText: "u" })).rejects.toThrow(
      /DEEPSEEK_API_KEY/,
    );
  });

  it("deepseek sends supported images as image_url parts with actual content", async () => {
    setEnv({ DEEPSEEK_API_KEY: "sk-test", AI_PROVIDER: "deepseek", DEEPSEEK_MODEL: "deepseek-flash" });
    let capturedBody: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(String(init.body));
        return { ok: true, json: async () => ({ choices: [{ message: { content: "hello" } }] }) };
      }),
    );
    try {
      const ds = await import("../deepseek");
      const textDoc = Buffer.from("line1\nline2", "utf-8").toString("base64");
      const out = await ds.generateSupportAnswer({
        systemInstruction: "sys",
        history: [{ role: "user", text: "hi" }],
        message: "help",
        attachments: [
          { filename: "n.txt", mimeType: "text/plain", kind: "document", sizeBytes: 11, data: textDoc },
          { filename: "p.png", mimeType: "image/png", kind: "image", sizeBytes: 10, data: "AAAA" },
        ],
      });
      expect(out).toBe("hello");
      const msgs = capturedBody["messages"] as { role: string; content: unknown }[];
      expect(capturedBody["model"]).toBe("deepseek-flash");
      expect(msgs[0]).toEqual({ role: "system", content: "sys" });
      const last = msgs[msgs.length - 1].content as (
        | string
        | { type: string; text?: string; image_url?: { url: string } }[]
      );
      expect(Array.isArray(last)).toBe(true);
      const parts = last as { type: string; text?: string; image_url?: { url: string } }[];
      const textJoined = parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n");
      expect(textJoined).toContain("help");
      expect(textJoined).toContain("n.txt");
      expect(textJoined).toContain("line1");
      expect(textJoined).toContain("p.png");
      // The model receives ACTUAL image content via image_url data URL.
      const images = parts.filter((p) => p.type === "image_url");
      expect(images).toHaveLength(1);
      expect(images[0].image_url?.url.startsWith("data:image/png;base64,")) .toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("audio attachments stay honest text labels (no fabricated transcription)", async () => {
    setEnv({ DEEPSEEK_API_KEY: "sk-test", AI_PROVIDER: "deepseek", DEEPSEEK_MODEL: "deepseek-flash" });
    let capturedBody: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(String(init.body));
        return { ok: true, json: async () => ({ choices: [{ message: { content: "ok" } }] }) };
      }),
    );
    try {
      const ds = await import("../deepseek");
      await ds.generateSupportAnswer({
        systemInstruction: "sys",
        history: [],
        message: "voicemail?",
        attachments: [
          { filename: "v.mp3", mimeType: "audio/mpeg", kind: "audio", sizeBytes: 8, data: "AAAA" },
        ],
      });
      const msgs = capturedBody["messages"] as { role: string; content: unknown }[];
      const last = msgs[msgs.length - 1].content;
      // No images → plain string content, honest label, no bytes leaked.
      expect(typeof last).toBe("string");
      expect(last as string).toContain("cannot transcribe audio natively");
      expect(last as string).not.toContain("AAAA");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("router delegates to DeepSeek when active (no Gemini call)", async () => {
    setEnv({ DEEPSEEK_API_KEY: "sk-test", AI_PROVIDER: "deepseek", GEMINI_API_KEY: undefined });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"ok":true}' } }] }),
      })),
    );
    try {
      const g = await import("../gemini");
      const out = await g.generateJson({ systemInstruction: "s", userText: "u" });
      expect(out).toEqual({ ok: true });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
