import { connection, NextResponse, type NextRequest } from "next/server";
import { authMode, createSession, NotInvitedError, upsertUser } from "@/lib/auth";
import { finishAuth, googleConfig, OAUTH_COOKIE, redirectUri } from "@/lib/google";
import { ensureBucket } from "@/lib/storage";

export async function GET(request: NextRequest) {
  const fail = (error: string) => {
    const res = NextResponse.redirect(new URL(`/login?error=${error}`, request.url));
    res.cookies.delete({ name: OAUTH_COOKIE, path: "/api/auth/google" });
    return res;
  };

  await connection();
  if (authMode() !== "google") return NextResponse.redirect(new URL("/", request.url));
  const cfg = googleConfig();
  if (!cfg) return fail("not_configured");

  const params = request.nextUrl.searchParams;
  if (params.get("error")) return fail("cancelled");

  let saved: { state: string; verifier: string };
  try {
    saved = JSON.parse(request.cookies.get(OAUTH_COOKIE)?.value ?? "");
  } catch {
    return fail("expired");
  }
  const code = params.get("code");
  if (!code || params.get("state") !== saved.state) return fail("state_mismatch");

  try {
    const profile = await finishAuth(cfg, code, saved.verifier, redirectUri(request.url));
    if (!profile.email_verified) return fail("unverified_email");
    const user = await upsertUser({ email: profile.email, name: profile.name, avatarUrl: profile.picture });
    await createSession(user.id);
    // Provision their Personal workspace's bucket up front. Not fatal: uploads retry it on first use.
    await ensureBucket(user.id).catch((e) => console.error("Bucket setup failed:", e));
  } catch (e) {
    if (e instanceof NotInvitedError) return fail("not_invited");
    console.error("Google sign-in failed:", e);
    return fail("google_error");
  }

  const res = NextResponse.redirect(new URL("/", request.url));
  res.cookies.delete({ name: OAUTH_COOKIE, path: "/api/auth/google" });
  return res;
}
