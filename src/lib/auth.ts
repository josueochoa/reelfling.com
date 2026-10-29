// Users and cookie sessions. The cookie holds a random token; only its hash is stored.

import { cookies } from "next/headers";
import type { ProviderId } from "./models";
import { randomToken, sha256 } from "./crypto";
import { db } from "./db";
import { importLegacyGenerations } from "./store";

export const SESSION_COOKIE = "sid";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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
  constructor() {
    super("Not signed in");
  }
}

export function upsertGoogleUser(profile: { sub: string; email: string; name?: string; picture?: string }): User {
  const existing = db.prepare("SELECT id FROM users WHERE google_sub = ?").get(profile.sub) as
    { id: string } | undefined;
  if (existing) {
    db.prepare("UPDATE users SET email = ?, name = ?, avatar_url = ? WHERE id = ?").run(
      profile.email,
      profile.name ?? null,
      profile.picture ?? null,
      existing.id,
    );
    return getUser(existing.id)!;
  }

  const isFirstUser = (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n === 0;
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO users (id, google_sub, email, name, avatar_url, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    id,
    profile.sub,
    profile.email,
    profile.name ?? null,
    profile.picture ?? null,
    Date.now(),
  );
  // Pre-accounts history (data/generations.json) belongs to whoever set the app up.
  if (isFirstUser) importLegacyGenerations(id);
  return getUser(id)!;
}

export function getUser(id: string): User | undefined {
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
  return row && toUser(row);
}

export function setActiveProvider(userId: string, provider: ProviderId | null) {
  db.prepare("UPDATE users SET active_provider = ? WHERE id = ?").run(provider, userId);
}

export async function createSession(userId: string) {
  const token = randomToken();
  const now = Date.now();
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)").run(
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

export async function currentUser(): Promise<User | undefined> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return undefined;
  const row = db
    .prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .get(sha256(token), Date.now()) as UserRow | undefined;
  return row && toUser(row);
}

export async function requireUser(): Promise<User> {
  const user = await currentUser();
  if (!user) throw new AuthError();
  return user;
}

export async function destroySession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
  jar.delete(SESSION_COOKIE);
}

/** Maps thrown errors to JSON responses; 401s also clear a stale cookie. */
export async function errorResponse(e: unknown) {
  if (e instanceof AuthError) {
    (await cookies()).delete(SESSION_COOKIE);
    return Response.json({ error: e.message }, { status: 401 });
  }
  let status = (e as { status?: number }).status;
  // A provider rejecting the user's key isn't a session problem — don't let it look like one.
  if (status === 401 || status === 403) status = 400;
  return Response.json(
    { error: (e as Error).message ?? "Something went wrong" },
    { status: status && status >= 400 ? status : 500 },
  );
}
