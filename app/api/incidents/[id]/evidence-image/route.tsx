import { NextResponse } from "next/server";
import * as React from "react";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { requireUser } from "@/lib/auth";
import { getWorkspaceBySlug } from "@/lib/db";
import { loadEvidenceView, type EvidenceView } from "@/lib/evidence-view";
import { requireStaff } from "@/lib/support-ops";

export const runtime = "nodejs";

const W = 1200;
const H = 675;

const INK = "#E8F0E9";
const DIM = "#9AA79D";
const FAINT = "#5B665D";
const GREEN = "#77FF75";
const BG = "#0B0F0C";
const PANEL = "#0E1A12";
const LINE = "rgba(119,255,117,0.22)";

let cachedFont: Buffer | null = null;

async function loadFont(): Promise<Buffer> {
  if (cachedFont) return cachedFont;
  // Vendored OFL font (assets/fonts, see NOTICE there). No network fetch.
  cachedFont = await readFile(join(process.cwd(), "assets", "fonts", "noto-sans-regular.ttf"));
  return cachedFont;
}

function fit(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

function NonReadyCard({ heading, state, note }: { heading: string; state: string; note: string }) {
  return (
    <div
      style={{
        width: W, height: H, display: "flex", flexDirection: "column",
        backgroundColor: BG, color: INK, fontFamily: '"Noto Sans", sans-serif',
        padding: 64, justifyContent: "space-between",
      }}
    >
      <div style={{ display: "flex", flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontSize: 26, letterSpacing: 6, color: GREEN }}>MEROS / INCIDENT EVIDENCE</div>
        <div style={{ fontSize: 20, color: FAINT }}>{state.toUpperCase()}</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ fontSize: 44, fontWeight: 700 }}>{fit(heading, 60)}</div>
        <div style={{ fontSize: 24, color: DIM, marginTop: 16, lineHeight: 1.5 }}>{fit(note, 220)}</div>
      </div>
      <div style={{ fontSize: 18, color: FAINT }}>Staff-only evidence record · nothing here is auto-generated or confirmed</div>
    </div>
  );
}

function ReadyCard({ view }: { view: Extract<EvidenceView, { ready: true }> }) {
  const facts = view.facts.slice(0, 3);
  const corroboration =
    view.corroborated[0]?.pattern ??
    view.unknowns[0] ??
    "Independent review required — treat as a lead, not a conclusion.";
  const match = view.matches[0];
  const fpLine = `BRIEF v${view.briefVersion} \u00b7 ${view.briefFingerprint.slice(0, 8)}`;
  const matchLine = match ? `\u00b7 fix ${match.refId.slice(0, 8)} \u00b7 ${fit(match.reasons[0] ?? match.excerpt, 90)}` : "";
  const fpFoot = `fp ${view.briefFingerprint.slice(0, 8)}`;
  const tierLabel =
    match?.tier === "verified_fix"
      ? "VERIFIED HISTORICAL FIX"
      : match?.tier === "documented_unverified"
        ? "DOCUMENTED BUT UNVERIFIED"
        : match
          ? "POSSIBLE MATCH"
          : null;
  return (
    <div
      style={{
        width: W, height: H, display: "flex", flexDirection: "column",
        backgroundColor: BG, color: INK, fontFamily: '"Noto Sans", sans-serif',
        padding: "48px 64px", justifyContent: "space-between",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 24, letterSpacing: 6, color: GREEN }}>MEROS / INCIDENT EVIDENCE</div>
          <div style={{ fontSize: 20, color: FAINT }}>{fpLine}</div>
        </div>
        <div style={{ fontSize: 46, fontWeight: 700, marginTop: 12 }}>{fit(view.heading, 64)}</div>
        <div style={{ display: "flex", flexDirection: "row", marginTop: 20 }}>
          {[
            [`${view.reportCount}`, "REPORTS"],
            [`${view.customerCount}`, "CUSTOMERS"],
            [`${view.conversationCount}`, "LINKED CONVOS"],
            ["CURRENT", "BRIEF STATUS"],
          ].map(([n, label], i) => (
            <div
              key={label}
              style={{
                border: `1px solid ${LINE}`,
                borderRadius: 10,
                padding: "10px 22px",
                marginRight: i < 3 ? 14 : 0,
                backgroundColor: PANEL,
                display: "flex",
                flexDirection: "column",
              }}
            >
              <div style={{ fontSize: 30, fontWeight: 700, color: i === 3 ? GREEN : INK }}>{n}</div>
              <div style={{ fontSize: 15, letterSpacing: 2, color: DIM }}>{label}</div>
            </div>
          ))}
        </div>
        <div style={{ fontSize: 20, letterSpacing: 3, color: GREEN, marginTop: 24 }}>WHAT WE KNOW</div>
        <div style={{ display: "flex", flexDirection: "column", marginTop: 8 }}>
          {facts.length === 0 && <div style={{ fontSize: 22, color: DIM }}>No supportable findings in the current evidence.</div>}
          {facts.map((f, i) => (
            <div key={i} style={{ display: "flex", flexDirection: "row", marginTop: i === 0 ? 0 : 8 }}>
              <div style={{ width: 12, height: 12, backgroundColor: GREEN, marginTop: 8, marginRight: 12, flexShrink: 0 }} />
              <div style={{ fontSize: 22, lineHeight: 1.35 }}>{fit(f.observation, 108)}</div>
            </div>
          ))}
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ fontSize: 20, letterSpacing: 3, color: GREEN, display: "flex" }}>WHY THIS MATTERS</div>
        <div style={{ fontSize: 21, color: DIM, marginTop: 6, display: "flex" }}>{fit(corroboration, 128)}</div>
        {tierLabel && match ? (
          <div style={{ display: "flex", flexDirection: "row", fontSize: 20, marginTop: 8 }}>
            <span style={{ color: GREEN }}>{tierLabel}</span>
            <span style={{ color: DIM }}>{matchLine}</span>
          </div>
        ) : (
          <div style={{ fontSize: 20, marginTop: 8, color: FAINT }}>No stored historical fix matched — absence of matches is not proof of novelty.</div>
        )}
        <div style={{ display: "flex", flexDirection: "row", justifyContent: "space-between", marginTop: 12 }}>
          <div style={{ fontSize: 17, color: FAINT }}>Unverified hypotheses are not confirmed · staff-only record</div>
          <div style={{ fontSize: 17, color: FAINT }}>{fpFoot}</div>
        </div>
      </div>
    </div>
  );
}

/**
 * S15D branded evidence PNG: server-rendered 16:9 from the SAME normalized
 * evidence model as the web view. Staff-only, private/no-store, never
 * cached publicly. Non-current briefs render an honest non-ready card —
 * never a silently "current" image from old evidence.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const slug = new URL(req.url).searchParams.get("workspaceSlug") ?? "";
    const ws = slug ? await getWorkspaceBySlug(slug) : null;
    if (!ws) return NextResponse.json({ ok: false, error: "workspace not found" }, { status: 404 });
    await requireStaff(user.id, ws.id);
    const { id } = await ctx.params;

    let font: Buffer;
    try {
      font = await loadFont();
    } catch {
      return NextResponse.json({ ok: false, error: "PNG renderer unavailable" }, { status: 503 });
    }

    const { ImageResponse } = await import("next/og");
    const { getIncidentForWorkspace } = await import("@/lib/incidents");
    const incidentRow = await getIncidentForWorkspace(ws.id, id).catch(() => null);
    if (!incidentRow) return NextResponse.json({ ok: false, error: "incident not found in this workspace" }, { status: 404 });
    const view = await loadEvidenceView(id, ws.id);
    const element = view.ready
      ? ReadyCard({ view })
      : NonReadyCard({ heading: view.heading || "Incident evidence", state: view.state, note: view.note });

    return new ImageResponse(element as never, {
      width: W,
      height: H,
      fonts: [{ name: "Noto Sans", data: font, weight: 400 as const, style: "normal" as const }],
      headers: {
        "content-type": "image/png",
        "cache-control": "private, no-store",
      },
    });
  } catch (e) {
    const status = (e as { status?: unknown })?.status;
    const code = typeof status === "number" ? status : 503;
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "request failed" },
      { status: code === 401 ? 401 : code },
    );
  }
}
