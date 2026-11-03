// Whether a model, tool, or mode can run. Pure: the providers on its real catalog
// routes, plus the set of providers that have a key. No key material.

import { PROVIDER_INFO, ROUTE_PROVIDERS, routeFor } from "./index";
import type { ProviderId, Route, RouteProvider } from "./types";

export interface Availability {
  available: boolean;
  /** Providers that would unlock this item, in catalog order. Empty when it is available. */
  needs: RouteProvider[];
}

export interface CatalogTool {
  task: string;
  label: string;
  /** Providers that have a real catalog route for this task. */
  providers: RouteProvider[];
}

/** Providers named on these routes, in catalog order, without duplicates. */
export function routeProviders(routes: readonly { provider: string }[]): RouteProvider[] {
  const present = new Set(routes.map((route) => route.provider));
  return ROUTE_PROVIDERS.filter((provider) => present.has(provider));
}

/** Available when at least one of these providers is in the keyed set. */
export function availabilityFor(providers: readonly string[], keyed: ReadonlySet<string>): Availability {
  const names = routeProviders(providers.map((provider) => ({ provider })));
  if (names.some((provider) => keyed.has(provider))) return { available: true, needs: [] };
  return { available: false, needs: names };
}

/** First keyed route on the model. `prefer` wins when that provider is keyed and the model routes there. */
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

export function hasTask(model: { task: string; tasks: readonly string[] }, task: string) {
  return model.task === task || model.tasks.includes(task);
}

function displayName(provider: string): string {
  return provider in PROVIDER_INFO ? PROVIDER_INFO[provider as ProviderId].label : provider;
}

function article(name: string): "a" | "an" {
  return /^[aeiou]/i.test(name) ? "an" : "a";
}

function providerList(providers: readonly string[]): string {
  const names = providers.map(displayName);
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} or ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

/** Hover text. Display names only, for example "needs a fal or OpenRouter key". */
export function availabilityHint(needs: readonly string[]): string {
  if (!needs.length) return "";
  return `needs ${article(displayName(needs[0]))} ${providerList(needs)} key`;
}

/** Server error. Same names as the hint, and nothing else. */
export function availabilityError(needs: readonly string[]): string {
  if (!needs.length) return "This isn't available.";
  return `This needs ${article(displayName(needs[0]))} ${providerList(needs)} key.`;
}

/** Null when the mode can run, or when no key would unlock it (the model simply lacks it). */
export function modeBlock(
  model: { routes: readonly Route[]; capabilities: { references: { total: number } } },
  mode: "frames" | "references",
  keyed: ReadonlySet<string>,
): string | null {
  const result = availabilityFor(routeProviders(modeRoutes(model, mode)), keyed);
  if (result.available || result.needs.length === 0) return null;
  return availabilityError(result.needs);
}

export function sortByAvailability<T>(items: readonly T[], isOpen: (item: T) => boolean): T[] {
  return [...items.filter(isOpen), ...items.filter((item) => !isOpen(item))];
}
