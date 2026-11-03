import { getCredentials, type ProviderCredentials } from "../keys";
import { PROVIDER_INFO, type StudioProviderId } from "../registry";
import { argoLink } from "./argolink";
import { modelArk } from "./modelark";
import { openRouterProvider } from "./openrouter";
import { ProviderError, type ProviderFactory, type VideoProvider } from "./types";

export { ProviderError } from "./types";

/** Video providers only. fal is a generic queue client (see fal.ts), not a catalog model. */
export const PROVIDERS: Record<StudioProviderId, ProviderFactory> = {
  argolink: argoLink,
  modelark: modelArk,
  openrouter: openRouterProvider,
};

export function createProvider(id: StudioProviderId, creds: ProviderCredentials): VideoProvider {
  return PROVIDERS[id](creds);
}

/** The provider client for one workspace's stored key (a person, or a team). */
export async function providerForWorkspace(workspaceId: string, id: StudioProviderId): Promise<VideoProvider> {
  const creds = await getCredentials(workspaceId, id);
  if (!creds) throw new ProviderError(`Add your ${PROVIDER_INFO[id].label} API key in Settings first.`, 400);
  return createProvider(id, creds);
}
