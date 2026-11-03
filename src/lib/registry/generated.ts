// fal and OpenRouter catalogs. Server and tests only — client components import
// ./index, which is the hand-written ModelArk and ArgoLink entries.

import falCatalog from "./catalog/fal.json" with { type: "json" };
import openRouterCatalog from "./catalog/openrouter.json" with { type: "json" };
import { routeProviders, type CatalogTool } from "./availability";
import { HAND_MODELS } from "./hand";
import { assertRegistry, parseModel } from "./parse";
import { isVideo, type ModelEntry, type VideoModel } from "./types";

interface CatalogFile {
  models?: unknown[];
}

function fromCatalog(file: CatalogFile): ModelEntry[] {
  return (file.models ?? []).map(parseModel);
}

export const GENERATED_MODELS: readonly ModelEntry[] = [
  ...fromCatalog(falCatalog as CatalogFile),
  ...fromCatalog(openRouterCatalog as CatalogFile),
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
    .map(slimVideo);
}

const TOOL_TASKS = ["upscale", "extend", "lipsync", "avatar", "motion"] as const;

const TOOL_LABEL: Record<(typeof TOOL_TASKS)[number], string> = {
  upscale: "Upscale",
  extend: "Extend",
  lipsync: "Lipsync",
  avatar: "Avatar",
  motion: "Motion",
};

function hasTask(model: ModelEntry, task: string) {
  return model.task === task || (model.tasks as readonly string[]).includes(task);
}

/** One chip per tool task, with the providers that can run it. Endpoints stay on the server. */
export function toolMenu(): CatalogTool[] {
  return TOOL_TASKS.flatMap((task) => {
    const providers = routeProviders(ALL_MODELS.filter((model) => hasTask(model, task)).flatMap((model) => model.routes));
    if (!providers.length) return [];
    return [{ task, label: TOOL_LABEL[task], providers }];
  });
}

function slimVideo(model: VideoModel): VideoModel {
  const description = model.description.length > 240 ? `${model.description.slice(0, 239)}…` : model.description;
  return {
    id: model.id,
    family: model.family,
    name: model.name,
    description,
    group: "video",
    task: model.task,
    tasks: model.tasks,
    routes: model.routes.filter((route) => route.provider === "openrouter"),
    promptRequired: model.promptRequired,
    refSyntax: model.refSyntax,
    ...(model.mark ? { mark: model.mark } : {}),
    capabilities: model.capabilities,
    ...(model.price ? { price: model.price } : {}),
  };
}
