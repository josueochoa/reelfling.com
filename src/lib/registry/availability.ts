// Whether a model, tool, or mode can run. Pure: routes plus the set of providers
// that have a key. The UI and the server both call this. No key material.

import { routeFor, ROUTE_PROVIDERS } from "./index";
import type { Route, RouteProvider } from "./types";

export interface Availability {
  available: boolean;
  /** Providers that would unlock this item, in catalog order. Empty when it is available. */
  needs: RouteProvider[];
}

export interface CatalogTool {
  task: string;
  label: string;
  providers: RouteProvider[];
}

/** Providers named on these routes, in catalog order, without duplicates. */
export function routeProviders(routes: readonly { provider: string }[]): RouteProvider[] {
  const present = new Set(routes.map((route) => route.provider));
  return ROUTE_PROVIDERS.filter((provider) => present.has(provider));
}

/**
 * Routes used only to ask "which providers would unlock this?".
 * Availability reads the provider. It does not call the endpoint.
 */
export function routesForProviders(providers: readonly string[]): Route[] {
  return routeProviders(providers.map((provider) => ({ provider }))).map((provider) => ({
    provider,
    endpoint: provider,
    mapper: "fal.queue",
  }));
}

/** The fal tab. Any endpoint still needs a fal key; the id here is not called. */
export const FAL_ROUTES: readonly Route[] = routesForProviders(["fal"]);

/**
 * Available when `routeFor` finds a route for at least one keyed provider.
 * Otherwise `needs` lists every route provider, which is what the hint names.
 */
export function availability(model: { routes: readonly Route[] }, keyed: ReadonlySet<string>): Availability {
  const providers = routeProviders(model.routes);
  const usable = providers.filter((provider) => keyed.has(provider) && routeFor(model, provider));
  if (usable.length > 0) return { available: true, needs: [] };
  return { available: false, needs: providers };
}

/** First keyed route. `prefer` wins when that provider is keyed and the model routes there. */
export function availableRoute<T extends { routes: readonly Route[] }>(
  model: T,
  keyed: ReadonlySet<string>,
  prefer?: string | null,
) {
  if (prefer && keyed.has(prefer)) {
    const preferred = routeFor(model, prefer);
    if (preferred) return preferred;
  }
  for (const provider of routeProviders(model.routes)) {
    if (!keyed.has(provider)) continue;
    const route = routeFor(model, provider);
    if (route) return route;
  }
  return undefined;
}

/** References use the model's routes only when the model accepts them. Frames always do. */
export function modeRoutes(
  model: { routes: readonly Route[]; capabilities: { references: { total: number } } },
  mode: "frames" | "references",
): readonly Route[] {
  if (mode === "references" && model.capabilities.references.total <= 0) return [];
  return model.routes;
}

function providerList(providers: readonly string[]): string {
  if (providers.length <= 1) return providers[0] ?? "";
  if (providers.length === 2) return `${providers[0]} or ${providers[1]}`;
  return `${providers.slice(0, -1).join(", ")} or ${providers[providers.length - 1]}`;
}

/** "an" before a vowel, "a" otherwise. The first provider name decides. */
function article(provider: string): "a" | "an" {
  return /^[aeiou]/i.test(provider) ? "an" : "a";
}

/** Hover text. Names providers only, for example "needs a fal or openrouter key". */
export function availabilityHint(needs: readonly string[]): string {
  if (!needs.length) return "";
  return `needs ${article(needs[0])} ${providerList(needs)} key`;
}

/** Server error. Same providers as the hint, and nothing else. */
export function availabilityError(needs: readonly string[]): string {
  if (!needs.length) return "This isn't available.";
  return `This needs ${article(needs[0])} ${providerList(needs)} key.`;
}

/** Null when the mode can run, or when no key would unlock it (the model simply lacks it). */
export function modeBlock(
  model: { routes: readonly Route[]; capabilities: { references: { total: number } } },
  mode: "frames" | "references",
  keyed: ReadonlySet<string>,
): string | null {
  const result = availability({ routes: modeRoutes(model, mode) }, keyed);
  if (result.available || result.needs.length === 0) return null;
  return availabilityError(result.needs);
}

/** Workspace keys, plus the member's own key only when the owner allows it. */
export function keyedProviders(input: {
  workspaceProviders: readonly string[];
  personalProviders?: readonly string[];
  memberKeys?: boolean;
}): Set<string> {
  const keyed = new Set(input.workspaceProviders);
  if (input.memberKeys) {
    for (const provider of input.personalProviders ?? []) keyed.add(provider);
  }
  return keyed;
}

/** The keyed set for the account payload the browser already holds (provider names only). */
export function keyedForAccount(account: {
  keys: readonly { provider: string }[];
  personalKeys: readonly { provider: string }[];
  workspace: { kind: string; memberKeys: boolean };
}): Set<string> {
  return keyedProviders({
    workspaceProviders: account.keys.map((key) => key.provider),
    personalProviders: account.personalKeys.map((key) => key.provider),
    memberKeys: account.workspace.kind === "team" && account.workspace.memberKeys,
  });
}

export function sortByAvailability<T>(items: readonly T[], isOpen: (item: T) => boolean): T[] {
  return [...items.filter(isOpen), ...items.filter((item) => !isOpen(item))];
}

export interface HeldProviders {
  keyed: ReadonlySet<string>;
  workspace: ReadonlySet<string>;
  personal: ReadonlySet<string>;
}

/** Which stored key runs this route. Requested source wins when that side actually has it. */
export function preferredSource(input: {
  team: boolean;
  memberKeys: boolean;
  requested?: "team" | "member" | null;
  workspaceHas: boolean;
  personalHas: boolean;
}): "team" | "member" {
  if (!input.team) return "member";
  if (input.requested === "member" && input.memberKeys && input.personalHas) return "member";
  if (input.workspaceHas) return "team";
  if (input.memberKeys && input.personalHas) return "member";
  return "team";
}

/** The route to call, or a 400 whose message names providers only. */
export function pickRoute<T extends { routes: readonly Route[] }>(
  model: T,
  held: HeldProviders,
  opts: {
    team: boolean;
    memberKeys: boolean;
    requested?: "team" | "member" | null;
    prefer?: string | null;
  },
): { route: Route; source: "team" | "member" } {
  const result = availability(model, held.keyed);
  const route = result.available ? availableRoute(model, held.keyed, opts.prefer) : undefined;
  if (!route) throw Object.assign(new Error(availabilityError(result.needs)), { status: 400 });
  return {
    route,
    source: preferredSource({
      team: opts.team,
      memberKeys: opts.memberKeys,
      requested: opts.requested,
      workspaceHas: held.workspace.has(route.provider),
      personalHas: held.personal.has(route.provider),
    }),
  };
}
