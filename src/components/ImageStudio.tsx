"use client";

// The Image tab: generated images in a grid, with the prompt bar floating over it.

import { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { getImageModel, IMAGE_MODELS, nearestRatio, ratioAllowed } from "@/lib/imageModels";
import type { ImageGeneration } from "@/lib/images";
import type { StudioTabHandle } from "./VideoStudio";
import { remapMentions } from "@/lib/mentions";
import { api, apiJson, type Me } from "./api";
import { ImageComposer, type ComposerState } from "./ImageComposer";
import { thumbSrc, type Library, type LibraryItem } from "./library";
import { UploadsPanel } from "./UploadsPanel";

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
}: {
  ref?: React.Ref<StudioTabHandle>;
  me: Me | null;
  library: Library;
  onOpenKeys: () => void;
}) {
  const [gens, setGens] = useState<ImageGeneration[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [state, setState] = useState<ComposerState>({
    model: IMAGE_MODELS[0],
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
  const needsKey = !!me && !me.keys.some((k) => k.provider === "argolink");
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
      alert("Image models take images as references, not video or audio.");
    const room = state.model.maxReferences - refIds.length;
    if (images.length > room) alert(`${state.model.label} takes up to ${state.model.maxReferences} reference images.`);
    const added = room > 0 ? images.slice(0, room) : [];
    if (added.length) setRefs([...refIds, ...added.map((i) => i.id)]);
    return added;
  }
  async function addFiles(files: File[]) {
    const { items, errors } = await library.add(files);
    if (errors.length) alert(errors.join("\n"));
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

  // ---- generate
  async function generate() {
    setError(null);
    setSubmitting(true);
    try {
      const { model, ratio, resolution } = state;
      let autoRatio: string | undefined;
      const first = references[0];
      if (ratio === "auto" && first) {
        const size = await imageSize(thumbSrc(first) ?? "");
        if (size) autoRatio = nearestRatio(model, size.w, size.h, resolution);
      }
      upsert(
        await apiJson<ImageGeneration>("/api/images", {
          method: "POST",
          body: JSON.stringify({
            model: model.id,
            prompt: state.prompt,
            ratio,
            autoRatio,
            resolution,
            quality: model.qualities ? state.quality : undefined,
            count: state.count,
            references: references.map((r) => r.key),
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
    if (
      !confirm(
        gen.images.length > 1 ? `Delete all ${gen.images.length} images from this generation?` : "Delete this image?",
      )
    )
      return;
    setGens((prev) => prev.filter((g) => g.id !== gen.id));
    setOpen(null);
    await api(`/api/images/${gen.id}`, { method: "DELETE" });
  }

  /** Back into the composer: prompt, settings and the reference images still in Uploads. */
  function reuse(gen: ImageGeneration) {
    const model = getImageModel(gen.model) ?? state.model;
    setState({
      model,
      prompt: gen.prompt,
      ratio: ratioAllowed(model, gen.ratio, gen.resolution) ? gen.ratio : "auto",
      resolution: gen.resolution,
      quality: gen.quality ?? state.quality,
      count: gen.count,
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

  return (
    <div className="relative h-full">
      <div className="h-full overflow-y-auto px-4 pt-4 pb-72">
        {loaded && tiles.length === 0 ? (
          <div className="grid h-[60%] place-items-center text-center">
            <div>
              <p className="text-lg font-medium text-zinc-300">No images yet</p>
              <p className="mt-1 text-sm text-zinc-500">Describe an image below, or add references to edit.</p>
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
                  <div style={aspectStyle(gen.aspect)} className="shimmer grid place-items-center">
                    <span className="text-xs text-zinc-400 tabular-nums">
                      {gen.status === "queued" ? "Queued" : "Generating"} ·{" "}
                      {Math.max(0, Math.floor((now - (gen.startedAt ?? gen.createdAt)) / 1000))}s
                    </span>
                  </div>
                )}
                {gen.status !== "running" && gen.status !== "queued" && (
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end gap-1 bg-gradient-to-t from-black/80 to-transparent p-2 pt-8 opacity-0 transition group-hover:opacity-100">
                    <p className="line-clamp-2 min-w-0 flex-1 text-xs text-zinc-200">{gen.prompt}</p>
                    <div className="pointer-events-auto flex gap-1">
                      {i >= 0 && (
                        <a
                          href={imageUrl(gen, i, true)}
                          title="Download"
                          className="grid size-7 place-items-center rounded-full bg-black/70 text-xs hover:bg-black"
                        >
                          ↓
                        </a>
                      )}
                      <button
                        onClick={() => reuse(gen)}
                        title="Reuse prompt and settings"
                        className="grid size-7 place-items-center rounded-full bg-black/70 text-xs hover:bg-black"
                      >
                        ↺
                      </button>
                      <button
                        onClick={() => remove(gen)}
                        title="Delete"
                        className="grid size-7 place-items-center rounded-full bg-black/70 text-xs hover:bg-black"
                      >
                        ✕
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
            needsKey={needsKey}
            onOpenKeys={onOpenKeys}
          />
        </div>
      </div>

      {libraryOpen && (
        <div className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm" onClick={() => setLibraryOpen(false)}>
          <div
            className="absolute inset-3 overflow-y-auto rounded-2xl border border-white/10 bg-ink lg:inset-10"
            onClick={(e) => e.stopPropagation()}
          >
            <UploadsPanel
              library={library}
              selected={new Map(references.map((r, i) => [r.id, `@Image ${i + 1}`]))}
              onToggle={toggleRef}
              onDelete={deleteUpload}
              onClose={() => setLibraryOpen(false)}
            />
          </div>
        </div>
      )}

      {openTile && open && (
        <ImageLightbox
          gen={openTile}
          index={open.i}
          onNavigate={(d) => {
            const at = shown.findIndex((t) => t.gen.id === open.id && t.i === open.i);
            const next = shown[at + d];
            if (next) setOpen({ id: next.gen.id, i: next.i });
          }}
          onClose={() => setOpen(null)}
          onReuse={() => reuse(openTile)}
          onDelete={() => remove(openTile)}
        />
      )}
    </div>
  );
}

function ImageLightbox({
  gen,
  index,
  onNavigate,
  onClose,
  onReuse,
  onDelete,
}: {
  gen: ImageGeneration;
  index: number;
  onNavigate: (delta: number) => void;
  onClose: () => void;
  onReuse: () => void;
  onDelete: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft") onNavigate(-1);
      if (e.key === "ArrowRight") onNavigate(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onNavigate]);

  const model = getImageModel(gen.model);
  const details: [string, string][] = [
    ["Model", model?.label ?? gen.model],
    ["Ratio", gen.aspect ?? "Auto"],
    ["Resolution", gen.resolution.toUpperCase()],
    ...(gen.quality ? [["Quality", gen.quality] as [string, string]] : []),
    ["Images", String(gen.count)],
    ["References", String(gen.references.length)],
    ["Est. cost", `$${gen.cost.toFixed(3)}`],
  ];

  return (
    <div className="fixed inset-0 z-50 flex bg-black/85 backdrop-blur-sm" onClick={onClose}>
      <div
        className="m-auto flex max-h-[92dvh] w-[min(1300px,94vw)] flex-col overflow-hidden rounded-2xl border border-white/10 bg-panel lg:flex-row"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative grid min-h-[300px] flex-1 place-items-center bg-black">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={imageUrl(gen, index)} alt={gen.prompt} className="max-h-[92dvh] w-full object-contain" />
          {[-1, 1].map((d) => (
            <button
              key={d}
              onClick={() => onNavigate(d)}
              aria-label={d < 0 ? "Previous" : "Next"}
              className={`absolute top-1/2 ${d < 0 ? "left-3" : "right-3"} grid size-10 -translate-y-1/2 place-items-center rounded-full bg-black/60 text-2xl text-white hover:bg-black/80`}
            >
              {d < 0 ? "‹" : "›"}
            </button>
          ))}
        </div>
        <aside className="flex w-full shrink-0 flex-col gap-4 overflow-y-auto p-5 lg:w-80">
          <div className="flex items-start justify-between gap-3">
            <p className="text-sm whitespace-pre-wrap text-zinc-200">{gen.prompt}</p>
            <button
              onClick={onClose}
              aria-label="Close"
              className="grid size-8 shrink-0 place-items-center rounded-full bg-white/5 hover:bg-white/10"
            >
              ✕
            </button>
          </div>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
            {details.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-zinc-500">{k}</dt>
                <dd className="text-zinc-200 capitalize">{v}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-auto grid grid-cols-3 gap-2 text-sm">
            <a href={imageUrl(gen, index, true)} className="rounded-xl bg-accent py-2 text-center font-medium text-ink">
              Download
            </a>
            <button onClick={onReuse} className="rounded-xl border border-white/10 py-2 hover:bg-white/5">
              Reuse
            </button>
            <button onClick={onDelete} className="rounded-xl border border-white/10 py-2 text-red-300 hover:bg-white/5">
              Delete
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}
