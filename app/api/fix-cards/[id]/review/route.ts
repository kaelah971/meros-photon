import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getMembership, getWorkspaceBySlug } from "@/lib/db";
import { formatSharedFix, validateSharedCandidate } from "@/lib/support-memory";
import { deriveSharedNamespaceV2 } from "@/lib/tenant";
import {
  createSharedFixCardRevision,
  getFixCardForWorkspace,
  markFixCardFailed,
  markFixCardKeptPrivate,
  markFixCardShared,
  markFixCardSuperseded,
} from "@/lib/support-ops";
import { WalrusNotConfiguredError, rememberInNamespace } from "@/lib/walrus";

const STAFF_ROLES = new Set(["owner", "admin", "support"]);

/**
 * Staff Fix Card review. BOTH decisions require organization membership
 * (owner/admin/support) in the Fix Card's workspace organization:
 * - shared: revalidate → rememberAndWait into the workspace shared
 *   namespace → record blob metadata. Real Walrus completion required.
 * - kept_private: ZERO Walrus writes; status row only.
 * Customer sessions (no membership) get 403 here — the support UI never
 * calls this endpoint.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  let body: { workspaceSlug?: unknown; decision?: unknown; edited?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  let user: Awaited<ReturnType<typeof requireUser>>;
  try {
    user = await requireUser();
  } catch (e) {
    const status =
      typeof (e as { status?: unknown })?.status === "number"
        ? (e as { status: number }).status
        : 401;
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "not signed in" },
      { status },
    );
  }

  const { id } = await ctx.params;
  const decision = body.decision;
  if (decision !== "shared" && decision !== "kept_private" && decision !== "correct_shared") {
    return NextResponse.json(
      { ok: false, error: "decision must be 'shared', 'kept_private', or 'correct_shared'" },
      { status: 400 },
    );
  }

  try {
    // Scope by workspace slug, then verify staff membership in that
    // workspace's organization. Neither slug nor card id alone authorizes.
    const slug = typeof body.workspaceSlug === "string" ? body.workspaceSlug.trim() : "";
    const ws = slug ? await getWorkspaceBySlug(slug) : null;
    if (!ws) {
      return NextResponse.json({ ok: false, error: "workspace not found" }, { status: 404 });
    }
    const membership = await getMembership(user.id, ws.organization_id);
    if (!membership || !STAFF_ROLES.has(membership.role)) {
      return NextResponse.json({ ok: false, error: "staff access required" }, { status: 403 });
    }

    const card = await getFixCardForWorkspace(id, ws.id);
    if (!card) {
      return NextResponse.json({ ok: false, error: "fix card not found" }, { status: 404 });
    }

    // Correction path: only an already-shared card can be corrected, and a
    // correction always requires reviewed text. The old Walrus blob is
    // immutable — a NEW blob is written, the old row is marked superseded
    // (old blob preserved for audit), and the new row becomes the active fix.
    if (decision === "correct_shared") {
      if (card.status !== "shared") {
        return NextResponse.json(
          { ok: false, error: `only a shared fix card can be corrected (card is ${card.status})` },
          { status: 409 },
        );
      }
      const e = body.edited as Record<string, unknown> | null;
      const fields = ["symptom", "cause", "resolution"].map((k) =>
        typeof e?.[k] === "string" ? (e[k] as string).trim().replace(/\s+/g, " ") : "",
      );
      if (fields.some((f) => !f)) {
        return NextResponse.json(
          { ok: false, status: "failed", error: "corrected symptom, cause, and resolution must all be non-empty" },
          { status: 400 },
        );
      }
      if (fields.some((f) => f.length > 400)) {
        return NextResponse.json(
          { ok: false, status: "failed", error: "corrected fields must each be 400 chars or fewer" },
          { status: 400 },
        );
      }
      const corrected = formatSharedFix({ symptom: fields[0], cause: fields[1], resolution: fields[2] });
      const gate = validateSharedCandidate(corrected);
      if (!gate.ok) {
        return NextResponse.json(
          { ok: false, status: "failed", error: gate.error },
          { status: 400 },
        );
      }
      try {
        const done = await rememberInNamespace(deriveSharedNamespaceV2(ws.id), corrected, 2000);
        const revision = await createSharedFixCardRevision({
          workspaceId: ws.id,
          customerId: card.customer_id,
          conversationId: card.conversation_id,
          issueId: card.issue_id,
          candidateText: card.candidate_text,
          reviewedText: corrected,
          blobId: done.blobId,
          reviewerId: user.id,
        });
        await markFixCardSuperseded(card.id, revision.id, user.id);
        return NextResponse.json({
          ok: true,
          status: "corrected",
          id: revision.id,
          supersedes: card.id,
          blobId: done.blobId,
          walrusJobId: done.jobId,
        });
      } catch (e) {
        if (e instanceof WalrusNotConfiguredError) {
          return NextResponse.json(
            { ok: false, status: "blocked", error: e.message, needed: e.needed },
            { status: 503 },
          );
        }
        return NextResponse.json(
          { ok: false, status: "failed", error: e instanceof Error ? e.message : "correction failed" },
          { status: 502 },
        );
      }
    }

    if (card.status !== "pending_review") {
      return NextResponse.json(
        { ok: false, error: `fix card already ${card.status}`, status: card.status },
        { status: 409 },
      );
    }

    if (decision === "kept_private") {
      await markFixCardKeptPrivate(card.id, user.id);
      return NextResponse.json({ ok: true, status: "kept_private", id: card.id });
    }

    // Staff edit-before-share: optional reviewed Symptom/Cause/Resolution.
    // Edits arrive with the Save-shared decision only, are validated as
    // strictly as generated candidates (shape, length, redaction — no
    // transcript grounding available, staff is the authority), and the
    // reviewed version is EXACTLY what enters shared memory. Tenant and
    // workspace identity stay server-derived; extra payload keys are ignored.
    let finalText = card.candidate_text;
    let reviewed: string | undefined;
    if (body.edited !== undefined) {
      const e = body.edited as Record<string, unknown> | null;
      const fields = ["symptom", "cause", "resolution"].map((k) =>
        typeof e?.[k] === "string" ? (e[k] as string).trim().replace(/\s+/g, " ") : "",
      );
      if (fields.some((f) => !f)) {
        return NextResponse.json(
          { ok: false, status: "failed", error: "edited symptom, cause, and resolution must all be non-empty" },
          { status: 400 },
        );
      }
      if (fields.some((f) => f.length > 400)) {
        return NextResponse.json(
          { ok: false, status: "failed", error: "edited fields must each be 400 chars or fewer" },
          { status: 400 },
        );
      }
      finalText = formatSharedFix({ symptom: fields[0], cause: fields[1], resolution: fields[2] });
      reviewed = finalText;
    }

    // Shared path: re-validate the exact text about to be stored, then
    // write to the workspace-scoped shared namespace derived server-side.
    const gate = validateSharedCandidate(finalText);
    if (!gate.ok) {
      // A failing GENERATED candidate fails the card (nothing safe to share).
      // Failing STAFF edits leave the card pending so staff can correct them.
      if (reviewed === undefined) await markFixCardFailed(card.id);
      return NextResponse.json(
        { ok: false, status: "failed", error: gate.error },
        { status: 400 },
      );
    }
    try {
      const done = await rememberInNamespace(
        deriveSharedNamespaceV2(ws.id),
        finalText,
        2000,
      );
      await markFixCardShared(card.id, done.blobId, user.id, reviewed);
      // S13: a shared card backed by a postmortem supersedes older shared
      // memories for the same incident. Failure-isolated — the share
      // itself already succeeded and must never be rolled back by this.
      try {
        const { linkMemoryShare } = await import("@/lib/operator-memory");
        await linkMemoryShare(ws.id, card.id, user.id);
      } catch {
        // Link bookkeeping is best-effort; the approved memory stands.
      }
      return NextResponse.json({
        ok: true,
        status: "shared",
        id: card.id,
        blobId: done.blobId,
        walrusJobId: done.jobId,
        ...(reviewed !== undefined ? { reviewed: true } : {}),
      });
    } catch (e) {
      if (e instanceof WalrusNotConfiguredError) {
        return NextResponse.json(
          { ok: false, status: "blocked", error: e.message, needed: e.needed },
          { status: 503 },
        );
      }
      await markFixCardFailed(card.id);
      return NextResponse.json(
        { ok: false, status: "failed", error: e instanceof Error ? e.message : "shared write failed" },
        { status: 502 },
      );
    }
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "review failed" },
      { status: 503 },
    );
  }
}
