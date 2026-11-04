// Cloudflare D1 (SQLite). Schema lives in /migrations; apply with `npm run db:migrate`.
// Settings and secrets come from the Worker's env: wrangler.jsonc vars, plus .dev.vars
// locally and `wrangler secret put` in production. Never .env files — OpenNext would
// bundle them into the Worker.

import { getCloudflareContext } from "@opennextjs/cloudflare";

export interface AppEnv {
  DB: D1Database;
  /** Image generation jobs (see images.ts). */
  IMAGE_JOBS?: Queue<{ userId: string; id: string }>;
  AUTH_MODE?: string;
  AUTH_SECRET?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  DEV_USER_EMAIL?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  APP_URL?: string;
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_ENDPOINT?: string;
  /** Shared bucket. Objects are stored at `<user id>/<key>` inside it. */
  R2_BUCKET?: string;
  STORAGE_QUOTA_GB?: string;
}

let envOverride: AppEnv | undefined;

/** Tests inject an env so job code can run without a Worker. Production never sets this. */
export function setTestEnv(next: AppEnv | undefined) {
  envOverride = next;
}

/** The current request's Worker env. Only callable while handling a request, unless a test set one. */
export const env = () => envOverride ?? (getCloudflareContext().env as unknown as AppEnv);

type Param = string | number | null;

const stmt = (sql: string, params: Param[]) =>
  env()
    .DB.prepare(sql)
    .bind(...params);

export async function first<T>(sql: string, ...params: Param[]): Promise<T | undefined> {
  return (await stmt(sql, params).first<T>()) ?? undefined;
}

export async function all<T>(sql: string, ...params: Param[]): Promise<T[]> {
  return (await stmt(sql, params).all<T>()).results;
}

export async function run(sql: string, ...params: Param[]) {
  return stmt(sql, params).run();
}
