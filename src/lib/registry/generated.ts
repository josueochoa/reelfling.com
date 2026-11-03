// fal and OpenRouter catalogs. Server and tests only — client components import
// ./index, which is the hand-written ModelArk and ArgoLink entries.

import falCatalog from "./catalog/fal.json" with { type: "json" };
import openRouterCatalog from "./catalog/openrouter.json" with { type: "json" };
import { HAND_MODELS } from "./hand";
import { assertRegistry, parseModel } from "./parse";
import type { ModelEntry } from "./types";

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
