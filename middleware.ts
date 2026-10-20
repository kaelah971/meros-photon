import { NextResponse, type NextRequest } from "next/server";
import { loginUrl } from "@/lib/return-to";

// Staff deep-link guard: an anonymous visitor opening /app/workspaces/*
// is sent to login WITH the exact destination preserved, so a later
// sign-in returns them to the requested staff page. This checks only
// cookie PRESENCE (cheap, edge-safe) — real session + membership checks
// still happen in the workspace layout, which re-verifies everything.
export function middleware(req: NextRequest) {
  const hasSessionCookie = req.cookies
    .getAll()
    .some((c) => c.name.includes("session_token"));
  if (hasSessionCookie) return NextResponse.next();
  const dest = `${req.nextUrl.pathname}${req.nextUrl.search}`;
  return NextResponse.redirect(new URL(loginUrl(dest), req.url));
}

export const config = {
  matcher: ["/app/workspaces/:path*"],
};
