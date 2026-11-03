"use client";

import { useState } from "react";
import { PROVIDER_INFO, type VideoModel } from "@/lib/registry";
import { availability, availabilityHint, routeProviders } from "@/lib/registry/availability";
import { UnlockHint } from "./UnlockHint";

/** Every video model. Unavailable ones stay in the list, grayed, and can't be chosen. */
export function ModelMenu({
  models,
  value,
  keyed,
  onChange,
  onOpenKeys,
}: {
  models: readonly VideoModel[];
  value: string;
  keyed: ReadonlySet<string>;
  onChange: (id: string) => void;
  onOpenKeys: () => void;
}) {
  const [hover, setHover] = useState<string | null>(null);

  return (
    <div
      data-testid="model-picker"
      role="listbox"
      aria-label="Model"
      className="max-h-56 space-y-0.5 overflow-y-auto rounded-xl border border-white/10 bg-white/[0.03] p-1"
    >
      {models.map((model) => {
        const open = availability(model, keyed);
        const locked = !open.available;
        const hint = availabilityHint(open.needs);
        const selected = model.id === value;
        const showHint = locked && hover === model.id && !!hint;
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
              <span className={`shrink-0 text-[10px] ${locked ? "text-zinc-600" : "text-zinc-500"}`}>
                {routeProviders(model.routes)
                  .map((provider) => PROVIDER_INFO[provider].label)
                  .join(" · ")}
              </span>
              {selected && !locked && <span className="text-accent">✓</span>}
            </button>
            {showHint && (
              <div className="px-2.5 pb-1">
                <UnlockHint hint={hint} onOpen={onOpenKeys} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
