"use client";

// The Image tab's prompt bar: reference images, prompt, model and settings, Generate.

import { useRef } from "react";
import {
  estimateRouteCost,
  imageModels,
  imagePriceMegapixels,
  imageProviderFor,
  PROVIDER_INFO,
  ratioAllowed,
  type ImageModel,
  type ImageQuality,
  type ImageResolution,
  type RouteProvider,
} from "@/lib/registry";
import { availabilityFor, availabilityHint, routeProviders, sortByAvailability } from "@/lib/registry/availability";
import { groupByFamily } from "@/lib/registry/badges";
import { preferredRoute } from "@/lib/registry/routing";
import { invalidMentions, mentionToken } from "@/lib/mentions";
import { Dropdown } from "./Dropdown";
import { UnlockHint } from "./UnlockHint";
import { thumbSrc, type LibraryItem } from "./library";
import { UploadOverlay } from "./MediaBlocks";
import { PromptEditor, type PromptEditorHandle } from "./PromptEditor";

export interface ComposerState {
  model: ImageModel;
  prompt: string;
  ratio: string;
  resolution: ImageResolution;
  quality: ImageQuality;
  count: number;
  route?: string;
}

const QUALITY_LABEL: Record<ImageQuality, string> = { auto: "Auto", low: "Low", medium: "Medium", high: "High" };
const HAND_MODELS = imageModels();

function Mark({ mark }: { mark?: string }) {
  if (!mark) return null;
  return (
    <span className="font-bold text-accent" aria-hidden>
      {mark}
    </span>
  );
}

export function ImageComposer({
  state,
  onChange,
  references,
  onAddFiles,
  onRemoveReference,
  onOpenLibrary,
  onGenerate,
  submitting,
  error,
  keyed,
  routePreferences,
  defaultProvider,
  onSaveRoute,
  onOpenKeys,
  models = HAND_MODELS,
  autoRatio,
}: {
  state: ComposerState;
  onChange: (patch: Partial<ComposerState>) => void;
  references: LibraryItem[];
  /** Uploads and attaches files; resolves to the ones attached. */
  onAddFiles: (files: File[]) => Promise<LibraryItem[]>;
  onRemoveReference: (index: number) => void;
  onOpenLibrary: () => void;
  onGenerate: () => void;
  submitting: boolean;
  error: string | null;
  /** Providers this user has a key for. Names only. */
  keyed: ReadonlySet<string>;
  routePreferences?: Readonly<Record<string, string>>;
  defaultProvider?: string | null;
  onSaveRoute?: (modelId: string, provider: string) => void;
  onOpenKeys: () => void;
  /** Hand models plus fal image models from /api/models. */
  models?: readonly ImageModel[];
  /**
   * Nearest allowed ratio for the first reference when aspect is Auto.
   * The image route prices this same value.
   */
  autoRatio?: string;
}) {
  const { model, prompt, ratio, resolution, quality, count } = state;
  const route = preferredRoute(model, keyed, [
    state.route,
    routePreferences?.[model.id],
    imageProviderFor(defaultProvider, [...keyed]),
  ])?.provider;
  const caps = model.capabilities;
  const editor = useRef<PromptEditorHandle>(null);
  const input = useRef<HTMLInputElement>(null);
  const priceInput = { ratio, resolution, references: references.length, autoRatio };
  const megapixels = imagePriceMegapixels(model, priceInput);
  const cost =
    estimateRouteCost(model, route, { resolution, count, quality, referenceImages: references.length, megapixels }) ?? 0;
  const counts = { Image: references.length, Video: 0, Audio: 0 };
  const bad = invalidMentions(prompt, counts);
  const uploading = references.some((r) => r.status !== "ready");
  const modelAvail = availabilityFor(routeProviders(model.routes), keyed);
  const sorted = sortByAvailability(models, (item) => availabilityFor(routeProviders(item.routes), keyed).available);
  const overLimit = references.length > caps.references.image;
  const limitMessage = overLimit
    ? `${model.name} takes up to ${caps.references.image} reference image${caps.references.image === 1 ? "" : "s"}`
    : null;
  const canGenerate =
    !submitting && !uploading && !overLimit && modelAvail.available && prompt.trim().length > 0 && bad.length === 0;

  function changeModel(id: string) {
    const m = models.find((x) => x.id === id);
    if (!m || !availabilityFor(routeProviders(m.routes), keyed).available) return;
    const res = m.capabilities.resolutions.includes(resolution)
      ? resolution
      : ((m.capabilities.resolutions[0] as ImageResolution | undefined) ?? resolution);
    onChange({
      model: m,
      resolution: res,
      ratio: ratioAllowed(m, ratio, res) ? ratio : "auto",
      count: Math.min(count, m.capabilities.maxImages),
      quality: m.capabilities.qualities?.includes(quality) ? quality : (m.capabilities.qualities?.[0] ?? quality),
      route: undefined,
    });
  }

  function changeRoute(provider: RouteProvider) {
    if (!availabilityFor([provider], keyed).available) return;
    if (!model.routes.some((item) => item.provider === provider)) return;
    onChange({ route: provider });
    onSaveRoute?.(model.id, provider);
  }

  return (
    <div className="rounded-3xl border border-white/10 bg-panel/95 p-3 shadow-2xl shadow-black/60 backdrop-blur">
      {!modelAvail.available && (
        <div className="mb-3 px-1">
          <UnlockHint hint={availabilityHint(modelAvail.needs)} onOpen={onOpenKeys} />
        </div>
      )}

      <div className="flex gap-3">
        <div className="min-w-0 flex-1 space-y-2">
          {references.length > 0 && (
            <div className="flex flex-wrap gap-2 px-1 pt-1">
              {references.map((item, i) => (
                <div key={item.id} className="group relative size-16 overflow-hidden rounded-xl border border-white/10">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={thumbSrc(item)} alt={item.name} className="size-full object-cover" />
                  <UploadOverlay item={item} />
                  <button
                    onClick={() => editor.current?.insert(mentionToken("Image", i + 1))}
                    title="Insert into prompt"
                    className="absolute inset-x-0.5 bottom-0.5 rounded bg-black/70 text-[9px] hover:bg-accent hover:text-ink"
                  >
                    @Image {i + 1}
                  </button>
                  <button
                    onClick={() => onRemoveReference(i)}
                    aria-label={`Remove image ${i + 1}`}
                    className="absolute top-0.5 right-0.5 grid size-4 place-items-center rounded-full bg-black/70 text-[8px] opacity-0 group-hover:opacity-100"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          <PromptEditor
            ref={editor}
            value={prompt}
            onChange={(p) => onChange({ prompt: p })}
            onSubmit={() => canGenerate && onGenerate()}
            onPasteFiles={async (files) => {
              // Attach, then mention them where the cursor is.
              const before = references.length;
              const added = await onAddFiles(files);
              if (added.length)
                editor.current?.insert(added.map((_, k) => mentionToken("Image", before + k + 1)).join(" "));
            }}
            mentions={references.map((item, i) => ({
              token: mentionToken("Image", i + 1),
              kind: "Image" as const,
              n: i + 1,
              thumb: thumbSrc(item),
              detail: item.name,
            }))}
            counts={counts}
            placeholder={
              references.length
                ? "Change the broccoli in @Image 1 for… (type @ to reference)"
                : "Describe the image you want…"
            }
          />
          {bad.length > 0 && (
            <p className="px-1 text-xs text-red-300">
              {bad.join(", ")} {bad.length === 1 ? "doesn't" : "don't"} match an attached image
            </p>
          )}
          {limitMessage && (
            <p data-testid="reference-limit" className="px-1 text-xs text-red-300">
              {limitMessage}
            </p>
          )}
          {error && <p className="px-1 text-xs text-red-300">{error}</p>}

          <div className="flex flex-wrap items-center gap-1.5">
            <button
              onClick={() => input.current?.click()}
              title="Add reference images"
              className="grid size-9 place-items-center rounded-xl bg-white/[0.06] text-lg text-zinc-200 hover:bg-white/10"
            >
              ＋
            </button>
            <button
              onClick={onOpenLibrary}
              title="Pick from Uploads"
              className="h-9 rounded-xl bg-white/[0.06] px-3 text-sm text-zinc-200 hover:bg-white/10"
            >
              Uploads
            </button>
            <span className="mx-0.5 h-5 w-px bg-white/10" />
            <Dropdown
              title="Model"
              value={model.id}
              display={
                <>
                  <Mark mark={model.mark} /> {model.name} <span className="text-zinc-500">›</span>
                </>
              }
              options={groupByFamily(sorted).flatMap((group) =>
                group.models.map((m) => {
                  const open = availabilityFor(routeProviders(m.routes), keyed);
                  return {
                    value: m.id,
                    group: group.family,
                    label: (
                      <>
                        <Mark mark={m.mark} /> {m.name}
                      </>
                    ),
                    hint: open.available ? m.description : undefined,
                    disabled: !open.available,
                    unlock: open.available ? undefined : availabilityHint(open.needs),
                  };
                }),
              )}
              onChange={changeModel}
              onOpenKeys={onOpenKeys}
            />
            {model.routes.length > 1 &&
              model.routes.map((item) => {
                const choice = availabilityFor([item.provider], keyed);
                const blocked = !choice.available;
                const picked = item.provider === route;
                const each = estimateRouteCost(model, item.provider, { resolution, count: 1 });
                return (
                  <button
                    key={item.provider}
                    type="button"
                    data-testid="route-option"
                    data-provider={item.provider}
                    data-available={blocked ? "false" : "true"}
                    aria-pressed={picked && !blocked}
                    onClick={() => (blocked ? onOpenKeys() : changeRoute(item.provider))}
                    className={`h-9 rounded-xl px-2.5 text-xs ${
                      blocked
                        ? "cursor-not-allowed text-zinc-600"
                        : picked
                          ? "bg-white/15 text-white"
                          : "bg-white/[0.06] text-zinc-300 hover:bg-white/10"
                    }`}
                  >
                    {PROVIDER_INFO[item.provider].label}
                    {each !== undefined && <span className="ml-1 tabular-nums text-zinc-500">${each.toFixed(3)}</span>}
                  </button>
                );
              })}
            <Dropdown
              title="Aspect ratio"
              icon="⛶"
              value={ratio}
              options={caps.ratios.map((r) => ({
                value: r,
                label: r === "auto" ? "Auto" : r,
                hint: r === "auto" ? "Matches the first reference image" : undefined,
                disabled: !ratioAllowed(model, r, resolution),
              }))}
              onChange={(r) => onChange({ ratio: r })}
            />
            {caps.resolutions.length > 0 && (
              <Dropdown
                title="Resolution"
                icon="◇"
                value={resolution}
                options={caps.resolutions.map((r) => ({
                  value: r,
                  label: r.toUpperCase(),
                  hint: `$${(estimateRouteCost(model, route, { resolution: r, count: 1, quality, megapixels: imagePriceMegapixels(model, { ratio, resolution: r, references: references.length, autoRatio }) }) ?? 0).toFixed(3)} per image`,
                }))}
                onChange={(r) =>
                  onChange({
                    resolution: r as ImageResolution,
                    ratio: ratioAllowed(model, ratio, r) ? ratio : "auto",
                  })
                }
              />
            )}
            {caps.qualities && (
              <Dropdown
                title="Quality"
                icon="✦"
                value={quality}
                options={caps.qualities.map((q) => ({ value: q, label: QUALITY_LABEL[q] }))}
                onChange={(q) => onChange({ quality: q })}
              />
            )}
            <div className="flex h-9 items-center rounded-xl bg-white/[0.06] text-sm text-zinc-200">
              <button
                onClick={() => onChange({ count: Math.max(1, count - 1) })}
                disabled={count <= 1}
                aria-label="Fewer images"
                className="px-2.5 disabled:opacity-30"
              >
                −
              </button>
              <span className="tabular-nums">
                {count}/{caps.maxImages}
              </span>
              <button
                onClick={() => onChange({ count: Math.min(caps.maxImages, count + 1) })}
                disabled={count >= caps.maxImages}
                aria-label="More images"
                className="px-2.5 disabled:opacity-30"
              >
                +
              </button>
            </div>
          </div>
        </div>

        <button
          type="button"
          data-testid="generate"
          onClick={onGenerate}
          disabled={!canGenerate}
          className={`flex w-32 shrink-0 flex-col items-center justify-center rounded-2xl transition disabled:cursor-not-allowed ${
            modelAvail.available
              ? "bg-accent text-ink shadow-lg shadow-accent/20 hover:brightness-105 disabled:opacity-40"
              : "cursor-not-allowed bg-white/10 text-zinc-500"
          }`}
        >
          <span className="text-sm font-bold tracking-wide uppercase">{submitting ? "Starting…" : "Generate"}</span>
          <span className="text-xs opacity-70">~${cost.toFixed(cost < 0.1 ? 3 : 2)}</span>
        </button>
      </div>

      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          void onAddFiles([...(e.target.files ?? [])]);
          e.target.value = "";
        }}
      />
    </div>
  );
}
