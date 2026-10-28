import type { ProviderId } from "../models";
import { argoLink } from "./argolink";
import { modelArk } from "./modelark";
import type { VideoProvider } from "./types";

export { ProviderError } from "./types";

const providers: Record<ProviderId, VideoProvider> = { modelark: modelArk, argolink: argoLink };

/** VIDEO_PROVIDER wins; otherwise use whichever provider has a key (ArgoLink if both). */
export function activeProviderId(): ProviderId {
  const explicit = process.env.VIDEO_PROVIDER?.toLowerCase();
  if (explicit === "modelark" || explicit === "argolink") return explicit;
  if (process.env.ARGOLINK_API_KEY) return "argolink";
  return "modelark";
}

export function getProvider(id: ProviderId = activeProviderId()): VideoProvider {
  return providers[id];
}
