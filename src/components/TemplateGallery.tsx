"use client";

import { useSyncExternalStore, type KeyboardEvent } from "react";
import { moveIndex } from "@/components/ui/a11y";
import { useIsClient } from "@/components/ui/useIsClient";
import {
  CATEGORIES,
  categoryLabel,
  listTemplates,
  previewOf,
  type TemplateCategory,
  type VideoTemplate,
} from "@/lib/templates/templates";

export type FilterId = "all" | TemplateCategory;

const FILTERS: { id: FilterId; label: string }[] = [{ id: "all", label: "All" }, ...CATEGORIES];

function useReducedMotion() {
  return useSyncExternalStore(
    (onChange) => {
      const media = window.matchMedia("(prefers-reduced-motion: reduce)");
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  );
}

export function TemplateGallery({
  category,
  onCategory,
  selectedId,
  onSelect,
  onClose,
}: {
  category: FilterId;
  onCategory: (category: FilterId) => void;
  selectedId?: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const templates = listTemplates(category === "all" ? undefined : category);

  function onFilterKey(event: KeyboardEvent<HTMLDivElement>) {
    const current = FILTERS.findIndex((filter) => filter.id === category);
    const delta = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (!delta && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const next =
      event.key === "Home" ? 0 : event.key === "End" ? FILTERS.length - 1 : moveIndex(current, delta, FILTERS.length);
    const filter = FILTERS[next];
    if (!filter) return;
    onCategory(filter.id);
    document.getElementById(`template-filter-${filter.id}`)?.focus();
  }

  return (
    <div data-testid="template-gallery" className="min-h-0 flex-1 overflow-y-auto">
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-line bg-ink/80 px-6 py-4 backdrop-blur">
        <h1 className="text-title text-fg">Templates</h1>
        <button type="button" data-testid="close-templates" onClick={onClose} className="text-body text-fg-muted hover:text-fg">
          Close
        </button>
      </div>
      <div className="px-6 pt-4">
        <div role="radiogroup" aria-label="Category" className="flex flex-wrap gap-2" onKeyDown={onFilterKey}>
          {FILTERS.map((filter) => {
            const selected = category === filter.id;
            return (
              <button
                key={filter.id}
                id={`template-filter-${filter.id}`}
                type="button"
                role="radio"
                aria-checked={selected}
                tabIndex={selected ? 0 : -1}
                data-testid={`template-filter-${filter.id}`}
                onClick={() => onCategory(filter.id)}
                className={`rounded-full px-3 py-1.5 text-body ${
                  selected ? "bg-accent text-accent-fg" : "border border-line bg-panel text-fg hover:bg-surface-2"
                }`}
              >
                {filter.label}
              </button>
            );
          })}
        </div>
        <p className="mt-3 text-body text-fg-muted">
          {templates.length} {templates.length === 1 ? "template" : "templates"}
        </p>
      </div>
      <ul className="grid grid-cols-1 gap-4 p-6 sm:grid-cols-2 2xl:grid-cols-3">
        {templates.map((template) => (
          <li key={template.id}>
            <button
              type="button"
              data-testid={`template-card-${template.id}`}
              aria-pressed={selectedId === template.id}
              onClick={() => onSelect(template.id)}
              className={`flex w-full flex-col overflow-hidden rounded-lg border bg-panel text-left ${
                selectedId === template.id ? "border-accent" : "border-line hover:border-line-strong"
              }`}
            >
              <TemplatePreview template={template} />
              <span className="flex flex-col gap-1 px-3 py-3">
                <span className="text-label tracking-wide text-fg-muted uppercase">{categoryLabel(template.category)}</span>
                <span className="text-title text-fg">{template.name}</span>
                <span className="text-body text-fg-muted">{template.summary}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TemplatePreview({ template }: { template: VideoTemplate }) {
  const client = useIsClient();
  const reduced = useReducedMotion();
  const preview = previewOf(template);
  const showVideo = client && !reduced && !!preview.video;
  return (
    <span aria-hidden className="relative block aspect-video overflow-hidden bg-surface-3">
      {showVideo ? (
        <video
          src={preview.video}
          poster={preview.poster}
          muted
          loop
          autoPlay
          playsInline
          preload="metadata"
          className="size-full object-cover"
        />
      ) : preview.poster ? (
        // Poster files are ours. next/image needs a remote allowlist we don't have for these.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={preview.poster} alt="" className="size-full object-cover" />
      ) : (
        <TemplateFallback template={template} />
      )}
    </span>
  );
}

function TemplateFallback({ template }: { template: VideoTemplate }) {
  const wide = template.ratio === "16:9" || template.ratio === "21:9";
  return (
    <span data-testid={`template-fallback-${template.id}`} className="flex size-full flex-col justify-between p-4">
      <span className="flex items-center justify-between">
        <span className="text-label tracking-wide text-fg-muted uppercase">{categoryLabel(template.category)}</span>
        <span className={`h-1.5 rounded-full bg-accent ${wide ? "w-16" : "w-8"}`} />
      </span>
      <span className="flex items-end gap-2" data-motif={template.category}>
        {template.category === "effects" && (
          <>
            <span className="h-10 w-1 rounded-full bg-accent" />
            <span className="h-6 flex-1 rounded-sm bg-accent-soft" />
          </>
        )}
        {template.category === "product" && (
          <>
            <span className="size-10 rounded-md border border-line-strong bg-panel" />
            <span className="h-px flex-1 bg-line-strong" />
          </>
        )}
        {template.category === "ugc" && (
          <>
            <span className="size-10 rounded-full bg-accent-soft" />
            <span className="flex flex-1 flex-col gap-1.5">
              <span className="h-1.5 w-full rounded-full bg-line-strong" />
              <span className="h-1.5 w-2/3 rounded-full bg-line" />
            </span>
          </>
        )}
      </span>
    </span>
  );
}
