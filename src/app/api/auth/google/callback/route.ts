import { NextResponse, type NextRequest } from "next/server";
import { createSession, upsertGoogleUser } from "@/lib/auth";
import { finishAuth, googleConfig, OAUTH_COOKIE, redirectUri } from "@/lib/google";
import { activeDriver, ensureBucket } from "@/lib/storage";

export async function GET(request: NextRequest) {
  const fail = (error: string) => {
    const res = NextResponse.redirect(new URL(`/login?error=${error}`, request.url));
    res.cookies.delete({ name: OAUTH_COOKIE, path: "/api/auth/google" });
    return res;
  };

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
    const user = upsertGoogleUser(profile);
    await createSession(user.id);
    // Provision the user's bucket up front. Not fatal: uploads retry it on first use.
    if (activeDriver() === "r2") await ensureBucket(user.id).catch((e) => console.error("Bucket setup failed:", e));
  } catch (e) {
    console.error("Google sign-in failed:", e);
    return fail("google_error");
  }

  const res = NextResponse.redirect(new URL("/", request.url));
  res.cookies.delete({ name: OAUTH_COOKIE, path: "/api/auth/google" });
  return res;
}
