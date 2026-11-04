// Which route a model runs on. Availability still decides locked vs open;
// this only orders the routes the user can already reach.

import { availableRoute } from "./availability";
import { routeFor } from "./index";
import { isStudioProvider, type Route } from "./types";

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
 * Null when this provider may be stored for this catalog model.
 * Video preferences are studio routes only. fal on a video model is not one:
 * the generation's route (preset.route) is what Reuse resends, and Reuse does not save it.
 */
export function routeChoiceError(
  model: { group?: string; routes: readonly { provider: string }[] } | undefined,
  provider: string,
): string | null {
  if (!model) return "Unknown model";
  if (!model.routes.some((route) => route.provider === provider)) return "That model has no route on this provider";
  if (model.group === "video" && !isStudioProvider(provider)) return "That model has no stored route on this provider";
  return null;
}
