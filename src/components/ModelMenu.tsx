"use client";

import { useState } from "react";
import { Check } from "@/components/ui/Icon";
import { estimateRouteCost, PROVIDER_INFO, type EstimateInput, type RouteProvider, type VideoModel } from "@/lib/registry";
import { availabilityFor, availabilityHint, routeProviders } from "@/lib/registry/availability";
import { groupByFamily, modelBadges } from "@/lib/registry/badges";
import { UnlockHint } from "./UnlockHint";

function providerLabel(id: string | undefined) {
  if (id === "modelark" || id === "argolink" || id === "fal" || id === "openrouter") return PROVIDER_INFO[id].label;
  return "";
}

function money(amount: number | undefined) {
  if (amount === undefined) return "";
  return `~$${amount < 0.1 ? amount.toFixed(3) : amount.toFixed(2)}`;
}

/** Every video model. Unavailable ones stay in the list, grayed, and can't be chosen. */
export function ModelMenu({
  models,
  value,
  route,
  estimate,
  keyed,
  onChange,
  onRoute,
  onOpenKeys,
}: {
  models: readonly VideoModel[];
  value: string;
  route?: string;
  estimate?: EstimateInput;
  keyed: ReadonlySet<string>;
  onChange: (id: string) => void;
  onRoute: (provider: RouteProvider) => void;
  onOpenKeys: () => void;
}) {
  const [hover, setHover] = useState<string | null>(null);

  return (
    <div
      data-testid="model-picker"
      role="listbox"
      aria-label="Model"
      className="@container max-h-56 space-y-0.5 overflow-y-auto rounded-xl border border-white/10 bg-white/[0.03] p-1"
    >
      {groupByFamily(models).map((group) => (
        <div key={group.family} data-testid="model-family" data-family={group.family}>
          <p className="px-2.5 pt-2 pb-0.5 text-[10px] font-medium tracking-wide text-zinc-500 uppercase">{group.family}</p>
          {group.models.map((model) => {
        const open = availabilityFor(routeProviders(model.routes), keyed);
        const locked = !open.available;
        const hint = availabilityHint(open.needs);
        const selected = model.id === value;
        const badges = modelBadges(model);
        return (
          <div
            key={model.id}
            onMouseEnter={() => setHover(model.id)}
            onMouseLeave={() => setHover((current) => (current === model.id ? null : current))}
          >
            <button
              type="button"
              role="option"
              data-testid="model-option"
              data-available={locked ? "false" : "true"}
              aria-selected={selected}
              aria-disabled={locked}
              onClick={() => {
                if (locked) {
                  setHover(model.id);
                  return;
                }
                onChange(model.id);
              }}
              className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm ${
                locked
                  ? "cursor-not-allowed text-zinc-500"
                  : selected
                    ? "bg-white/10 text-white"
                    : "text-zinc-200 hover:bg-white/5"
              } ${selected && locked ? "bg-white/5" : ""}`}
            >
              <span className="min-w-0 flex-1 truncate">{model.name}</span>
              {badges.length > 0 && (
                // A narrow panel drops the badges so model names stay readable.
                <span className="hidden shrink-0 gap-1 @[21rem]:flex">
                  {badges.map((badge) => (
                    <span
                      key={badge.id}
                      data-testid="model-badge"
                      data-badge={badge.id}
                      className={`rounded px-1 py-px text-[9px] ${locked ? "bg-white/5 text-zinc-600" : "bg-white/10 text-zinc-400"}`}
                    >
                      {badge.label}
                    </span>
                  ))}
                </span>
              )}
              <span className={`shrink-0 text-[10px] ${locked ? "text-zinc-600" : "text-zinc-500"}`}>
                {selected && route && !locked
                  ? providerLabel(route)
                  : model.routes.length > 1
                    ? `${model.routes.length} routes`
                    : providerLabel(routeProviders(model.routes)[0])}
              </span>
              {selected && !locked && <Check className="size-3.5 shrink-0 text-accent" aria-hidden />}
            </button>
            {locked && hover === model.id && hint && (
              <div className="px-2.5 pb-1">
                <UnlockHint hint={hint} onOpen={onOpenKeys} />
              </div>
            )}
            {selected && !locked && model.routes.length > 1 && (
              <div data-testid="route-picker" className="space-y-0.5 px-2 pb-1.5">
                {model.routes.map((item) => {
                  const choice = availabilityFor([item.provider], keyed);
                  const blocked = !choice.available;
                  const picked = item.provider === route;
                  const cost = estimateRouteCost(model, item.provider, estimate);
                  return (
                    <button
                      key={item.provider}
                      type="button"
                      data-testid="route-option"
                      data-provider={item.provider}
                      data-available={blocked ? "false" : "true"}
                      aria-pressed={picked && !blocked}
                      onClick={() => {
                        if (blocked) {
                          onOpenKeys();
                          return;
                        }
                        onRoute(item.provider);
                      }}
                      className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs ${
                        blocked
                          ? "cursor-not-allowed text-zinc-600"
                          : picked
                            ? "bg-white/10 text-white"
                            : "text-zinc-300 hover:bg-white/5"
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate">{PROVIDER_INFO[item.provider].label}</span>
                      <span className="shrink-0 tabular-nums text-zinc-500">{money(cost)}</span>
                      {picked && !blocked && <span className="text-accent">✓</span>}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
          })}
        </div>
      ))}
    </div>
  );
}
