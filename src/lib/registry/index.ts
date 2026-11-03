import falCatalog from "./catalog/fal.json" with { type: "json" };
import openRouterCatalog from "./catalog/openrouter.json" with { type: "json" };
import { HAND_MODELS } from "./hand";
import { assertRegistry, parseModel } from "./parse";
import { isImage, isVideo, type ImageModel, type ModelEntry, type StudioProviderId, type VideoModel } from "./types";

interface CatalogFile {
  models?: unknown[];
}

function fromCatalog(file: CatalogFile): ModelEntry[] {
  return (file.models ?? []).map(parseModel);
}

/** Hand-written ModelArk and ArgoLink entries, then the generated fal and OpenRouter catalogs. */
export const MODELS: readonly ModelEntry[] = [
  ...HAND_MODELS,
  ...fromCatalog(falCatalog),
  ...fromCatalog(openRouterCatalog),
];

assertRegistry(MODELS);

export function getModel(id: string): ModelEntry | undefined {
  return MODELS.find((model) => model.id === id);
}

export function getImageModel(id: string): ImageModel | undefined {
  const model = getModel(id);
  return model && isImage(model) ? model : undefined;
}

export function modelName(id: string) {
  return getModel(id)?.name ?? id;
}

/** Video models the studio can run on this provider, in catalog order. */
export function modelsFor(provider: StudioProviderId): VideoModel[] {
  return MODELS.filter(isVideo).filter((model) => model.routes.some((route) => route.provider === provider));
}

/** Image models that run through ArgoLink. fal image routes stay in the registry only. */
export function imageModels(): ImageModel[] {
  return MODELS.filter(isImage).filter((model) => model.routes.some((route) => route.provider === "argolink"));
}

export function routeFor<T extends ModelEntry>(model: T, provider: string) {
  return model.routes.find((route) => route.provider === provider);
}

export { estimateCost, nearestRatio, ratioAllowed } from "./price";
export { mentionSyntax } from "./syntax";
export { imageRequestError, videoRequestError } from "./validate";
export { assertRegistry, parseModel } from "./parse";
export {
  isImage,
  isStudioProvider,
  isVideo,
  MAPPER_IDS,
  MODELARK_REGIONS,
  PROVIDER_INFO,
  ROUTE_PROVIDERS,
} from "./types";
export type {
  DurationCap,
  EstimateInput,
  ImageCapabilities,
  ImageModel,
  ImagePrice,
  ImageQuality,
  ImageResolution,
  MapperId,
  ModelEntry,
  PriceFormula,
  ProviderId,
  RefLimits,
  Route,
  RouteProvider,
  StudioProviderId,
  TaskKind,
  VideoCapabilities,
  VideoModel,
  VideoPrice,
  VideoTask,
} from "./types";
