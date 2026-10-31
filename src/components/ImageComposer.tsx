"use client";

// The Image tab's prompt bar: reference images, prompt, model and settings, Generate.

import { useRef } from "react";
import {
  estimateImageCost,
  IMAGE_MODELS,
  ratioAllowed,
  type ImageModelSpec,
  type ImageProviderId,
  type ImageQuality,
  type ImageResolution,
} from "@/lib/imageModels";
import { invalidMentions, mentionToken } from "@/lib/mentions";
import { PROVIDER_INFO } from "@/lib/models";
import { Dropdown } from "./Dropdown";
import { thumbSrc, type LibraryItem } from "./library";
import { UploadOverlay } from "./MediaBlocks";
import { PromptEditor, type PromptEditorHandle } from "./PromptEditor";

export interface ComposerState {
  model: ImageModelSpec;
  prompt: string;
  ratio: string;
  resolution: ImageResolution;
  quality: ImageQuality;
  count: number;
}

const QUALITY_LABEL: Record<ImageQuality, string> = { auto: "Auto", low: "Low", medium: "Medium", high: "High" };

function BrandMark({ brand }: { brand: ImageModelSpec["brand"] }) {
  return brand === "google" ? (
    <span className="font-bold text-accent">G</span>
  ) : (
    <span className="text-accent" aria-hidden>
      ✺
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
  provider,
  onOpenKeys,
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
  /** Whose key image jobs run on; undefined until the workspace has an ArgoLink or OpenRouter key. */
  provider: ImageProviderId | undefined;
  onOpenKeys: () => void;
}) {
  const { model, prompt, ratio, resolution, quality, count } = state;
  const editor = useRef<PromptEditorHandle>(null);
  const input = useRef<HTMLInputElement>(null);
  const needsKey = !provider;
  const cost = estimateImageCost(model, resolution, count, provider);
  const counts = { Image: references.length, Video: 0, Audio: 0 };
  const bad = invalidMentions(prompt, counts);
  const uploading = references.some((r) => r.status !== "ready");
  const canGenerate = !submitting && !uploading && !needsKey && prompt.trim().length > 0 && bad.length === 0;

  function changeModel(id: string) {
    const m = IMAGE_MODELS.find((x) => x.id === id)!;
    const res = m.resolutions.includes(resolution) ? resolution : m.resolutions[0];
    onChange({
      model: m,
      resolution: res,
      ratio: ratioAllowed(m, ratio, res) ? ratio : "auto",
      count: Math.min(count, m.maxImages),
    });
  }

  return (
    <div className="rounded-3xl border border-white/10 bg-panel/95 p-3 shadow-2xl shadow-black/60 backdrop-blur">
      {needsKey && (
        <div className="mb-3 flex items-center gap-3 rounded-2xl bg-accent/10 px-4 py-2.5 text-sm">
          <span className="flex-1 text-zinc-200">
            Image models run through ArgoLink or OpenRouter. Add one of their API keys to start.
          </span>
          <button onClick={onOpenKeys} className="rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-ink">
            Add key
          </button>
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
                  <BrandMark brand={model.brand} /> {model.label} <span className="text-zinc-500">›</span>
                </>
              }
              options={IMAGE_MODELS.map((m) => ({
                value: m.id,
                label: (
                  <>
                    <BrandMark brand={m.brand} /> {m.label}
                  </>
                ),
                hint: m.description,
              }))}
              onChange={changeModel}
            />
            <Dropdown
              title="Aspect ratio"
              icon="⛶"
              value={ratio}
              options={model.ratios.map((r) => ({
                value: r,
                label: r === "auto" ? "Auto" : r,
                hint: r === "auto" ? "Matches the first reference image" : undefined,
                disabled: !ratioAllowed(model, r, resolution),
              }))}
              onChange={(r) => onChange({ ratio: r })}
            />
            <Dropdown
              title="Resolution"
              icon="◇"
              value={resolution}
              options={model.resolutions.map((r) => ({
                value: r,
                label: r.toUpperCase(),
                hint: `${provider === "openrouter" ? "~" : ""}$${model.price[provider ?? "argolink"][r]} per image`,
              }))}
              onChange={(r) => onChange({ resolution: r, ratio: ratioAllowed(model, ratio, r) ? ratio : "auto" })}
            />
            {model.qualities && (
              <Dropdown
                title="Quality"
                icon="✦"
                value={quality}
                options={model.qualities.map((q) => ({ value: q, label: QUALITY_LABEL[q] }))}
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
                {count}/{model.maxImages}
              </span>
              <button
                onClick={() => onChange({ count: Math.min(model.maxImages, count + 1) })}
                disabled={count >= model.maxImages}
                aria-label="More images"
                className="px-2.5 disabled:opacity-30"
              >
                +
              </button>
            </div>
          </div>
        </div>

        <button
          onClick={onGenerate}
          disabled={!canGenerate}
          className="flex w-32 shrink-0 flex-col items-center justify-center rounded-2xl bg-accent text-ink shadow-lg shadow-accent/20 transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <span className="text-sm font-bold tracking-wide uppercase">{submitting ? "Starting…" : "Generate"}</span>
          <span className="text-xs opacity-70" title={provider && `Billed by ${PROVIDER_INFO[provider].label}`}>
            ~${cost.toFixed(cost < 0.1 ? 3 : 2)}
          </span>
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
