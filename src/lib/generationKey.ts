// Picks the key a generation will run on, then refuses a team-key job that would
// pass the member's cap before any provider call.

import { getCredentials, scrubSecret, type ProviderCredentials } from "./keys";
import { PROVIDER_INFO, type ProviderId } from "./registry";
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
