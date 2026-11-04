import { HAND_MODELS } from "./hand";
import { assertRegistry } from "./parse";
import {
  isImage,
  isVideo,
  type ImageModel,
  type ModelEntry,
  type Route,
  type StudioProviderId,
  type VideoModel,
} from "./types";

/**
 * Models the studio offers. The generated fal and OpenRouter catalogs live in
 * ./generated and are not imported here, so they stay out of the client bundle.
 */
export const MODELS: readonly ModelEntry[] = HAND_MODELS;

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

/** Image models the Image tab can run. fal image routes stay in the registry only. */
export function imageModels(): ImageModel[] {
  return MODELS.filter(isImage).filter((model) =>
    model.routes.some((route) => route.provider === "argolink" || route.provider === "openrouter"),
  );
}

/** The route a model takes on one provider, if it has one. */
export function routeFor<T extends { routes: readonly Route[] }>(model: T, provider: string) {
  return model.routes.find((route) => route.provider === provider);
}

export {
  CAMERA_MOVE_MAX,
  cameraMoveLabel,
  cameraMovesFor,
  cameraPresets,
  cameraSummary,
  compileCamera,
  keptCameraMoves,
} from "./camera";
export {
  estimateCost,
  estimateRouteCost,
  imagePriceMegapixels,
  imageRequestAspect,
  nearestRatio,
  outputMegapixels,
  ratioAllowed,
} from "./price";
export { mentionSyntax } from "./syntax";
export { imageRequestError, videoRequestError } from "./validate";
export { assertRegistry, parseModel } from "./parse";
export {
  imageProviderFor,
  isImage,
  isStudioProvider,
  isVideo,
  MAPPER_IDS,
  MODELARK_REGIONS,
  PROVIDER_INFO,
  ROUTE_PROVIDERS,
} from "./types";
export type {
  CameraCapabilities,
  DurationCap,
  EstimateInput,
  ImageCapabilities,
  ImageKeyProvider,
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
