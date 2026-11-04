// Which route a model runs on. Availability still decides locked vs open;
// this only orders the routes the user can already reach.

import { availableRoute } from "./availability";
import { routeFor } from "./index";
import type { Route } from "./types";

/** First choice that is keyed and is one of the model's routes, else the first keyed route. */
export function preferredRoute<T extends { routes: readonly Route[] }>(
  model: T,
  keyed: ReadonlySet<string>,
  choices: readonly (string | null | undefined)[],
) {
  for (const choice of choices) {
    if (!choice || !keyed.has(choice)) continue;
    const route = routeFor(model, choice);
    if (route) return route;
  }
  return availableRoute(model, keyed);
}

/**
 * One row per product. A later catalog entry is dropped when every one of its
 * routes is already on an earlier model (Seedance on ModelArk also lists the
 * ArgoLink, OpenRouter, and fal endpoints).
 */
export function pickerModels<T extends { routes: readonly { provider: string; endpoint: string }[] }>(
  models: readonly T[],
): T[] {
  const covered = new Set<string>();
  const out: T[] = [];
  for (const model of models) {
    const keys = model.routes.map((route) => `${route.provider}:${route.endpoint}`);
    if (keys.length > 0 && keys.every((key) => covered.has(key))) continue;
    out.push(model);
    for (const key of keys) covered.add(key);
  }
  return out;
}

/**
 * Reuse selects the picker row that owns this generation's route.
 * Older rows stored the provider-specific model id; that id still resolves.
 */
export function reuseSelection<T extends { id: string; routes: readonly { provider: string; endpoint: string }[] }>(
  catalog: readonly T[],
  modelId: string,
  route: string | null | undefined,
): { id: string; route?: string } {
  const shown = pickerModels(catalog);
  if (shown.some((model) => model.id === modelId)) return { id: modelId, ...(route ? { route } : {}) };
  const source = catalog.find((model) => model.id === modelId);
  const from = source?.routes.find((item) => item.provider === route) ?? source?.routes[0];
  if (!from) return { id: modelId, ...(route ? { route } : {}) };
  const host = shown.find((model) =>
    model.routes.some((item) => item.provider === from.provider && item.endpoint === from.endpoint),
  );
  return host ? { id: host.id, route: from.provider } : { id: modelId, ...(route ? { route } : {}) };
}
