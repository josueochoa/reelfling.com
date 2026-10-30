import { connection, NextResponse } from "next/server";
import { authMode } from "@/lib/auth";
import { googleConfig, OAUTH_COOKIE, redirectUri, startAuth } from "@/lib/google";

export async function GET(request: Request) {
  await connection();
  if (authMode() !== "google") return NextResponse.redirect(new URL("/", request.url));
  const cfg = googleConfig();
  if (!cfg) return NextResponse.redirect(new URL("/login?error=not_configured", request.url));

  const { url, state, verifier } = startAuth(cfg.clientId, redirectUri(request.url));
  const res = NextResponse.redirect(url);
  res.cookies.set(OAUTH_COOKIE, JSON.stringify({ state, verifier }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/auth/google",
    maxAge: 600,
  });
  return res;
}
