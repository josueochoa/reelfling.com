// Google OpenID Connect, authorization-code flow with PKCE.
// https://developers.google.com/identity/openid-connect/openid-connect

import { createHash } from "node:crypto";
import { randomToken } from "./crypto";
import { env } from "./db";

export const OAUTH_COOKIE = "oauth_google";

export function googleConfig() {
  const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret } = env();
  if (!clientId || !clientSecret) return undefined;
  return { clientId, clientSecret };
}

/** APP_URL wins (needed behind proxies); otherwise the request's own origin. */
export function redirectUri(requestUrl: string) {
  const origin = env().APP_URL?.replace(/\/$/, "") || new URL(requestUrl).origin;
  return `${origin}/api/auth/google/callback`;
}

export function startAuth(clientId: string, redirect: string) {
  const state = randomToken(16);
  const verifier = randomToken(48);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect,
    response_type: "code",
    scope: "openid email profile",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return { url: url.toString(), state, verifier };
}

export interface GoogleProfile {
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
  picture?: string;
}

export async function finishAuth(
  cfg: { clientId: string; clientSecret: string },
  code: string,
  verifier: string,
  redirect: string,
): Promise<GoogleProfile> {
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: redirect,
      grant_type: "authorization_code",
      code_verifier: verifier,
    }),
  });
  if (!tokenRes.ok) throw new Error(`Token exchange failed (${tokenRes.status})`);
  const { access_token } = (await tokenRes.json()) as { access_token: string };

  // Fetched server-to-server over TLS straight from Google, so it can be trusted as-is.
  const infoRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  if (!infoRes.ok) throw new Error(`Userinfo request failed (${infoRes.status})`);
  return infoRes.json();
}
