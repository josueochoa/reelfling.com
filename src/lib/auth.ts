// Who is making the request. Two modes (AUTH_MODE):
// - "access" (default): Cloudflare Access sits in front of the app and signs every
//   request with a JWT, which is verified here. No sessions or login page of our own.
// - "google": built-in Google sign-in with cookie sessions (the cookie holds a random
//   token; only its hash is stored).
// Users are keyed by email either way, so switching modes keeps everyone's data.

import { createRemoteJWKSet, jwtVerify } from "jose";
import { cookies, headers } from "next/headers";
import { connection } from "next/server";
import type { ProviderId } from "./models";
import { randomToken, sha256 } from "./crypto";
import { env, first, run } from "./db";

export const SESSION_COOKIE = "sid";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type AuthMode = "access" | "google";
export const authMode = (): AuthMode => (env().AUTH_MODE === "google" ? "google" : "access");

export interface User {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  activeProvider: ProviderId | null;
}

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
  active_provider: ProviderId | null;
}

const toUser = (r: UserRow): User => ({
  id: r.id,
  email: r.email,
  name: r.name,
  avatarUrl: r.avatar_url,
  activeProvider: r.active_provider,
});

export class AuthError extends Error {
  status = 401;
  constructor(message = "Not signed in") {
    super(message);
  }
}

/** Finds or creates the account for an email. Name and avatar are refreshed when given. */
export async function upsertUser(profile: { email: string; name?: string; avatarUrl?: string }): Promise<User> {
  const email = profile.email.trim().toLowerCase();
  // Called on every request in Access mode, so skip the write when nothing changed.
  const existing = await first<UserRow>("SELECT * FROM users WHERE email = ?", email);
  if (
    existing &&
    (profile.name ?? existing.name) === existing.name &&
    (profile.avatarUrl ?? existing.avatar_url) === existing.avatar_url
  )
    return toUser(existing);
  await run(
    `INSERT INTO users (id, email, name, avatar_url, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (email) DO UPDATE SET
       name = COALESCE(excluded.name, users.name), avatar_url = COALESCE(excluded.avatar_url, users.avatar_url)`,
    crypto.randomUUID(),
    email,
    profile.name ?? null,
    profile.avatarUrl ?? null,
    Date.now(),
  );
  return toUser((await first<UserRow>("SELECT * FROM users WHERE email = ?", email))!);
}

export async function setActiveProvider(userId: string, provider: ProviderId | null) {
  await run("UPDATE users SET active_provider = ? WHERE id = ?", provider, userId);
}

// ---------------------------------------------------------------- Cloudflare Access

/** Accepts "https://team.cloudflareaccess.com" or just "team". */
function teamDomain() {
  const raw = env().ACCESS_TEAM_DOMAIN?.trim().replace(/\/+$/, "");
  if (!raw) return undefined;
  return raw.includes("://") ? raw : `https://${raw}.cloudflareaccess.com`;
}

// Access rotates its signing keys; jose caches and refreshes them per isolate.
const jwksByDomain = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

async function accessUser(): Promise<User | undefined> {
  const domain = teamDomain();
  const aud = env().ACCESS_AUD;
  // Never trust identity headers without verifying them: requests that bypass Access
  // (e.g. via workers.dev) could forge them.
  const token = (await headers()).get("cf-access-jwt-assertion") ?? (await cookies()).get("CF_Authorization")?.value;

  if (!token) {
    // `next dev` has no Access in front of it.
    const devEmail = env().DEV_USER_EMAIL;
    if (process.env.NODE_ENV === "development" && devEmail) return upsertUser({ email: devEmail, name: "Dev user" });
    return undefined;
  }
  if (!domain || !aud) throw new Error("Set ACCESS_TEAM_DOMAIN and ACCESS_AUD (see wrangler.jsonc).");

  let jwks = jwksByDomain.get(domain);
  if (!jwks) jwksByDomain.set(domain, (jwks = createRemoteJWKSet(new URL(`${domain}/cdn-cgi/access/certs`))));
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer: domain, audience: aud, algorithms: ["RS256"] });
    // Service tokens have no email; they aren't users.
    if (typeof payload.email !== "string" || !payload.email) return undefined;
    return upsertUser({ email: payload.email });
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- Google sessions

export async function createSession(userId: string) {
  const token = randomToken();
  const now = Date.now();
  await run(
    "INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
    sha256(token),
    userId,
    now + SESSION_TTL_MS,
    now,
  );
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

async function sessionUser(): Promise<User | undefined> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return undefined;
  const row = await first<UserRow>(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
    sha256(token),
    Date.now(),
  );
  return row && toUser(row);
}

export async function destroySession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await run("DELETE FROM sessions WHERE token_hash = ?", sha256(token));
  await run("DELETE FROM sessions WHERE expires_at <= ?", Date.now());
  jar.delete(SESSION_COOKIE);
}

// ---------------------------------------------------------------- current user

export async function currentUser(): Promise<User | undefined> {
  // Per-request (never prerendered): reads the Worker env and the request's identity.
  await connection();
  return authMode() === "access" ? accessUser() : sessionUser();
}

export async function requireUser(): Promise<User> {
  const user = await currentUser();
  if (!user) throw new AuthError();
  return user;
}

/** Where "Sign out" goes: Access's logout endpoint, or our own (POST) route. */
export const signOutUrl = () => (authMode() === "access" ? "/cdn-cgi/access/logout" : "/api/auth/logout");

/** Maps thrown errors to JSON responses; 401s also clear a stale cookie. */
export async function errorResponse(e: unknown) {
  if (e instanceof AuthError) {
    if (authMode() === "google") (await cookies()).delete(SESSION_COOKIE);
    return Response.json({ error: e.message }, { status: 401 });
  }
  let status = (e as { status?: number }).status;
  // A provider rejecting the user's key isn't a session problem — don't let it look like one.
  if (status === 401 || status === 403) status = 400;
  if (!status || status >= 500) console.error(e);
  return Response.json(
    { error: (e as Error).message ?? "Something went wrong" },
    { status: status && status >= 400 ? status : 500 },
  );
}
