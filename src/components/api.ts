import type { AuthMode, User } from "@/lib/auth";
import type { KeySummary } from "@/lib/keys";
import type { SavedLook } from "@/lib/registry/looks";
import type { storageUsage } from "@/lib/storage";

export interface Me {
  user: User;
  keys: KeySummary[];
  storage: Awaited<ReturnType<typeof storageUsage>>;
  /** Saved provider per model id. */
  routePreferences?: Record<string, string>;
  /** Named looks. Absent until /api/me has been read. */
  looks?: SavedLook[];
  /** People sharing a team with this user. Their work shows in every tab. */
  teammates?: number;
  auth: { mode: AuthMode; signOutUrl: string };
}

/** Fired on `window` after a request that can spend or change a key, so balances are read again. */
export const BALANCE_EVENT = "reelfling:balance";
const SPENDS = /^\/api\/(generations|images|fal|keys|enhance)(\/|\?|$)/;

/** fetch() for our own API: a 401 (signed out, or Access couldn't be verified) goes to /login. */
export async function api(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(path, init);
  const method = (init?.method ?? "GET").toUpperCase();
  if (res.ok && method !== "GET" && SPENDS.test(path)) window.dispatchEvent(new Event(BALANCE_EVENT));
  if (res.status === 401) {
    // Full reload on purpose: drops all signed-in client state.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = "/login";
    throw new Error("Signed out");
  }
  return res;
}

export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await api(path, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json", ...init.headers } : init?.headers,
  });
  const body = (res.status === 204 ? {} : await res.json()) as { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body as T;
}
