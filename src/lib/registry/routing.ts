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

/** Null when this provider is a real route of a known catalog model. */
export function routeChoiceError(
  model: { routes: readonly { provider: string }[] } | undefined,
  provider: string,
): string | null {
  if (!model) return "Unknown model";
  if (!model.routes.some((route) => route.provider === provider)) return "That model has no route on this provider";
  return null;
}
