// Picks the key a generation will run on, then refuses a team-key job that would
// pass the member's cap before any provider call.

import {
  keyedProviders,
  pickRoute,
  type HeldProviders,
} from "./registry/availability";
import { getCredentials, listKeys, scrubSecret, type ProviderCredentials } from "./keys";
import { PROVIDER_INFO, type ProviderId, type Route } from "./registry";
import type { KeySource } from "./scope";
import { memberCap, monthSpend, startAfterCap } from "./spend";
import { chooseKey, type Workspace } from "./workspaces";

export interface OpenedKey {
  source: KeySource;
  keyWorkspaceId: string;
  creds: ProviderCredentials;
  cap: number | null;
  spent: number;
  estimate: number;
}

export async function openGenerationKey(opts: {
  workspace: Workspace;
  userId: string;
  provider: ProviderId;
  requested?: KeySource | null;
  estimate: number;
}): Promise<OpenedKey> {
  const chosen = chooseKey(opts.workspace, opts.userId, opts.requested);
  const creds = await getCredentials(chosen.keyWorkspaceId, opts.provider);
  if (!creds) {
    const label = PROVIDER_INFO[opts.provider].label;
    const who = chosen.source === "team" ? `the team's ${label}` : `your ${label}`;
    throw Object.assign(new Error(`Add ${who} API key under API keys.`), { status: 400 });
  }
  const cap = chosen.source === "team" ? await memberCap(opts.workspace.id, opts.userId) : null;
  const spent = chosen.source === "team" ? await monthSpend(opts.workspace.id, opts.userId) : 0;
  return { ...chosen, creds, cap, spent, estimate: opts.estimate };
}

/** Workspace keys, plus the member's own providers when the owner allows that. */
export async function heldKeys(workspace: Workspace, userId: string): Promise<HeldProviders> {
  const workspaceProviders = (await listKeys(workspace.id)).map((key) => key.provider);
  const personalProviders =
    workspace.kind === "team" && workspace.memberKeys ? (await listKeys(userId)).map((key) => key.provider) : [];
  return {
    keyed: keyedProviders({
      workspaceProviders,
      personalProviders,
      memberKeys: workspace.memberKeys,
    }),
    workspace: new Set(workspaceProviders),
    personal: new Set(personalProviders),
  };
}

/**
 * The route a request may call. Throws a 400 that names providers only when none
 * of the routes has a key in this workspace.
 */
export async function resolveAvailableRoute<T extends { routes: readonly Route[] }>(
  model: T,
  workspace: Workspace,
  userId: string,
  opts: {
    requested?: KeySource | null;
    prefer?: string | null | ((keyed: ReadonlySet<string>) => string | null | undefined);
  } = {},
) {
  const held = await heldKeys(workspace, userId);
  const prefer = typeof opts.prefer === "function" ? opts.prefer(held.keyed) : opts.prefer;
  const picked = pickRoute(model, held, {
    team: workspace.kind === "team",
    memberKeys: workspace.memberKeys,
    requested: opts.requested,
    prefer,
  });
  return { ...picked, keyed: held.keyed };
}

export async function runWithCap<T>(opened: OpenedKey, start: () => Promise<T>): Promise<T> {
  let result!: T;
  try {
    await startAfterCap(
      { source: opened.source, cap: opened.cap, spent: opened.spent, estimate: opened.estimate },
      async () => {
        result = await start();
      },
    );
  } catch (e) {
    if (e instanceof Error) e.message = scrubSecret(e.message, opened.creds.apiKey);
    throw e;
  }
  return result;
}
