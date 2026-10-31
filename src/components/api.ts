import type { AuthMode, User } from "@/lib/auth";
import type { KeySummary } from "@/lib/keys";
import type { storageUsage } from "@/lib/storage";
import type { Invite, Workspace } from "@/lib/workspaces";

export interface Me {
  user: User;
  /** The workspace this tab is in, and its keys and storage. */
  workspace: Workspace;
  workspaces: Workspace[];
  /** Email invites waiting for the user. */
  invites: Invite[];
  keys: KeySummary[];
  storage: Awaited<ReturnType<typeof storageUsage>>;
  auth: { mode: AuthMode; signOutUrl: string };
}

// The workspace this tab acts in. Per tab (not a cookie), so two tabs can be in different
// workspaces; remembered for the next visit.
const WORKSPACE_KEY = "workspace";
let workspaceId: string | null = (() => {
  try {
    return typeof window === "undefined" ? null : localStorage.getItem(WORKSPACE_KEY);
  } catch {
    return null;
  }
})();

export function setWorkspace(id: string) {
  workspaceId = id;
  try {
    localStorage.setItem(WORKSPACE_KEY, id);
  } catch {
    // Not remembered next time; this tab still uses it.
  }
}

/** Media URLs (<img>, <video>, downloads) can't send headers, so they carry ?ws= instead. */
export function withWorkspace(url: string) {
  if (!workspaceId) return url;
  return `${url}${url.includes("?") ? "&" : "?"}ws=${encodeURIComponent(workspaceId)}`;
}

/** fetch() for our own API, in the tab's workspace: a 401 goes to /login, and so does "not invited". */
export async function api(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(path, {
    ...init,
    headers: { ...(workspaceId && { "x-workspace-id": workspaceId }), ...init?.headers },
  });
  if (res.status === 401 || res.status === 403) {
    const code =
      res.status === 403
        ? (
            (await res
              .clone()
              .json()
              .catch(() => ({}))) as { code?: string }
          ).code
        : null;
    if (res.status === 401 || code === "not_invited") {
      // Full reload on purpose: drops all signed-in client state.
      window.location.href = code ? `/login?error=${code}` : "/login";
      throw new Error("Signed out");
    }
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
