import { getCredentials, type ProviderCredentials } from "../keys";
import { PROVIDER_INFO, type StudioProviderId } from "../models";
import { argoLink } from "./argolink";
import { modelArk } from "./modelark";
import { ProviderError, type ProviderFactory, type VideoProvider } from "./types";

export { ProviderError } from "./types";

/** Video providers only. fal is a generic queue client (see fal.ts), not a catalog model. */
export const PROVIDERS: Record<StudioProviderId, ProviderFactory> = { argolink: argoLink, modelark: modelArk };

export function createProvider(id: StudioProviderId, creds: ProviderCredentials): VideoProvider {
  return PROVIDERS[id](creds);
}

/** The provider client for a user, using their own stored key. */
export async function providerForUser(userId: string, id: StudioProviderId): Promise<VideoProvider> {
  const creds = await getCredentials(userId, id);
  if (!creds) throw new ProviderError(`Add your ${PROVIDER_INFO[id].label} API key in Settings first.`, 400);
  return createProvider(id, creds);
}
