// fal and OpenRouter catalogs, plus hand-checked tools (catalog/upscale.json, catalog/extend.json).
// Server and tests only — client components import ./index, which is the hand-written
// ModelArk and ArgoLink entries. catalog:sync does not write upscale.json or extend.json.

import extendCatalog from "./catalog/extend.json" with { type: "json" };
import falCatalog from "./catalog/fal.json" with { type: "json" };
import openRouterCatalog from "./catalog/openrouter.json" with { type: "json" };
import upscaleCatalog from "./catalog/upscale.json" with { type: "json" };
import { HAND_MODELS } from "./hand";
import { assertRegistry, parseModel } from "./parse";
import { isImage, isVideo, type ImageModel, type ModelEntry, type VideoModel } from "./types";

interface CatalogFile {
  models?: unknown[];
}

function fromCatalog(file: CatalogFile): ModelEntry[] {
  return (file.models ?? []).map(parseModel);
}

export const GENERATED_MODELS: readonly ModelEntry[] = [
  ...fromCatalog(falCatalog as CatalogFile),
  ...fromCatalog(openRouterCatalog as CatalogFile),
  ...fromCatalog(upscaleCatalog as CatalogFile),
  ...fromCatalog(extendCatalog as CatalogFile),
];

/** Hand-written entries plus the generated catalogs. */
export const ALL_MODELS: readonly ModelEntry[] = [...HAND_MODELS, ...GENERATED_MODELS];

assertRegistry(ALL_MODELS);

export function catalogModel(id: string): ModelEntry | undefined {
  return ALL_MODELS.find((model) => model.id === id);
}

/** Shown first in the video picker. The rest stay in catalog order. */
const PICKER_FIRST = [
  "openrouter:bytedance/seedance-2.5",
  "openrouter:kwaivgi/kling-v3.0-pro",
  "openrouter:google/veo-3.1-fast",
];

/**
 * OpenRouter video models for the studio picker. Descriptions are shortened and
 * fal routes are dropped, so the client never imports the catalog JSON.
 */
export function openRouterPickerModels(): VideoModel[] {
  const rank = (id: string) => {
    const at = PICKER_FIRST.indexOf(id);
    return at === -1 ? PICKER_FIRST.length : at;
  };
  return ALL_MODELS.filter(isVideo)
    .filter((model) => model.routes.some((route) => route.provider === "openrouter"))
    .slice()
    .sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id))
    .map((model) => slimVideo(model, "openrouter"));
}

/**
 * fal video endpoints whose queue body was checked against the published OpenAPI
 * schema (no key, 4 Nov 2026). Every other fal video route is refused before
 * storage, key lookup, or a provider call.
 * These still do not match a checked body and stay out:
 * fal-ai/kling-video/v3/pro/text-to-video, fal-ai/wan/v2.2-a14b/text-to-video,
 * fal-ai/minimax/video-01/image-to-video.
 * alibaba/wan-3.0/reference-to-video is included: its body uses reference_image_urls,
 * reference_video_urls, and reference_audio_urls, which is what that schema publishes.
 */
export const FAL_VIDEO_ENDPOINTS = new Set<string>([
  "kling/v4/text-to-video",
  "kling/v4/image-to-video",
  "kling/v4/reference-to-video",
  "fal-ai/kling-video/v3/pro/image-to-video",
  "alibaba/wan-3.0/text-to-video",
  "alibaba/wan-3.0/image-to-video",
  "alibaba/wan-3.0/reference-to-video",
  "minimax/h3/text-to-video",
  "minimax/h3/image-to-video",
  "minimax/h3/reference-to-video",
  "blackforestlabs/flux-3/image-to-video",
  "google/gemini-omni-flash/v1.1/text-to-video",
  "google/gemini-omni-flash/v1.1/image-to-video",
  "google/gemini-omni-flash/v1.1/reference-to-video",
  "xai/grok-imagine-video/v1.5/image-to-video",
  "luma/agent/ray/v3.2/image-to-video",
]);

/** fal image endpoints whose input mapping was checked the same way. */
export const FAL_IMAGE_ENDPOINTS = new Set<string>([
  "bytedance/seedream/v5/pro/text-to-image",
  "bytedance/seedream/v5/pro/edit",
  "fal-ai/flux-2-pro",
  "fal-ai/flux-2-pro/edit",
  "ideogram/v4.5",
  "fal-ai/recraft/v4.1/text-to-image",
  "xai/grok-imagine-image/v2.0/edit",
  "fal-ai/z-image/turbo",
]);

/** fal image models whose input mapping was checked. The catalog JSON stays on the server. */
export function catalogImageModels(): ImageModel[] {
  return ALL_MODELS.filter(isImage)
    .filter((model) => model.routes.some((route) => route.provider === "fal" && FAL_IMAGE_ENDPOINTS.has(route.endpoint)))
    .map(slimImage);
}

/** OpenRouter videos, plus fal videos whose input mapping was checked. */
export function catalogPickerModels(): VideoModel[] {
  const fal = ALL_MODELS.filter(isVideo).filter((model) =>
    model.routes.some((route) => route.provider === "fal" && FAL_VIDEO_ENDPOINTS.has(route.endpoint)),
  );
  return [...openRouterPickerModels(), ...fal.map((model) => slimVideo(model))];
}

function slimImage(model: ImageModel): ImageModel {
  const description = model.description.length > 240 ? `${model.description.slice(0, 239)}…` : model.description;
  return {
    id: model.id,
    family: model.family,
    name: model.name,
    description,
    group: "image",
    task: model.task,
    tasks: model.tasks,
    routes: model.routes,
    promptRequired: model.promptRequired,
    refSyntax: model.refSyntax,
    ...(model.mark ? { mark: model.mark } : {}),
    capabilities: model.capabilities,
    ...(model.price ? { price: model.price } : {}),
  };
}

function slimVideo(model: VideoModel, provider?: string): VideoModel {
  const description = model.description.length > 240 ? `${model.description.slice(0, 239)}…` : model.description;
  const routes = provider ? model.routes.filter((route) => route.provider === provider) : model.routes;
  return {
    id: model.id,
    family: model.family,
    name: model.name,
    description,
    group: "video",
    task: model.task,
    tasks: model.tasks,
    routes,
    promptRequired: model.promptRequired,
    refSyntax: model.refSyntax,
    ...(model.mark ? { mark: model.mark } : {}),
    capabilities: model.capabilities,
    ...(model.price ? { price: model.price } : {}),
  };
}
