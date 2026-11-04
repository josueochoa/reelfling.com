"use client";

// The Image tab: generated images in a grid, with the prompt bar floating over it.

import { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Download, RotateCcw, X } from "@/components/ui/Icon";
import { Modal } from "@/components/ui/Modal";
import { Skeleton } from "@/components/ui/Skeleton";
import { confirmToast, toast } from "@/components/ui/Toast";
import { imageModels, imageProviderFor, nearestRatio, PROVIDER_INFO, ratioAllowed, type ImageModel } from "@/lib/registry";
import { preferredRoute } from "@/lib/registry/routing";
import type { ToolView } from "@/lib/toolTypes";
import type { ImageGeneration } from "@/lib/images";
import type { StudioTabHandle } from "./VideoStudio";
import { remapMentions } from "@/lib/mentions";
import { api, apiJson, type Me } from "./api";
import { ImageComposer, type ComposerState } from "./ImageComposer";
import { thumbSrc, type Library, type LibraryItem } from "./library";
import { UploadsPanel } from "./UploadsPanel";
import { Viewer } from "./Viewer";
import { imageDetails } from "./viewer/details";

const POLL_MS = 4000;
const pending = (g: ImageGeneration) => g.status === "queued" || g.status === "running";
const imageUrl = (g: ImageGeneration, i: number, download = false) =>
  `/api/images/${g.id}/file?i=${i}${download ? "&download" : ""}`;
const aspectStyle = (ratio?: string) => ({ aspectRatio: (ratio ?? "1:1").replace(":", " / ") });

/** Re-renders every second while something is generating, for the elapsed timers. */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/** Width/height of an image, for "auto" ratio from a reference. */
const imageSize = (src: string) =>
  new Promise<{ w: number; h: number } | undefined>((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve(undefined);
    img.src = src;
  });

export function ImageStudio({
  ref,
  me,
  library,
  onOpenKeys,
  onUseAsStartFrame,
  tools,
  onToolJob,
  catalogModels,
}: {
  ref?: React.Ref<StudioTabHandle>;
  me: Me | null;
  library: Library;
  onOpenKeys: () => void;
  /** Send a generated image to the Video tab as its start frame. */
  onUseAsStartFrame: (item: LibraryItem) => void;
  tools: readonly ToolView[];
  onToolJob: () => void;
  /** fal image models from /api/models. Null until that request returns. */
  catalogModels?: readonly ImageModel[] | null;
}) {
  const [gens, setGens] = useState<ImageGeneration[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [state, setState] = useState<ComposerState>({
    model: imageModels()[0],
    prompt: "",
    ratio: "auto",
    resolution: "2k",
    quality: "high",
    count: 1,
  });
  const [refIds, setRefIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [open, setOpen] = useState<{ id: string; i: number } | null>(null);
  const gensRef = useRef(gens);
  useEffect(() => {
    gensRef.current = gens;
  }, [gens]);

  const byId = new Map(library.items.map((i) => [i.id, i]));
  const references = refIds.flatMap((id) => byId.get(id) ?? []);
  const keyed = new Set(me?.keys.map((key) => key.provider) ?? []);
  const defaultProvider = me?.user.activeProvider ?? null;
  const [routePreferences, setRoutePreferences] = useState<Record<string, string>>(me?.routePreferences ?? {});
  const imageRoute = preferredRoute(state.model, keyed, [
    state.route,
    routePreferences[state.model.id],
    imageProviderFor(defaultProvider, [...keyed]),
  ])?.provider;
  const imageProvider =
    imageRoute === "argolink" || imageRoute === "openrouter" || imageRoute === "fal" ? imageRoute : undefined;
  const models = [
    ...imageModels(),
    ...(catalogModels ?? []).filter((model) => !imageModels().some((item) => item.id === model.id)),
  ];

  function saveRoute(modelId: string, provider: string) {
    setRoutePreferences((prev) => ({ ...prev, [modelId]: provider }));
    void apiJson("/api/me", { method: "PATCH", body: JSON.stringify({ modelId, provider }) }).catch(() => {});
  }
  const now = useNow(gens.some(pending));

  const upsert = useCallback((gen: ImageGeneration) => {
    setGens((prev) => {
      const i = prev.findIndex((g) => g.id === gen.id);
      if (i === -1) return [gen, ...prev];
      const next = [...prev];
      next[i] = gen;
      return next;
    });
  }, []);

  useEffect(() => {
    apiJson<ImageGeneration[]>("/api/images")
      .then(setGens)
      .catch(() => {})
      .finally(() => setLoaded(true));
    const timer = setInterval(() => {
      for (const g of gensRef.current.filter(pending))
        apiJson<ImageGeneration>(`/api/images/${g.id}`)
          .then(upsert)
          .catch(() => {});
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [upsert]);

  useImperativeHandle(ref, () => ({
    addReference: (item) => addRefs([item]),
    setStartFrame(item) {
      onUseAsStartFrame(item);
    },
    reload() {
      apiJson<ImageGeneration[]>("/api/images")
        .then(setGens)
        .catch(() => {});
    },
  }));

  // ---- references (image library items); prompt mentions follow their image
  const tag = (ids: string[]) => ids.filter((id) => byId.has(id)).map((id) => ({ id, kind: "Image" as const }));
  function setRefs(next: string[]) {
    setState((s) => ({ ...s, prompt: remapMentions(s.prompt, tag(refIds), tag(next)) }));
    setRefIds(next);
  }
  /** Adds image items as references, within the model's limit. Returns the ones added. */
  function addRefs(items: LibraryItem[]) {
    const images = items.filter((i) => i.kind === "image" && !refIds.includes(i.id));
    if (images.length < items.filter((i) => !refIds.includes(i.id)).length)
      toast("Image models take images as references, not video or audio.");
    const room = state.model.capabilities.references.image - refIds.length;
    if (images.length > room)
      toast(`${state.model.name} takes up to ${state.model.capabilities.references.image} reference images.`);
    const added = room > 0 ? images.slice(0, room) : [];
    if (added.length) setRefs([...refIds, ...added.map((i) => i.id)]);
    return added;
  }
  async function addFiles(files: File[]) {
    const { items, errors } = await library.add(files);
    if (errors.length) toast(errors.join("\n"), { tone: "error" });
    return addRefs(items);
  }
  function toggleRef(item: LibraryItem) {
    if (refIds.includes(item.id)) setRefs(refIds.filter((id) => id !== item.id));
    else addRefs([item]);
  }
  async function deleteUpload(item: LibraryItem) {
    if (refIds.includes(item.id)) setRefs(refIds.filter((id) => id !== item.id));
    await library.remove(item.id).catch((e) => setError((e as Error).message));
  }

  const firstRef = state.ratio === "auto" ? references[0] : undefined;
  const firstSrc = firstRef ? thumbSrc(firstRef) : undefined;
  const [measured, setMeasured] = useState<{ src: string; ratio: string } | undefined>();
  useEffect(() => {
    if (!firstSrc) return;
    let gone = false;
    imageSize(firstSrc).then((size) => {
      if (gone || !size) return;
      setMeasured({ src: firstSrc, ratio: nearestRatio(state.model, size.w, size.h, state.resolution) });
    });
    return () => {
      gone = true;
    };
  }, [firstSrc, state.model, state.resolution]);
  const autoRatio = firstSrc && measured?.src === firstSrc ? measured.ratio : undefined;

  // ---- generate
  async function generate() {
    setError(null);
    setSubmitting(true);
    try {
      const { model, ratio, resolution } = state;
      upsert(
        await apiJson<ImageGeneration>("/api/images", {
          method: "POST",
          body: JSON.stringify({
            model: model.id,
            prompt: state.prompt,
            ratio,
            autoRatio,
            resolution,
            quality: model.capabilities.qualities ? state.quality : undefined,
            count: state.count,
            references: references.map((r) => r.key),
            ...(imageRoute ? { route: imageRoute } : {}),
          }),
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function remove(gen: ImageGeneration) {
    const ok = await confirmToast(
      gen.images.length > 1
        ? `Delete all ${gen.images.length} images from this generation? This can't be undone.`
        : "Delete this image? This can't be undone.",
      { confirmLabel: "Delete" },
    );
    if (!ok) return;
    setGens((prev) => prev.filter((g) => g.id !== gen.id));
    setOpen(null);
    await api(`/api/images/${gen.id}`, { method: "DELETE" });
  }

  async function imageItem(gen: ImageGeneration, index: number) {
    const key = gen.images[index]?.key;
    if (!key) return;
    const match = (items: LibraryItem[]) => items.find((i) => i.key === key);
    return match(library.items) ?? match(await library.reload());
  }

  async function applyGenerated(gen: ImageGeneration, index: number, as: "start" | "reference") {
    const item = await imageItem(gen, index);
    if (!item) {
      setError("This image isn't in your library yet.");
      return;
    }
    setOpen(null);
    if (as === "start") onUseAsStartFrame(item);
    else addRefs([item]);
  }

  /** Back into the composer: prompt, settings and the reference images still in Uploads. */
  function reuse(gen: ImageGeneration) {
    // Reuse puts the stored route back on this generation. It does not save a preference.
    const model = models.find((item) => item.id === gen.model) ?? state.model;
    setState({
      model,
      prompt: gen.prompt,
      ratio: ratioAllowed(model, gen.ratio, gen.resolution) ? gen.ratio : "auto",
      resolution: gen.resolution,
      quality: gen.quality ?? state.quality,
      count: gen.count,
      route: gen.route,
    });
    setRefIds(gen.references.filter((k) => byId.has(k)));
    setOpen(null);
  }

  // One tile per image; placeholders while running.
  const tiles = gens.flatMap((g) =>
    g.status === "succeeded"
      ? g.images.map((_, i) => ({ gen: g, i }))
      : g.status === "failed"
        ? [{ gen: g, i: -1 }]
        : Array.from({ length: g.count }, (_, i) => ({ gen: g, i })),
  );
  const openTile = open && gens.find((g) => g.id === open.id);
  const shown = tiles.filter((t) => t.gen.status === "succeeded");
  const openAt = open ? shown.findIndex((tile) => tile.gen.id === open.id && tile.i === open.i) : -1;

  return (
    <div className="relative h-full">
      <div className="h-full overflow-y-auto px-4 pt-4 pb-72">
        {loaded && tiles.length === 0 ? (
          <div className="grid h-[60%] place-items-center text-center">
            <div className="max-w-sm">
              <>
                <p className="text-lg font-medium text-zinc-300">No images yet</p>
                <p className="mt-1 text-sm text-zinc-500">
                  {imageProvider ? `Images run on ${PROVIDER_INFO[imageProvider].label}. ` : ""}
                  Describe an image below, or add references to edit.
                </p>
              </>
            </div>
          </div>
        ) : (
          <div className="columns-2 gap-3 sm:columns-3 xl:columns-4 2xl:columns-5">
            {tiles.map(({ gen, i }) => (
              <div
                key={`${gen.id}-${i}`}
                className="group relative mb-3 break-inside-avoid overflow-hidden rounded-xl bg-white/[0.04]"
              >
                {gen.status === "succeeded" ? (
                  <button onClick={() => setOpen({ id: gen.id, i })} className="block w-full">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={imageUrl(gen, i)} alt={gen.prompt} loading="lazy" className="w-full" />
                  </button>
                ) : gen.status === "failed" ? (
                  <div style={aspectStyle(gen.aspect)} className="grid place-items-center p-4 text-center">
                    <div>
                      <p className="text-sm text-red-300">Failed</p>
                      <p className="mt-1 line-clamp-4 text-xs text-zinc-500">{gen.error}</p>
                    </div>
                  </div>
                ) : (
                  <div style={aspectStyle(gen.aspect)} className="relative">
                    <Skeleton fill />
                    <span className="absolute inset-0 grid place-items-center text-xs text-zinc-400 tabular-nums">
                      {gen.status === "queued" ? "Queued" : "Generating"} ·{" "}
                      {Math.max(0, Math.floor((now - (gen.startedAt ?? gen.createdAt)) / 1000))}s
                    </span>
                  </div>
                )}
                {gen.status === "succeeded" && i >= 0 && (
                  <div className="relative z-10 flex flex-wrap gap-1 border-t border-white/5 bg-ink/40 p-1.5">
                    <button
                      type="button"
                      onClick={() => void applyGenerated(gen, i, "start")}
                      className="rounded-md bg-white/5 px-1.5 py-1 text-[10px] text-zinc-300 hover:bg-white/10 hover:text-white"
                    >
                      Use as start frame
                    </button>
                    <button
                      type="button"
                      onClick={() => void applyGenerated(gen, i, "reference")}
                      className="rounded-md bg-white/5 px-1.5 py-1 text-[10px] text-zinc-300 hover:bg-white/10 hover:text-white"
                    >
                      Use as reference
                    </button>
                  </div>
                )}
                {gen.status !== "running" && gen.status !== "queued" && (
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end gap-1 bg-gradient-to-t from-black/80 to-transparent p-2 pt-8 opacity-0 transition group-hover:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100">
                    <p className="line-clamp-2 min-w-0 flex-1 text-xs text-zinc-200">{gen.prompt}</p>
                    <div className="pointer-events-auto flex gap-1">
                      {i >= 0 && (
                        <a
                          href={imageUrl(gen, i, true)}
                          aria-label="Download"
                          title="Download"
                          className="grid size-7 place-items-center rounded-full bg-black/70 text-xs hover:bg-black"
                        >
                          <Download className="size-3.5" aria-hidden />
                        </a>
                      )}
                      <button
                        type="button"
                        onClick={() => reuse(gen)}
                        aria-label="Reuse prompt and settings"
                        title="Reuse prompt and settings"
                        className="grid size-7 place-items-center rounded-full bg-black/70 text-xs hover:bg-black"
                      >
                        <RotateCcw className="size-3.5" aria-hidden />
                      </button>
                      <button
                        type="button"
                        onClick={() => remove(gen)}
                        aria-label="Delete"
                        title="Delete"
                        className="grid size-7 place-items-center rounded-full bg-black/70 text-xs hover:bg-black"
                      >
                        <X className="size-3.5" aria-hidden />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 px-4 pb-4">
        <div className="pointer-events-auto mx-auto max-w-4xl">
          <ImageComposer
            state={state}
            onChange={(patch) => setState((s) => ({ ...s, ...patch }))}
            references={references}
            onAddFiles={addFiles}
            onRemoveReference={(i) => setRefs(refIds.filter((id) => id !== references[i]?.id))}
            onOpenLibrary={() => setLibraryOpen(true)}
            onGenerate={() => void generate()}
            submitting={submitting}
            error={error}
            keyed={keyed}
            routePreferences={routePreferences}
            defaultProvider={defaultProvider}
            onSaveRoute={saveRoute}
            onOpenKeys={onOpenKeys}
            models={models}
            autoRatio={autoRatio}
          />
        </div>
      </div>

      {libraryOpen && (
        <Modal size="full" surface="ink" onClose={() => setLibraryOpen(false)} label="Uploads" showClose={false}>
          <UploadsPanel
            library={library}
            selected={new Map(references.map((r, i) => [r.id, `@Image ${i + 1}`]))}
            onToggle={toggleRef}
            onDelete={deleteUpload}
            onClose={() => setLibraryOpen(false)}
          />
        </Modal>
      )}

      {openTile && open && open.i >= 0 && (
        <Viewer
          label="Image"
          title={imageDetails(openTile).find((row) => row.label === "Model")?.value ?? "Image"}
          kind="image"
          src={imageUrl(openTile, open.i)}
          alt={openTile.prompt}
          prompt={openTile.prompt}
          references={openTile.references.flatMap((key) => {
            const item = library.items.find((entry) => entry.key === key);
            const refSrc = item ? (thumbSrc(item) ?? undefined) : undefined;
            return refSrc ? [{ src: refSrc, alt: item?.name ?? "Reference" }] : [{ src: `/api/assets/file?key=${encodeURIComponent(key)}`, alt: "Reference" }];
          })}
          details={imageDetails(openTile)}
          error={openTile.error}
          onClose={() => setOpen(null)}
          onPrev={
            openAt > 0
              ? () => {
                  const prev = shown[openAt - 1];
                  if (prev) setOpen({ id: prev.gen.id, i: prev.i });
                }
              : undefined
          }
          onNext={
            openAt >= 0 && openAt < shown.length - 1
              ? () => {
                  const next = shown[openAt + 1];
                  if (next) setOpen({ id: next.gen.id, i: next.i });
                }
              : undefined
          }
          onReuse={() => reuse(openTile)}
          onUseAsReference={() => void applyGenerated(openTile, open.i, "reference")}
          onDelete={() => remove(openTile)}
          downloadHref={imageUrl(openTile, open.i, true)}
          tools={tools}
          toolKind="image"
          assetKey={openTile.images[open.i]?.key}
          keyed={keyed}
          onOpenKeys={onOpenKeys}
          onToolJob={() => {
            setOpen(null);
            onToolJob();
          }}
          extra={
            <button
              type="button"
              onClick={() => void applyGenerated(openTile, open.i, "start")}
              className="mt-3 w-full rounded-md border border-line py-2 text-body text-fg"
            >
              Use as start frame
            </button>
          }
        />
      )}
    </div>
  );
}
