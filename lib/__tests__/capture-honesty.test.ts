import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

vi.mock("@/lib/product-identity", () => ({
  resolveProductIdentity: async () => ({
    workspaceId: "ws-1",
    customerId: "cust-1",
    authUserId: "u-1",
    privateNamespace: "p-ns-1",
    sharedNamespace: "s-ns-1",
    workspace: { slug: "acme", name: "Acme", productName: null },
  }),
  identityError: (e: unknown) => ({ message: e instanceof Error ? e.message : "x", status: 401 }),
}));

const genMock = vi.fn();
vi.mock("@/lib/gemini", () => ({ generateJson: (...a: unknown[]) => genMock(...a) }));

const rememberMock = vi.fn();
vi.mock("@/lib/walrus", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return { ...orig, rememberPrivate: (...a: unknown[]) => rememberMock(...a) };
});

vi.mock("@/lib/env", () => ({ isWalrusConfigured: () => true }));
vi.mock("@/lib/identity", () => ({ previewUserId: () => "preview" }));

import { POST } from "@/app/api/memory/capture/route";
import { buildSystemInstruction, NO_MEMORY_SYSTEM_INSTRUCTION } from "../chat-memory";
import { validateExtractedFacts } from "../support-memory";

const turn = (over: Record<string, unknown> = {}) => ({
  workspaceSlug: "acme",
  message: "My checkout fails every time I pay with a card in this workspace please help.",
  answer: "Try a different card.",
  history: [],
  knownTexts: [],
  ...over,
});
const req = (body: unknown) =>
  new Request("http://x/api/memory/capture", { method: "POST", body: JSON.stringify(body) });

beforeEach(() => {
  genMock.mockReset();
  rememberMock.mockReset();
});

describe("capture honesty: stored only with a real blobId", () => {
  it("failed storage never appears as saved and carries no blobId", async () => {
    genMock.mockResolvedValue([{ type: "PROFILE", text: "Customer uses Excel 2021 on Windows daily" }]);
    rememberMock.mockRejectedValueOnce(Object.assign(new Error("Walrus relayer unavailable (status 500)"), { status: 500 }));
    const data = await (await POST(req(turn()))).json();
    expect(data.ok).toBe(true);
    expect(data.facts).toHaveLength(1);
    expect(data.facts[0].status).toBe("failed");
    expect(data.facts[0].blobId).toBeUndefined();
    expect(data.facts[0].errorKind).toBe("unavailable");
  });

  it("duplicate facts in one extraction batch cause a single write", async () => {
    genMock.mockResolvedValue([
      { type: "PROFILE", text: "Customer uses Excel 2021 on Windows daily" },
      { type: "PROFILE", text: "customer  uses  EXCEL 2021 on windows daily" },
    ]);
    rememberMock.mockResolvedValue({ blobId: "b-1", jobId: "j-1", namespace: "p-ns-1", owner: "o" });
    const data = await (await POST(req(turn()))).json();
    expect(data.facts).toHaveLength(1);
    expect(data.facts[0]).toMatchObject({ status: "stored", blobId: "b-1" });
    expect(rememberMock).toHaveBeenCalledTimes(1);
  });

  it("two distinct facts are each attempted once (no duplicate requests)", async () => {
    genMock.mockResolvedValue([
      { type: "PROFILE", text: "Customer uses Excel 2021 on Windows daily for reports" },
      { type: "ISSUE", text: "CSV import returns HTTP 422 every time they upload a file" },
    ]);
    rememberMock.mockRejectedValue(Object.assign(new Error("relayer down"), { status: 503 }));
    const data = await (await POST(req(turn()))).json();
    expect(data.facts).toHaveLength(2);
    expect(rememberMock).toHaveBeenCalledTimes(2);
    for (const f of data.facts) {
      expect(f.status).toBe("failed");
      expect(f.blobId).toBeUndefined();
    }
    const texts = rememberMock.mock.calls.map((c) => c[1]);
    expect(new Set(texts).size).toBe(2);
  });
});

describe("assistant never promises durable memory", () => {
  it("memory-grounded prompt forbids save promises", () => {
    const s = buildSystemInstruction([
      { plane: "private", text: "Uses Excel", distance: 0.2, blobId: "b1" },
    ]);
    expect(s).toMatch(/never promise to remember|never.*promise.*save/i);
  });

  it("no-memory baseline forbids save promises", () => {
    expect(NO_MEMORY_SYSTEM_INSTRUCTION).toMatch(/never promise to remember|never.*promise.*save/i);
  });

  it("extraction validation collapses in-batch duplicates (pure)", () => {
    const out = validateExtractedFacts([
      { type: "PROFILE", text: "Uses Excel 2021 on Windows daily" },
      { type: "profile", text: "uses  excel 2021 on WINDOWS daily" },
    ]);
    expect(out).toHaveLength(1);
  });
});
