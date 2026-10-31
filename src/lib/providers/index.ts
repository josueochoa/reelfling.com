import { getCredentials, type ProviderCredentials } from "../keys";
import { PROVIDER_INFO, type ProviderId } from "../models";
import { argoLink } from "./argolink";
import { modelArk } from "./modelark";
import { openRouterProvider } from "./openrouter";
import { ProviderError, type ProviderFactory, type VideoProvider } from "./types";

export { ProviderError } from "./types";

export const PROVIDERS: Record<ProviderId, ProviderFactory> = {
  argolink: argoLink,
  openrouter: openRouterProvider,
  modelark: modelArk,
};

export function createProvider(id: ProviderId, creds: ProviderCredentials): VideoProvider {
  return PROVIDERS[id](creds);
}

/** The provider client for a workspace, using its stored key (personal, or the team's). */
export async function providerForWorkspace(workspaceId: string, id: ProviderId): Promise<VideoProvider> {
  const creds = await getCredentials(workspaceId, id);
  if (!creds) throw new ProviderError(`Add a ${PROVIDER_INFO[id].label} API key under API keys first.`, 400);
  return createProvider(id, creds);
}
