// The connector's way into the app: in-process requests to the app's own routes, made as
// one user. Generation, keys, storage and pricing stay in those routes, written once.

import { CONNECTOR_USER_HEADER, registerConnectorCall } from "@/lib/connectorToken";

export interface ConnectorEnv {
  DB: D1Database;
  OAUTH_KV: KVNamespace;
  AUTH_SECRET?: string;
  /** The app, behind Cloudflare Access. Default https://reelfling.com. */
  APP_URL?: string;
  /** The connector's own host, outside Access. Default https://mcp.reelfling.com. */
  MCP_URL?: string;
}

export type AppFetch = (request: Request, env: ConnectorEnv, ctx: ExecutionContext) => Promise<Response>;

const trimmed = (url: string) => url.replace(/\/+$/, "");
export const appOrigin = (env: ConnectorEnv) => trimmed(env.APP_URL || "https://reelfling.com");
export const mcpOrigin = (env: ConnectorEnv) => trimmed(env.MCP_URL || "https://mcp.reelfling.com");

/** A route's `{ error }` message, so a tool can pass it on to Claude as written. */
export class AppError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface AppClient {
  response(path: string, init?: RequestInit): Promise<Response>;
  json<T>(path: string, init?: RequestInit): Promise<T>;
}

export function appAs(fetchApp: AppFetch, env: ConnectorEnv, ctx: ExecutionContext, userId: string): AppClient {
  async function response(path: string, init: RequestInit = {}) {
    const call = registerConnectorCall(userId);
    try {
      const headers = new Headers(init.headers);
      headers.set(CONNECTOR_USER_HEADER, call.token);
      if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
      return await fetchApp(new Request(`${appOrigin(env)}${path}`, { ...init, headers, redirect: "manual" }), env, ctx);
    } finally {
      call.release();
    }
  }
  return {
    response,
    async json<T>(path: string, init?: RequestInit) {
      const res = await response(path, init);
      const body = (await res.json().catch(() => ({}))) as T & { error?: string };
      if (!res.ok) throw new AppError(body.error || `ReelFling returned ${res.status}`, res.status);
      return body;
    },
  };
}

export interface BrowserUser {
  id: string;
  email: string;
  name: string | null;
}

/**
 * The person behind a browser request to the app (consent page, connected apps). The app
 * checks the Access token or session cookie, so this forwards only those.
 */
export async function browserUser(
  fetchApp: AppFetch,
  request: Request,
  env: ConnectorEnv,
  ctx: ExecutionContext,
): Promise<BrowserUser | undefined> {
  const headers = new Headers();
  for (const name of ["cookie", "cf-access-jwt-assertion"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const res = await fetchApp(new Request(`${appOrigin(env)}/api/me`, { headers }), env, ctx);
  if (!res.ok) return undefined;
  const { user } = (await res.json()) as { user?: BrowserUser };
  return user?.id ? { id: user.id, email: user.email, name: user.name } : undefined;
}
