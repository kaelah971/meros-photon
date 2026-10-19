"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { parseBlocks, type BlockNode, type InlineNode } from "@/lib/markdown";
import { recordEvidence, shortBlob } from "@/lib/evidence";
import { authClient } from "@/lib/better-auth-client";
import { captureNoteForResult } from "@/lib/capture-status";
import { CUSTOMER_SIGN_OUT_ERROR, signOutCustomerSession } from "@/lib/customer-signout";
import { PageBackdrop } from "@/components/meros-ui";
import {
  MAX_ATTACHMENTS,
  MAX_RECORD_SECONDS,
  formatBytes,
  validateAttachment,
  type AttachmentKind,
} from "@/lib/attachments";

type ProvenanceItem = {
  plane: "private" | "shared" | "knowledge";
  text: string;
  blobId: string;
  distance: number;
};

/** A file picked (or recorded) but not yet sent. Raw bytes stay in memory
 *  only until a successful send; only metadata ever reaches the server DB. */
interface PendingAttachment {
  id: string;
  filename: string;
  mimeType: string;
  kind: AttachmentKind;
  sizeBytes: number;
  data: string;
  thumbnailUrl?: string;
  durationSec?: number;
}

type Msg =
  | { kind: "user"; text: string; attachments?: { filename: string; kind: AttachmentKind }[] }
  | {
      kind: "assistant";
      text: string;
      /** Staff-authored replies render with a Meros team badge, never as AI output. */
      author?: "ai" | "staff";
      provenance: ProvenanceItem[];
      memoryUsed: { private: boolean; shared: boolean; knowledge?: boolean };
      historyTurns: number;
      captureNote?: string;
      degradedMemory?: boolean;
      attachmentNote?: string | null;
      historySnapshot: { role: "user" | "assistant"; text: string }[];
      compare?:
        | { status: "loading" }
        | { status: "done"; baseline: string }
        | { status: "failed"; error: string };
    };

function Inline({ nodes }: { nodes: InlineNode[] }) {
  return (
    <>
      {nodes.map((n, i) =>
        n.t === "bold" ? (
          <strong key={i} className="font-semibold text-neutral-50">{n.v}</strong>
        ) : n.t === "italic" ? (
          <em key={i}>{n.v}</em>
        ) : n.t === "code" ? (
          <code key={i} className="rounded bg-[#0a140f] px-1 py-0.5 font-mono text-[12px] text-[#9AFF8D]">{n.v}</code>
        ) : (
          <span key={i}>{n.v}</span>
        ),
      )}
    </>
  );
}

/** Safe minimal Markdown: headings, bold, italic, code, lists, paragraphs.
 *  All text renders as React nodes (auto-escaped) — raw HTML can never run. */
function Markdown({ text }: { text: string }) {
  const blocks: BlockNode[] = parseBlocks(text);
  return (
    <div className="space-y-2">
      {blocks.map((b, i) =>
        b.t === "heading" ? (
          b.level === 1 ? (
            <p key={i} className="text-base font-semibold text-neutral-50"><Inline nodes={b.inline} /></p>
          ) : b.level === 2 ? (
            <p key={i} className="text-sm font-semibold text-neutral-50"><Inline nodes={b.inline} /></p>
          ) : (
            <p key={i} className="text-sm font-medium text-neutral-100"><Inline nodes={b.inline} /></p>
          )
        ) : b.t === "ul" ? (
          <ul key={i} className="list-disc space-y-1 pl-5">
            {b.items.map((it, j) => (<li key={j}><Inline nodes={it} /></li>))}
          </ul>
        ) : b.t === "ol" ? (
          <ol key={i} className="list-decimal space-y-1 pl-5">
            {b.items.map((it, j) => (<li key={j}><Inline nodes={it} /></li>))}
          </ol>
        ) : (
          <p key={i}><Inline nodes={b.inline} /></p>
        ),
      )}
    </div>
  );
}

function MemoryLens({
  msg,
  historyTurns,
}: {
  msg: Extract<Msg, { kind: "assistant" }>;
  historyTurns: number;
}) {
  const [open, setOpen] = useState(false);
  const priv = msg.provenance.filter((p) => p.plane === "private");
  const shared = msg.provenance.filter((p) => p.plane === "shared");
  const know = msg.provenance.filter((p) => p.plane === "knowledge");
  const noneUsed = priv.length === 0 && shared.length === 0 && know.length === 0;
  return (
    <div className="mt-2 rounded-md border border-[rgba(119,255,117,0.14)] bg-[#06100B]/60">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-left text-xs text-neutral-400 hover:text-neutral-200"
      >
        <span>
          <span className="font-medium text-neutral-300">Why this answer?</span>
          <span className="ml-2">
            {noneUsed
              ? "No relevant memory found"
              : [
                  priv.length > 0 ? "Your private memory" : "",
                  shared.length > 0 ? "Shared support memory" : "",
                  know.length > 0 ? "Product knowledge" : "",
                ].filter(Boolean).join(" · ")}
          </span>
        </span>
        <span aria-hidden>{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-[rgba(119,255,117,0.14)] px-3 py-3 text-xs">
          <div>
            <p className="font-medium text-[#77FF75]">Your private memory</p>
            {priv.length === 0 ? (
              <p className="mt-1 text-neutral-500">Not used for this answer.</p>
            ) : (
              <ul className="mt-1 space-y-1.5">
                {priv.map((p) => (
                  <li key={p.blobId} className="text-neutral-300">
                    <span className="text-neutral-100">{p.text}</span>
                    <details className="mt-0.5">
                      <summary className="cursor-pointer font-mono text-[11px] text-neutral-500 hover:text-neutral-300">storage proof</summary>
                      <span className="block font-mono text-[11px] text-neutral-500">
                        blob {shortBlob(p.blobId)} · relevance {p.distance.toFixed(3)}
                      </span>
                    </details>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <p className="font-medium text-sky-400">Shared support memory</p>
            {shared.length === 0 ? (
              <p className="mt-1 text-neutral-500">Not used for this answer.</p>
            ) : (
              <ul className="mt-1 space-y-1.5">
                {shared.map((p) => (
                  <li key={p.blobId} className="text-neutral-300">
                    <span className="text-neutral-100">{p.text}</span>
                    <details className="mt-0.5">
                      <summary className="cursor-pointer font-mono text-[11px] text-neutral-500 hover:text-neutral-300">storage proof</summary>
                      <span className="block font-mono text-[11px] text-neutral-500">
                        blob {shortBlob(p.blobId)} · relevance {p.distance.toFixed(3)}
                      </span>
                    </details>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <p className="font-medium text-lime-300">Product knowledge</p>
            {know.length === 0 ? (
              <p className="mt-1 text-neutral-500">Not used for this answer.</p>
            ) : (
              <ul className="mt-1 space-y-1.5">
                {know.map((p) => (
                  <li key={p.blobId} className="text-neutral-300">
                    <span className="text-neutral-100">{p.text}</span>
                    <details className="mt-0.5">
                      <summary className="cursor-pointer font-mono text-[11px] text-neutral-500 hover:text-neutral-300">storage proof</summary>
                      <span className="block font-mono text-[11px] text-neutral-500">
                        blob {shortBlob(p.blobId)} · relevance {p.distance.toFixed(3)}
                      </span>
                    </details>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <p className="font-medium text-neutral-300">Current conversation</p>
            <p className="mt-1 text-neutral-500">
              {historyTurns > 0
                ? `This session's recent context (${historyTurns} turn${historyTurns === 1 ? "" : "s"}) shaped this answer alongside any memory above.`
                : "No earlier turns this session — answered from your message alone."}
            </p>
          </div>
          {noneUsed && (
            <p className="text-neutral-400">
              No relevant memory found. Meros is starting with the current conversation.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Side-by-side proof: original memory-influenced answer vs a fresh
 *  baseline generated with long-term memory deliberately disabled.
 *  The summary is built deterministically from the ORIGINAL provenance —
 *  Gemini is never asked to explain the difference. */
function CompareCard({
  original,
  baseline,
}: {
  original: Extract<Msg, { kind: "assistant" }>;
  baseline: string;
}) {
  const priv = original.provenance.filter((p) => p.plane === "private");
  const shared = original.provenance.filter((p) => p.plane === "shared");
  const know = original.provenance.filter((p) => p.plane === "knowledge");
  const used: string[] = [];
  if (priv.length > 0) used.push("private memory");
  if (shared.length > 0) used.push("shared support memory");
  if (know.length > 0) used.push("product knowledge");
  return (
    <div className="mt-2 overflow-hidden rounded-md border border-[rgba(119,255,117,0.25)]">
      <p className="bg-[rgba(10,27,18,0.9)] px-3 py-1.5 text-[11px] font-medium uppercase tracking-wider text-neutral-300">
        Memory on vs off — same question, same conversation context
      </p>
      <div className="grid gap-px bg-[#0a140f] sm:grid-cols-2">
        <div className="bg-[#06100B] p-3">
          <p className="text-[11px] font-semibold text-[#77FF75]">WITH MEROS MEMORY</p>
          <div className="mt-1.5 text-xs leading-5 text-neutral-200">
            <Markdown text={original.text} />
          </div>
        </div>
        <div className="bg-[#06100B] p-3">
          <p className="text-[11px] font-semibold text-neutral-400">WITHOUT MEMORY</p>
          <p className="mt-1 text-[11px] text-neutral-500">Fresh generation · no long-term memory consulted</p>
          <div className="mt-1.5 text-xs leading-5 text-neutral-200">
            <Markdown text={baseline} />
          </div>
        </div>
      </div>
      <div className="border-t border-[rgba(119,255,117,0.14)] bg-[#06100B] px-3 py-2 text-[11px] text-neutral-400">
        <p className="font-medium text-neutral-300">Why this mattered</p>
        <p className="mt-0.5">
          Private memory: {priv.length > 0 ? `used (${priv.length})` : "not used"} · Shared memory:{" "}
          {shared.length > 0 ? `used (${shared.length})` : "not used"} · Product knowledge:{" "}
          {know.length > 0 ? `used (${know.length})` : "not used"} · Baseline: no long-term memory.
        </p>
        {shared.length > 0 && (
          <ul className="mt-1 space-y-0.5">
            {shared.map((p) => (
              <li key={p.blobId}>
                Shared pattern “{p.text.length > 120 ? `${p.text.slice(0, 120)}…` : p.text}”
                <span className="font-mono text-neutral-500"> · blob {shortBlob(p.blobId)} · relevance {p.distance.toFixed(3)}</span>
              </li>
            ))}
          </ul>
        )}
        {priv.length > 0 && shared.length === 0 && (
          <p className="mt-0.5">Your private context shaped the answer above; the baseline started cold.</p>
        )}
        <p className="mt-0.5 text-neutral-500">
          Built from actual recall provenance ({used.length > 0 ? used.join(" + ") : "none"} influenced the original).
        </p>
      </div>
    </div>
  );
}

/** Explicit capture after the answer renders. Returns a short UI note. */
async function captureTurn(
  workspaceSlug: string,
  message: string,
  answer: string,
  history: { role: "user" | "assistant"; text: string }[],
  knownTexts: string[],
): Promise<string | null> {
  try {
    const res = await fetch("/api/memory/capture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceSlug, message, answer, history, knownTexts }),
    });
    const data = await res.json();
    // Endpoint-level ok:false means no Walrus write was attempted
    // (identity/extraction/transport failure upstream). Stay silent rather
    // than implying a failed save.
    if (!data.ok) return null;
    const facts = (data.facts ?? []) as { status: string; text?: string; blobId?: string }[];
    for (const f of facts) {
      if (f.status === "stored" && f.blobId) {
        recordEvidence({ kind: "private-write", workspace: workspaceSlug, text: f.text ?? "", blobId: f.blobId, status: "stored" });
      }
    }
    return captureNoteForResult(data);
  } catch {
    return null;
  }
}

// NOTE: the customer-facing FixCard approval UI (Save shared / Keep
// private) was removed in P8. Customers only ever see the pending-review
// receipt rendered inline above; organization staff review in the console.

export function SupportChat({
  initialWorkspaceSlug = "",
  initialWorkspaceName = "",
  lockWorkspace = false,
  sessionEmail = null,
}: {
  initialWorkspaceSlug?: string;
  initialWorkspaceName?: string;
  lockWorkspace?: boolean;
  /** Present on the real product route: Better Auth session identity. */
  sessionEmail?: string | null;
} = {}) {
  // Product identity is the Better Auth session. No access codes anywhere:
  // the dev console additionally requires the server-side dev flag.
  const isAuth = sessionEmail != null && sessionEmail !== "";
  const [workspaceSlug, setWorkspaceSlug] = useState(initialWorkspaceSlug);
  const [workspaceName, setWorkspaceName] = useState(initialWorkspaceName);
  const [started, setStarted] = useState(isAuth);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [conversationId, setConversationId] = useState<string | null>(null);
  // Failed-turn keys: preserved so "Retry answer" reuses the ORIGINAL
  // conversation + idempotency keys instead of duplicating the question.
  const [failedTurn, setFailedTurn] = useState<{
    text: string;
    clientMessageId: string;
    answerClientId: string;
    conversationId: string | null;
  } | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [resolvedCard, setResolvedCard] = useState<{ candidateText?: string } | null>(null);
  const [resolving, setResolving] = useState(false);
  const [historyList, setHistoryList] = useState<
    { id: string; title: string; status: string; lastMessageAt: string | null }[] | null
  >(null);
  const [showHistory, setShowHistory] = useState(false);
  const [historyFilter, setHistoryFilter] = useState("");
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [recordingSec, setRecordingSec] = useState<number | null>(null);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const signOutInFlightRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordChunksRef = useRef<Blob[]>([]);
  const recordStartedAtRef = useRef<number>(0);
  const bottomRef = useRef<HTMLDivElement>(null);

  const scrollDown = () => {
    requestAnimationFrame(() =>
      bottomRef.current?.scrollIntoView({ behavior: "smooth" }),
    );
  };


  const canStart = workspaceSlug.trim().length >= 2;

  // Identity envelope: workspace route context only. Access codes are never
  // sent — session auth (product) or nothing (dev console, server-gated).
  const identityBody = (extra: Record<string, unknown>) => ({ workspaceSlug, ...extra });

  const readFileData = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const url = typeof reader.result === "string" ? reader.result : "";
        const comma = url.indexOf(",");
        if (comma < 0) reject(new Error("Could not read file."));
        else resolve(url.slice(comma + 1));
      };
      reader.onerror = () => reject(new Error("Could not read file."));
      reader.readAsDataURL(file);
    });

  const removePending = useCallback((id: string) => {
    setPending((prev) => {
      const found = prev.find((p) => p.id === id);
      if (found?.thumbnailUrl) URL.revokeObjectURL(found.thumbnailUrl);
      return prev.filter((p) => p.id !== id);
    });
    setAttachError(null);
  }, []);

  const clearPending = useCallback(() => {
    setPending((prev) => {
      for (const p of prev) if (p.thumbnailUrl) URL.revokeObjectURL(p.thumbnailUrl);
      return [];
    });
  }, []);

  const pickFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files);
      if (list.length === 0) return;
      setAttachError(null);
      if (pending.length + list.length > MAX_ATTACHMENTS) {
        setAttachError(`At most ${MAX_ATTACHMENTS} attachments per message.`);
        return;
      }
      for (const file of list) {
        const checked = validateAttachment({
          filename: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
        });
        if (!checked.ok) {
          setAttachError(checked.error);
          return;
        }
        try {
          const data = await readFileData(file);
          const a = checked.attachment;
          const entry: PendingAttachment = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            filename: a.filename,
            mimeType: a.mimeType,
            kind: a.kind,
            sizeBytes: a.sizeBytes,
            data,
            thumbnailUrl: a.kind === "image" ? URL.createObjectURL(file) : undefined,
          };
          setPending((prev) => [...prev, entry]);
        } catch {
          setAttachError(`Could not read “${file.name}”.`);
          return;
        }
      }
    },
    [pending.length],
  );

  const stopRecorderTracks = useCallback(() => {
    if (recordTimerRef.current) {
      clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    recorderRef.current = null;
    if (streamRef.current) {
      for (const t of streamRef.current.getTracks()) t.stop();
      streamRef.current = null;
    }
    setRecordingSec(null);
  }, []);

  const cancelRecording = useCallback(() => {
    try {
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        recorderRef.current.ondataavailable = null;
        recorderRef.current.onstop = null;
        recorderRef.current.stop();
      }
    } catch {
      // Discard silently — cancel means “forget this recording”.
    }
    recordChunksRef.current = [];
    stopRecorderTracks();
  }, [stopRecorderTracks]);

  const finishRecording = useCallback(() => {
    const rec = recorderRef.current;
    if (!rec) return;
    const secs = Math.max(1, Math.round((Date.now() - recordStartedAtRef.current) / 1000));
    rec.onstop = () => {
      const blob = new Blob(recordChunksRef.current, { type: rec.mimeType || "audio/webm" });
      recordChunksRef.current = [];
      stopRecorderTracks();
      const filename = `voice-message-${new Date().toISOString().replace(/[:.]/g, "-")}.${
        blob.type.includes("mp4") ? "mp4" : blob.type.includes("ogg") ? "ogg" : blob.type.includes("wav") ? "wav" : "webm"
      }`;
      const checked = validateAttachment({ filename, mimeType: blob.type || "audio/webm", sizeBytes: blob.size });
      if (!checked.ok) {
        setAttachError(checked.error);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const url = typeof reader.result === "string" ? reader.result : "";
        const comma = url.indexOf(",");
        if (comma < 0) {
          setAttachError("Could not read the recording.");
          return;
        }
        const a = checked.attachment;
        setPending((prev) => [
          ...prev,
          {
            id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            filename: a.filename,
            mimeType: a.mimeType,
            kind: a.kind,
            sizeBytes: a.sizeBytes,
            data: url.slice(comma + 1),
            durationSec: secs,
          },
        ]);
        setAttachError(null);
      };
      reader.onerror = () => setAttachError("Could not read the recording.");
      reader.readAsDataURL(blob);
    };
    try {
      rec.stop();
    } catch {
      setAttachError("Could not finish the recording.");
      stopRecorderTracks();
    }
  }, [stopRecorderTracks]);

  const startRecording = useCallback(async () => {
    setAttachError(null);
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setAttachError("Voice messages aren’t supported in this browser. Try Chrome or Edge on desktop.");
      return;
    }
    if (pending.length >= MAX_ATTACHMENTS) {
      setAttachError(`At most ${MAX_ATTACHMENTS} attachments per message.`);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      recordChunksRef.current = [];
      const mimeType = ["audio/webm", "audio/mp4", "audio/ogg", "audio/wav"].find((m) =>
        MediaRecorder.isTypeSupported(m),
      );
      const rec = mimeType
        ? new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 32000 })
        : new MediaRecorder(stream, { audioBitsPerSecond: 32000 });
      recorderRef.current = rec;
      recordStartedAtRef.current = Date.now();
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) recordChunksRef.current.push(e.data);
        const elapsed = Math.floor((Date.now() - recordStartedAtRef.current) / 1000);
        if (elapsed >= MAX_RECORD_SECONDS) finishRecording();
      };
      rec.start(1000);
      setRecordingSec(0);
      recordTimerRef.current = setInterval(() => {
        setRecordingSec(Math.floor((Date.now() - recordStartedAtRef.current) / 1000));
      }, 500);
    } catch (e) {
      const name = e instanceof Error ? e.name : "";
      setAttachError(
        name === "NotAllowedError"
          ? "Microphone access was denied. Allow microphone use in your browser to send voice messages."
          : name === "NotFoundError"
            ? "No microphone was found on this device."
            : "Could not start recording. Check your microphone and try again.",
      );
      stopRecorderTracks();
    }
  }, [pending.length, finishRecording, stopRecorderTracks]);

  // Stop tracks if the component unmounts mid-recording.
  useEffect(
    () => () => {
      if (recordTimerRef.current) clearInterval(recordTimerRef.current);
      if (streamRef.current) for (const t of streamRef.current.getTracks()) t.stop();
    },
    [],
  );

  const send = useCallback(async () => {
    const text = draft.trim();
    const outgoing = pending;
    if ((!text && outgoing.length === 0) || sending || !workspaceSlug.trim()) return;
    setSending(true);
    setError("");
    setResolvedCard(null);
    const history = messages.flatMap((m): { role: "user" | "assistant"; text: string }[] =>
      m.kind === "user"
        ? [{ role: "user", text: m.text }]
        : [{ role: "assistant", text: m.text }],
    );
    // Idempotency keys for this turn: a retried send resumes the same
    // persisted user message AND the same assistant reply instead of
    // duplicating either. Both survive failures via failedTurn below.
    const newId = () =>
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const clientMessageId = newId();
    const answerClientId = newId();
    setFailedTurn({ text, clientMessageId, answerClientId, conversationId });
    const outgoingMetas = outgoing.map((a) => ({ filename: a.filename, kind: a.kind }));
    setMessages((prev) => [...prev, { kind: "user", text, attachments: outgoingMetas }]);
    setDraft("");
    scrollDown();
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          identityBody({
            message: text,
            history,
            conversationId,
            clientMessageId,
            answerClientId,
            attachments: outgoing.map((a) => ({
              filename: a.filename,
              mimeType: a.mimeType,
              kind: a.kind,
              data: a.data,
            })),
          }),
        ),
      });
      const data = await res.json();
      if (!data.ok) {
        // The question is already persisted server-side: keep the turn keys
        // and adopt the server's conversation id so Retry reuses them.
        if (typeof data.conversationId === "string" && data.conversationId) {
          setConversationId(data.conversationId);
          setFailedTurn((prev) => (prev ? { ...prev, conversationId: data.conversationId } : prev));
        }
        setError(data.error ?? "Something went wrong. Try again.");
        return;
      }
      setFailedTurn(null);
      // Clear pending attachments only after a successful send.
      clearPending();
      const assistantIdx = messages.length + 1;
      const knownTexts: string[] = (data.provenance ?? []).map((p: ProvenanceItem) => p.text);
      setMessages((prev) => [
        ...prev,
        {
          kind: "assistant",
          text: data.answer,
          provenance: data.provenance ?? [],
          memoryUsed: data.memoryUsed ?? { private: false, shared: false },
          historyTurns: data.historyTurns ?? history.length,
          degradedMemory: data.degradedMemory === true,
          historySnapshot: history,
          attachmentNote:
            Array.isArray(data.attachments) && data.attachments.length > 0
              ? (data.attachments as { filename: string; kind: string }[])
                  .map((a) => a.filename)
                  .join(", ")
              : null,
        },
      ]);
      scrollDown();
      if (data.conversation?.id) {
        if (!conversationId || conversationId !== data.conversation.id) {
          setConversationId(data.conversation.id);
          void loadHistoryList();
        }
      }
      // Resolution confirmed: the fix (if any) is already pending staff
      // review server-side. The customer only gets this receipt — never
      // shared-memory controls.
      if (data.resolutionDetected === true) {
        setResolvedCard({
          candidateText: data.fixCard?.candidateText,
        });
      }
      // Explicit capture runs AFTER the answer renders (non-blocking for
      // chat latency). The capture endpoint still awaits real Walrus
      // completion per fact and reports honest per-fact status.
      if (data.workspace?.name) setWorkspaceName(data.workspace.name);
      void captureTurn(workspaceSlug, text, data.answer, history, knownTexts).then((note) => {
        if (!note) return;
        setMessages((prev) =>
          prev.map((m, idx) =>
            idx === assistantIdx && m.kind === "assistant" ? { ...m, captureNote: note } : m,
          ),
        );
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error. Try again.");
    } finally {
      setSending(false);
    }
  }, [draft, sending, workspaceSlug, messages, conversationId, identityBody, pending, clearPending]);

  // Retry ONLY the failed generation: same conversation, same keys, no new
  // user bubble (it's already shown + persisted). The server resumes an
  // already-stored reply when the first attempt ambiguously succeeded.
  const retryAnswer = useCallback(async () => {
    const turn = failedTurn;
    if (!turn || sending || retrying || !workspaceSlug.trim()) return;
    setRetrying(true);
    setError("");
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          identityBody({
            message: turn.text,
            history: [],
            conversationId: turn.conversationId,
            clientMessageId: turn.clientMessageId,
            answerClientId: turn.answerClientId,
            attachments: [],
          }),
        ),
      });
      const data = await res.json();
      if (!data.ok) {
        if (typeof data.conversationId === "string" && data.conversationId) {
          setConversationId(data.conversationId);
          setFailedTurn((prev) => (prev ? { ...prev, conversationId: data.conversationId } : prev));
        }
        setError(data.error ?? "Something went wrong. Try again.");
        return;
      }
      setFailedTurn(null);
      clearPending();
      const assistantIdx = messages.length;
      setMessages((prev) => [
        ...prev,
        {
          kind: "assistant",
          text: data.answer,
          provenance: data.provenance ?? [],
          memoryUsed: data.memoryUsed ?? { private: false, shared: false },
          historyTurns: data.historyTurns ?? 0,
          degradedMemory: data.degradedMemory === true,
          historySnapshot: [],
          attachmentNote: null,
        },
      ]);
      scrollDown();
      if (data.conversation?.id) setConversationId(data.conversation.id);
      if (data.workspace?.name) setWorkspaceName(data.workspace.name);
      void captureTurn(workspaceSlug, turn.text, data.answer, [], []).then((note) => {
        if (!note) return;
        setMessages((prev) =>
          prev.map((m, idx) =>
            idx === assistantIdx && m.kind === "assistant" ? { ...m, captureNote: note } : m,
          ),
        );
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error. Try again.");
    } finally {
      setRetrying(false);
    }
  }, [failedTurn, sending, retrying, workspaceSlug, messages.length, identityBody, clearPending, captureTurn]);

  const runCompare = useCallback(async (idx: number) => {
    // Controlled rerun: same user message + same conversation context, but
    // the server deliberately skips ALL Walrus recall. Never a new chat
    // turn (original proof untouched), never captured, never promoted.
    const current = messages[idx];
    const prev = messages[idx - 1];
    if (!current || current.kind !== "assistant" || !prev || prev.kind !== "user") return;
    setMessages((p) =>
      p.map((m, i) => (i === idx && m.kind === "assistant" ? { ...m, compare: { status: "loading" } } : m)),
    );
    try {
      const res = await fetch("/api/compare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(identityBody({ message: prev.text, history: current.historySnapshot })),
      });
      const data = await res.json();
      if (!data.ok) {
        setMessages((p) =>
          p.map((m, i) =>
            i === idx && m.kind === "assistant"
              ? { ...m, compare: { status: "failed", error: data.error ?? "Baseline failed." } }
              : m,
          ),
        );
        return;
      }
      recordEvidence({
        kind: "compare",
        workspace: workspaceSlug,
        question: prev.text.length > 140 ? `${prev.text.slice(0, 140)}…` : prev.text,
        privateUsed: current.memoryUsed.private,
        sharedUsed: current.memoryUsed.shared,
        snippets: current.provenance.map((p) => ({
          plane: p.plane,
          text: p.text,
          blobId: p.blobId,
          distance: p.distance,
        })),
        baselineChars: (data.answer as string).length,
      });
      setMessages((p) =>
        p.map((m, i) =>
          i === idx && m.kind === "assistant" ? { ...m, compare: { status: "done", baseline: data.answer } } : m,
        ),
      );
      scrollDown();
    } catch (e) {
      setMessages((p) =>
        p.map((m, i) =>
          i === idx && m.kind === "assistant"
            ? { ...m, compare: { status: "failed", error: e instanceof Error ? e.message : "Network error." } }
            : m,
        ),
      );
    }
  }, [messages, workspaceSlug, identityBody]);

  const newConversation = useCallback(() => {
    // Same user, fresh persistent thread (created server-side on next
    // send). Long-term memory stays in Walrus under the same
    // server-derived namespace — cross-session proof must come from
    // recall, never from this local transcript.
    setMessages([]);
    setError("");
    setDraft("");
    setConversationId(null);
    setResolvedCard(null);
  }, []);

  // Explicit customer resolution for the CURRENT persistent thread.
  const markResolved = useCallback(async () => {
    if (!conversationId || resolving) return;
    setResolving(true);
    setError("");
    try {
      const res = await fetch(`/api/conversations/${conversationId}/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(identityBody({})),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error ?? "Could not mark resolved.");
        return;
      }
      setResolvedCard({ candidateText: data.fixCard?.candidateText });
      scrollDown();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error.");
    } finally {
      setResolving(false);
    }
  }, [conversationId, resolving, identityBody]);

  // Sidebar needs sessions on mount; drawer lazy-loads on open.
  useEffect(() => {
    if (started && historyList === null) void loadHistoryList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started]);

  const loadHistoryList = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/conversations?workspaceSlug=${encodeURIComponent(workspaceSlug)}`,
      );
      const data = await res.json();
      if (data.ok) setHistoryList(data.conversations ?? []);
    } catch {
      // History is a convenience; chat works without it.
    }
  }, [workspaceSlug]);

  const openConversation = useCallback(
    async (id: string) => {
      setError("");
      try {
        const res = await fetch(
          `/api/conversations/${id}?workspaceSlug=${encodeURIComponent(workspaceSlug)}`,
        );
        const data = await res.json();
        if (!data.ok) {
          setError(data.error ?? "Could not load conversation.");
          return;
        }
        const turns: { role: "user" | "assistant"; text: string }[] = [];
        const loaded: Msg[] = (data.messages ?? []).map(
          (m: {
            role: string;
            text: string;
            author?: string;
            memoryUsed?: { private: boolean; shared: boolean; knowledge?: boolean };
            provenance?: ProvenanceItem[];
          }) => {
            const prior = turns.map((t) => ({ ...t }));
            turns.push({
              role: m.role === "assistant" ? "assistant" : "user",
              text: m.text,
            });
            if (m.role !== "assistant") return { kind: "user", text: m.text } as Msg;
            return {
              kind: "assistant",
              text: m.text,
              author: m.author === "staff" ? "staff" : "ai",
              provenance: m.provenance ?? [],
              memoryUsed: m.memoryUsed ?? { private: false, shared: false },
              historyTurns: prior.length,
              historySnapshot: prior,
            } as Msg;
          },
        );
        setConversationId(data.conversation.id);
        setMessages(loaded);
        setResolvedCard(
          data.conversation.status === "resolved" ? {} : null,
        );
        setShowHistory(false);
        scrollDown();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Network error.");
      }
    },
    [workspaceSlug],
  );

  // Product sign-out: Better Auth clears the session server-side. Only after
  // Better Auth confirms success do we reload the same support route so the
  // server gate re-evaluates auth and renders the customer sign-in screen.
  const signOutHere = useCallback(async () => {
    if (signOutInFlightRef.current) return;
    signOutInFlightRef.current = true;
    setSigningOut(true);
    setSignOutError(null);
    const result = await signOutCustomerSession({
      signOut: () => authClient.signOut(),
      refreshCurrentRoute: () => window.location.reload(),
    });
    if (!result.ok) {
      setSignOutError(CUSTOMER_SIGN_OUT_ERROR);
      signOutInFlightRef.current = false;
      setSigningOut(false);
    }
  }, []);

  const switchWorkspace = useCallback(() => {
    // Full reset: drop thread, identity, AND workspace. Back to the full
    // temporary gate. Walrus memories are untouched (server-side).
    // Locked (product-route) mode has no workspace to switch: keep the slug.
    setMessages([]);
    setError("");
    setDraft("");
    if (!lockWorkspace) {
      setWorkspaceSlug("");
      setWorkspaceName("");
    }
    setStarted(false);
  }, [lockWorkspace]);

  if (!started) {
    return (
      <main className="relative mx-auto max-w-xl px-6 py-16">
        <PageBackdrop />
        <p className="font-display relative text-[11px] tracking-[0.3em] text-[#4CA862]">
          MEROS · SUPPORT MEMORY THAT COMPOUNDS
        </p>
        <h1 className="mt-3 text-3xl font-semibold">Solve it once. Remember it for everyone.</h1>
        <p className="mt-4 text-sm leading-6 text-neutral-300">
          Enter your workspace to pick up your private support memory.
          Memory never crosses workspace boundaries.
        </p>
        <p className="mt-2 inline-block rounded border border-amber-800 bg-amber-950/40 px-2 py-1 text-[11px] text-amber-300">
          Development diagnostic console — disabled in production. Sign-in is still required.
        </p>
        <div className="mt-6 space-y-2">
          {lockWorkspace ? (
            <p className="rounded-md border border-[rgba(119,255,117,0.14)] bg-[rgba(10,27,18,0.72)] px-3 py-2.5 text-sm text-neutral-200">
              {workspaceName ? `${workspaceName} Support` : workspaceSlug}
            </p>
          ) : (
            <label className="block text-xs text-neutral-400">
              Workspace
              <input
                value={workspaceSlug}
                onChange={(e) => setWorkspaceSlug(e.target.value)}
                aria-label="Workspace slug"
                placeholder="e.g. acme"
                autoComplete="off"
                className="mt-1 w-full rounded-md border border-[rgba(119,255,117,0.25)] bg-[rgba(10,27,18,0.72)] px-3 py-2.5 text-sm outline-none placeholder:text-neutral-600 focus:border-[#77FF75]"
              />
            </label>
          )}
          <button
            onClick={() => canStart && setStarted(true)}
            disabled={!canStart}
            className="w-full rounded-md bg-[#77FF75] px-5 py-2.5 text-sm font-medium text-[#030806] disabled:opacity-40 hover:bg-[#9AFF8D]"
          >
            Continue
          </button>
        </div>
        <p className="mt-3 text-xs text-neutral-500">
          New workspaces pick up no memory yet — memory accrues from real conversations.
        </p>
      </main>
    );
  }

  const visibleHistory = (historyList ?? []).filter((c) =>
    c.title.toLowerCase().includes(historyFilter.trim().toLowerCase()),
  );

  const historyPanel = (
    <div>
      <div className="flex items-center justify-between gap-2">
        <p className="font-display text-[11px] tracking-[0.25em] text-[#4CA862]">SESSIONS</p>
        <button
          onClick={newConversation}
          title="Start a new conversation thread"
          className="rounded-md bg-[#77FF75] px-3 py-1.5 text-xs font-medium text-neutral-950 hover:bg-emerald-400"
        >
          + New
        </button>
      </div>
      <input
        value={historyFilter}
        onChange={(e) => setHistoryFilter(e.target.value)}
        placeholder="Filter conversations…"
        aria-label="Filter conversations"
        className="mt-2 w-full rounded-md border border-[rgba(119,255,117,0.25)] bg-[#06100B] px-3 py-2 text-xs outline-none placeholder:text-neutral-600 focus:border-[#77FF75]"
      />
      <div className="mt-2">
        <p className="text-xs font-medium text-neutral-200">Previous conversations</p>
        {historyList === null ? (
          <p className="mt-1 text-[11px] text-neutral-500">Loading…</p>
        ) : visibleHistory.length === 0 ? (
          <p className="mt-1 text-[11px] text-neutral-500">
            {historyList.length === 0 ? "No previous conversations yet." : "No matches."}
          </p>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {visibleHistory.map((c) => (
              <li key={c.id}>
                <button
                  onClick={() => {
                    void openConversation(c.id);
                    setShowHistory(false);
                  }}
                  aria-current={c.id === conversationId ? "true" : undefined}
                  className={`w-full rounded-md border px-3 py-2 text-left ${
                    c.id === conversationId
                      ? "border-[rgba(119,255,117,0.5)] bg-[rgba(119,255,117,0.08)]"
                      : "border-[rgba(119,255,117,0.14)] bg-[#06100B] hover:border-[rgba(119,255,117,0.5)]"
                  }`}
                >
                  <span className="block truncate text-xs text-neutral-100">{c.title}</span>
                  <span className="mt-0.5 block font-mono text-[10px] text-neutral-500">
                    {c.status}{c.lastMessageAt ? ` · ${new Date(c.lastMessageAt).toLocaleString()}` : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="mt-3 border-t border-[rgba(119,255,117,0.14)] pt-3">
        <p className="truncate text-[11px] text-neutral-500">
          {isAuth && sessionEmail ? `Signed in as ${sessionEmail}` : "Customer session"}
        </p>
        {isAuth && (
          <button
            onClick={() => void signOutHere()}
            disabled={signingOut}
            className="mt-2 w-full rounded-md border border-[rgba(119,255,117,0.25)] px-3 py-1.5 text-xs text-neutral-300 hover:border-[rgba(119,255,117,0.5)] disabled:opacity-40"
          >
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        )}
      </div>
    </div>
  );

  return (
    <main className="relative mx-auto flex min-h-screen w-full max-w-6xl flex-col px-4 py-6 md:flex-row md:gap-6">
      <PageBackdrop />
      <aside className="mb-4 hidden w-72 shrink-0 md:mb-0 md:block" aria-label="Conversation sessions">
        <p className="truncate text-sm text-neutral-300">{workspaceName ? `${workspaceName} Support` : "Support"}</p>
        <div className="mt-3">{historyPanel}</div>
      </aside>
      {showHistory && (
        <div className="fixed inset-0 z-30 md:hidden" role="dialog" aria-modal="true" aria-label="Conversation sessions">
          <div className="absolute inset-0 bg-black/70" onClick={() => setShowHistory(false)} />
          <div className="absolute inset-y-0 left-0 w-80 max-w-[85vw] overflow-y-auto border-r border-[rgba(119,255,117,0.2)] bg-[#06100B] p-4">
            <div className="mb-3 flex items-center justify-between">
              <p className="truncate text-sm text-neutral-300">{workspaceName ? `${workspaceName} Support` : "Support"}</p>
              <button
                onClick={() => setShowHistory(false)}
                aria-label="Close conversation list"
                className="rounded-md border border-[rgba(119,255,117,0.25)] px-2.5 py-1.5 text-xs text-neutral-300"
              >
                ✕
              </button>
            </div>
            {historyPanel}
          </div>
        </div>
      )}
      <div className="min-w-0 flex-1">
      <header className="relative flex flex-wrap items-center justify-between gap-3 border-b border-[rgba(119,255,117,0.14)] pb-3">
        <div className="min-w-0">
          <p className="font-display text-sm font-bold tracking-[0.18em] text-[#9AFF8D]">MEROS</p>
          <p className="mt-0.5 truncate text-sm text-neutral-300">{workspaceName ? `${workspaceName} Support` : "Support chat with memory"}</p>
          <p className="truncate text-[11px] text-neutral-500">
            {isAuth && sessionEmail ? `Signed in as ${sessionEmail}` : "Customer session"} · {workspaceSlug}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => {
              setShowHistory(true);
              if (historyList === null) void loadHistoryList();
            }}
            title="Your previous support conversations"
            aria-label="Open conversation list"
            className="rounded-md border border-[rgba(119,255,117,0.25)] px-3 py-1.5 text-xs text-neutral-300 hover:border-[rgba(119,255,117,0.5)] md:hidden"
          >
            ☰ Sessions
          </button>
          <button
            onClick={newConversation}
            title="Same user, fresh thread (your memories stay)"
            className="rounded-md border border-[rgba(119,255,117,0.25)] px-3 py-1.5 text-xs text-neutral-300 hover:border-[rgba(119,255,117,0.5)]"
          >
            New conversation
          </button>
          {isAuth && (
            <button
              onClick={() => void signOutHere()}
              disabled={signingOut}
              title="Sign out and return to this workspace's sign-in screen"
              className="rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-400 hover:border-neutral-500 hover:text-neutral-200 disabled:opacity-40"
            >
              {signingOut ? "Signing out…" : "Sign out"}
            </button>
          )}
          {!lockWorkspace && (
            <button
              onClick={switchWorkspace}
              title="Full reset: choose a different workspace"
              className="rounded-md border border-[rgba(119,255,117,0.25)] px-3 py-1.5 text-xs text-neutral-300 hover:border-[rgba(119,255,117,0.5)]"
            >
              Switch workspace
            </button>
          )}
          <Link
            href="/evidence"
            title="Session-only proof: writes, comparisons, demo card"
            className="rounded-md border border-[rgba(119,255,117,0.25)] px-3 py-1.5 text-xs text-neutral-300 hover:border-[rgba(119,255,117,0.5)]"
          >
            Evidence
          </Link>
          <button
            onClick={() => void markResolved()}
            disabled={messages.length === 0 || !conversationId || resolving}
            title="Confirm this issue is resolved"
            className="rounded-md border border-[rgba(119,255,117,0.35)] px-3 py-1.5 text-xs text-[#9AFF8D] disabled:opacity-40 hover:border-[rgba(119,255,117,0.5)]"
          >
            {resolving ? "Resolving…" : "Mark resolved"}
          </button>
        </div>
      </header>

      {signOutError && (
        <p role="alert" className="mt-3 rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-200">
          {signOutError}
        </p>
      )}

      <div className="flex-1 space-y-4 py-6">
        {messages.length === 0 && (
          <p className="rounded-md border border-[rgba(119,255,117,0.14)] bg-[rgba(10,27,18,0.72)] px-4 py-3 text-sm text-neutral-400">
            Ask a support question. If Meros remembers relevant context from
            your private memory, it will use it — and show you exactly what it
            used below each answer.
          </p>
        )}
        {messages.map((m, i) =>
          m.kind === "user" ? (
            <div key={i} className="flex justify-end">
              <div className="max-w-[85%]">
                {m.text ? (
                  <p className="whitespace-pre-wrap rounded-lg bg-[rgba(119,255,117,0.12)] border border-[rgba(119,255,117,0.3)] px-4 py-2.5 text-sm text-white">
                    {m.text}
                  </p>
                ) : null}
                {m.attachments && m.attachments.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap justify-end gap-1.5">
                    {m.attachments.map((a, j) => (
                      <span
                        key={`${a.filename}-${j}`}
                        title={`${a.filename} (${a.kind})`}
                        className="inline-flex max-w-full items-center gap-1 truncate rounded-md border border-[rgba(119,255,117,0.3)] bg-[#06100B] px-2 py-1 font-mono text-[11px] text-neutral-300"
                      >
                        {a.kind === "image" ? "🖼" : a.kind === "audio" ? "🎙" : "📄"}{" "}
                        <span className="truncate">{a.filename}</span>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div key={i} className="max-w-[95%]">
              {m.author === "staff" ? (
                <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-[#9AFF8D]">Meros team</p>
              ) : null}
              <div className="rounded-lg border border-[rgba(119,255,117,0.14)] bg-[rgba(10,27,18,0.72)] px-4 py-2.5 text-sm leading-6 text-neutral-100">
                <Markdown text={m.text} />
              </div>
              <MemoryLens msg={m} historyTurns={m.historyTurns} />
              {(m.memoryUsed.private || m.memoryUsed.shared || m.memoryUsed.knowledge) && !m.compare && (
                <button
                  onClick={() => void runCompare(i)}
                  className="mt-1.5 rounded-md border border-[rgba(119,255,117,0.25)] px-3 py-1.5 text-[11px] text-neutral-300 hover:border-[rgba(119,255,117,0.5)] hover:text-[#9AFF8D]"
                >
                  Compare without memory
                </button>
              )}
              {m.compare?.status === "loading" && (
                <p className="mt-1.5 text-[11px] text-neutral-500">Generating no-memory baseline — no Walrus recall, nothing stored…</p>
              )}
              {m.compare?.status === "failed" && (
                <p className="mt-1.5 text-[11px] text-red-300">Baseline failed: {m.compare.error}</p>
              )}
              {m.compare?.status === "done" && (
                <CompareCard original={m} baseline={m.compare.baseline} />
              )}
              {m.degradedMemory === true && (
                <p className="mt-1 text-[11px] text-amber-400/80">Some memory sources were temporarily unavailable. Meros answered from the context it could retrieve.</p>
              )}
              {m.attachmentNote ? (
                <p className="mt-1 text-[11px] text-neutral-500">Current message · Attachment ({m.attachmentNote})</p>
              ) : null}
              {m.captureNote && (
                <p className="mt-1 text-[11px] text-neutral-500">{m.captureNote}</p>
              )}
            </div>
          ),
        )}
        {resolvedCard && (
          <div className="rounded-lg border border-emerald-900 bg-[rgba(10,27,18,0.72)] px-4 py-3">
            <p className="text-sm font-medium text-[#9AFF8D]">Resolved. This solution has been sent to the support team for review.</p>
            {resolvedCard.candidateText && (
              <pre className="mt-2 whitespace-pre-wrap rounded-md border border-[rgba(119,255,117,0.14)] bg-[#06100B] px-3 py-2 font-mono text-xs leading-5 text-neutral-200">
                {resolvedCard.candidateText}
              </pre>
            )}
            <button
              onClick={() => setResolvedCard(null)}
              className="mt-3 rounded-md border border-[rgba(119,255,117,0.25)] px-4 py-2 text-xs text-neutral-300 hover:border-[rgba(119,255,117,0.5)]"
            >
              Dismiss
            </button>
          </div>
        )}
        {sending && (
          <p className="text-sm text-neutral-500">Meros is recalling memory and answering…</p>
        )}
        {error && (
          <div className="rounded-md border border-red-900 bg-red-950/40 px-4 py-2.5 text-sm text-red-300">
            <p>{error}</p>
            {failedTurn && !sending && !retrying && (
              <button
                type="button"
                onClick={() => void retryAnswer()}
                className="mt-2 rounded-md bg-[#77FF75] px-3 py-1.5 text-xs font-medium text-neutral-950 hover:bg-emerald-400"
              >
                Retry answer
              </button>
            )}
            {retrying && <p className="mt-1 text-xs text-neutral-400">Retrying your saved message…</p>}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="sticky bottom-0 border-t border-[rgba(119,255,117,0.14)] bg-[#06100B]/95 backdrop-blur py-3">
        {pending.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5" aria-label="Pending attachments">
            {pending.map((a) => (
              <span
                key={a.id}
                className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-[rgba(119,255,117,0.3)] bg-[#06100B] px-2 py-1.5 text-xs text-neutral-200"
              >
                {a.thumbnailUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={a.thumbnailUrl} alt="" className="h-8 w-8 rounded object-cover" />
                ) : (
                  <span aria-hidden>{a.kind === "audio" ? "🎙" : "📄"}</span>
                )}
                <span className="min-w-0">
                  <span className="block max-w-[140px] truncate font-mono text-[11px]" title={a.filename}>
                    {a.filename}
                  </span>
                  <span className="block font-mono text-[10px] text-neutral-500">
                    {a.kind}
                    {typeof a.durationSec === "number" ? ` · ${a.durationSec}s` : ""} · {formatBytes(a.sizeBytes)}
                  </span>
                </span>
                <button
                  onClick={() => removePending(a.id)}
                  disabled={sending}
                  aria-label={`Remove attachment ${a.filename}`}
                  title="Remove attachment"
                  className="rounded px-1 text-neutral-400 hover:text-neutral-100 disabled:opacity-40"
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}
        {recordingSec !== null && (
          <div className="mb-2 flex items-center gap-3 rounded-md border border-red-900 bg-red-950/40 px-3 py-2" role="status" aria-live="polite">
            <span aria-hidden className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-60" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
            </span>
            <span className="font-mono text-xs text-red-200">Recording {recordingSec}s / {MAX_RECORD_SECONDS}s</span>
            <span className="flex-1" />
            <button
              onClick={cancelRecording}
              className="rounded-md border border-red-900 px-3 py-1.5 text-xs text-red-200 hover:border-red-700"
            >
              Cancel
            </button>
            <button
              onClick={finishRecording}
              className="rounded-md bg-[#77FF75] px-3 py-1.5 text-xs font-medium text-[#030806] hover:bg-[#9AFF8D]"
            >
              Finish
            </button>
          </div>
        )}
        {attachError && (
          <p role="alert" className="mb-2 text-xs text-red-300">
            {attachError}
          </p>
        )}
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            aria-hidden
            tabIndex={-1}
            accept=".png,.jpg,.jpeg,.webp,.pdf,.txt,.csv,.md,audio/*"
            multiple
            onChange={(e) => {
              if (e.target.files) void pickFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={sending}
            aria-label="Attach a file"
            title="Attach an image or document (PNG, JPG, WEBP, PDF, TXT, CSV)"
            className="shrink-0 rounded-md border border-[rgba(119,255,117,0.25)] px-3 py-2.5 text-sm text-neutral-300 hover:border-[rgba(119,255,117,0.5)] disabled:opacity-40"
          >
            +
          </button>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            aria-label="Describe your issue"
            placeholder="Describe your issue…"
            className="min-w-0 flex-1 rounded-md border border-[rgba(119,255,117,0.25)] bg-[rgba(10,27,18,0.72)] px-3 py-2.5 text-sm outline-none placeholder:text-neutral-600 focus:border-[#77FF75]"
          />
          <button
            onClick={() => void startRecording()}
            disabled={sending || recordingSec !== null}
            aria-label={typeof MediaRecorder === "undefined" ? "Voice messages not supported in this browser" : "Record a voice message"}
            title="Record a voice message"
            className="shrink-0 rounded-md border border-[rgba(119,255,117,0.25)] px-3 py-2.5 text-sm text-neutral-300 hover:border-[rgba(119,255,117,0.5)] disabled:opacity-40"
          >
            <span aria-hidden>🎙</span>
          </button>
          <button
            onClick={send}
            disabled={sending || (!draft.trim() && pending.length === 0)}
            className="shrink-0 rounded-md bg-[#77FF75] px-5 py-2.5 text-sm font-medium text-[#030806] disabled:opacity-40 hover:bg-[#9AFF8D]"
          >
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
      </div>
    </main>
  );
}
