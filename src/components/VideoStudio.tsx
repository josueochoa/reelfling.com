"use client";

// The Video tab: Seedance generations with the control panel on the left.

import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { shouldPollFal, type FalJobView } from "@/lib/falTypes";
import { restoreInputs } from "@/lib/inputs";
import { assetBytesUrl, extractLastFrame, generationBytesUrl } from "@/lib/lastFrame";
import { isVideo, MODELS, type VideoModel } from "@/lib/registry";
import { availabilityFor, routeProviders, sortByAvailability } from "@/lib/registry/availability";
import { groupFeed, isNumberedSequence } from "@/lib/sequence";
import type { ExtendOffer, ToolView } from "@/lib/toolTypes";
import { TERMINAL_STATUSES, type GenerateRequest, type Generation } from "@/lib/types";
import { assetFileUrl } from "@/lib/uploads";
import { confirmToast, toast } from "@/components/ui/Toast";
import type { SavedLook } from "@/lib/registry/looks";
import { getTemplate, restoredSlotInputs, type SlotInput } from "@/lib/templates/templates";
import { api, apiJson, type Me } from "./api";
import { ControlPanel, type ControlPanelHandle, type Preset } from "./ControlPanel";
import { GenerationCard, StatusOverlay, useElapsed, videoDownloadHref, videoSrc } from "./GenerationCard";
import { OwnerBadge, ownerName, useTeamRefresh } from "./Owner";
import { TemplateForm } from "./TemplateForm";
import { TemplateGallery, type FilterId } from "./TemplateGallery";
import { thumbSrc, toolAudios, uploadToolAudio, type Library, type LibraryItem } from "./library";
import { useLazyThumbs } from "./MediaBlocks";
import { UploadsPanel } from "./UploadsPanel";
import { Viewer } from "./Viewer";
import { videoDetails } from "./viewer/details";

const POLL_MS = 5000;

// A teammate's generation is polled by its owner's tab and the cron; this tab refreshes the list instead.
const needsPoll = (g: Generation) =>
  !g.owner && (!TERMINAL_STATUSES.includes(g.status) || (g.status === "succeeded" && !g.stored));

/** For the Assets tab: "Use in Video", and refreshing after deletes. */
export interface StudioTabHandle {
  addReference: (item: LibraryItem) => void;
  /** Frames mode, with this image as the start frame. */
  setStartFrame: (item: LibraryItem) => void;
  reload: () => void;
}

export function VideoStudio({
  ref,
  me,
  library,
  onOpenKeys,
  openRouterModels,
  tools,
  extendOffers,
  onToolJob,
  savedLooks,
  onLooks,
}: {
  ref?: React.Ref<StudioTabHandle>;
  me: Me | null;
  library: Library;
  onOpenKeys: () => void;
  /** Null until /api/models returns. Empty when that request failed. */
  openRouterModels: VideoModel[] | null;
  tools: readonly ToolView[];
  extendOffers: readonly ExtendOffer[];
  onToolJob: () => void;
  savedLooks: readonly SavedLook[];
  onLooks: (next: SavedLook[]) => void;
}) {
  const [generations, setGenerations] = useState<Generation[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [preset, setPreset] = useState<Preset>({ key: 0 });
  const [open, setOpen] = useState<Generation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [continueBusy, setContinueBusy] = useState(false);
  const [extendJobs, setExtendJobs] = useState<FalJobView[]>([]);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [galleryCategory, setGalleryCategory] = useState<FilterId>("all");
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [templateInitial, setTemplateInitial] = useState<Record<string, SlotInput> | undefined>(undefined);
  const [templateKey, setTemplateKey] = useState(0);
  const [refLabels, setRefLabels] = useState<Map<string, string>>(new Map());
  const panel = useRef<ControlPanelHandle>(null);
  const feedEl = useRef<HTMLElement>(null);
  const root = useRef<HTMLDivElement>(null);
  // Phones show the settings or the generations, not both. From md they sit side by side.
  const [pane, setPane] = useState<"create" | "results">("create");
  const defaultProvider = me?.user.activeProvider ?? null;
  const [routePreferences, setRoutePreferences] = useState<Record<string, string>>(me?.routePreferences ?? {});
  const gensRef = useRef(generations);
  const jobsRef = useRef(extendJobs);
  useEffect(() => {
    gensRef.current = generations;
  }, [generations]);
  useEffect(() => {
    jobsRef.current = extendJobs;
  }, [extendJobs]);

  const upsert = useCallback((gen: Generation) => {
    setGenerations((prev) => {
      const i = prev.findIndex((g) => g.id === gen.id);
      if (i === -1) return [gen, ...prev];
      const next = [...prev];
      next[i] = gen;
      return next;
    });
    setOpen((o) => (o?.id === gen.id ? gen : o));
  }, []);

  /** The template form hides the composer. These actions show it again so the change is visible. */
  function revealComposer() {
    setTemplateId(null);
    setGalleryOpen(false);
  }

  function showPane(next: "create" | "results") {
    setPane(next);
    if (root.current) root.current.scrollTop = 0;
  }

  useImperativeHandle(ref, () => ({
    addReference(item) {
      if (!panel.current) {
        toast("Add an API key first to generate videos.");
        return;
      }
      revealComposer();
      showPane("create");
      panel.current.add(item);
    },
    setStartFrame(item) {
      if (!panel.current) {
        toast("Add an API key first to generate videos.");
        return;
      }
      revealComposer();
      showPane("create");
      panel.current.setStartFrame(item);
    },
    reload() {
      apiJson<Generation[]>("/api/generations")
        .then(setGenerations)
        .catch(() => {});
    },
  }));

  const loadJobs = useCallback(() => {
    api("/api/fal")
      .then(async (res) => {
        if (res.ok) setExtendJobs(await res.json());
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    apiJson<Generation[]>("/api/generations")
      .then(setGenerations)
      .finally(() => setLoaded(true));
    loadJobs();
  }, [loadJobs]);

  useTeamRefresh(!!me?.teammates, () => {
    apiJson<Generation[]>("/api/generations")
      .then(setGenerations)
      .catch(() => {});
    loadJobs();
  });

  useEffect(() => {
    const timer = setInterval(async () => {
      const pending = gensRef.current.filter(needsPoll);
      await Promise.all(
        pending.map(async (g) => {
          const res = await api(`/api/generations/${g.id}`);
          if (res.ok) upsert(await res.json());
        }),
      );
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [upsert]);

  useEffect(() => {
    const timer = setInterval(() => {
      const pending = jobsRef.current.filter((job) => !job.owner && job.sequenceId && shouldPollFal(job.status));
      void Promise.all(
        pending.map(async (job) => {
          const res = await api(`/api/fal/${job.id}`);
          if (!res.ok) return;
          const next = (await res.json()) as FalJobView;
          setExtendJobs((prev) => prev.map((item) => (item.id === next.id ? next : item)));
        }),
      );
    }, POLL_MS);
    return () => clearInterval(timer);
  }, []);

  async function generate(req: GenerateRequest) {
    setError(null);
    try {
      upsert(await apiJson<Generation>("/api/generations", { method: "POST", body: JSON.stringify(req) }));
      if (req.templateId) setGalleryOpen(false);
      showPane("results");
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }

  async function remove(gen: Generation) {
    const ok = await confirmToast("Delete this generation? This can't be undone.", { confirmLabel: "Delete" });
    if (!ok) return;
    setGenerations((prev) => prev.filter((g) => g.id !== gen.id));
    if (open?.id === gen.id) setOpen(null);
    await api(`/api/generations/${gen.id}`, { method: "DELETE" });
  }

  function openTemplate(id: string, initial?: Record<string, SlotInput>) {
    setTemplateId(id);
    setTemplateInitial(initial);
    setTemplateKey((key) => key + 1);
    setLibraryOpen(false);
    showPane("create");
  }

  function openTemplateAgain(gen: Generation) {
    const template = getTemplate(gen.templateId);
    if (!template) return;
    setOpen(null);
    openTemplate(template.id, restoredSlotInputs(gen));
    setGalleryOpen(false);
  }

  function saveRoute(modelId: string, provider: string) {
    setRoutePreferences((prev) => ({ ...prev, [modelId]: provider }));
    void apiJson("/api/me", { method: "PATCH", body: JSON.stringify({ modelId, provider }) }).catch(() => {});
  }

  function catalog() {
    const hand = MODELS.filter(isVideo);
    const extra = (openRouterModels ?? []).filter((model) => !hand.some((item) => item.id === model.id));
    return [...hand, ...extra];
  }

  function reuse(gen: Generation, extra?: { frameKey?: string; continueFrom?: string }) {
    setOpen(null);
    setTemplateId(null);
    showPane("create");
    const available = new Set(library.items.flatMap((i) => (i.key ? [i.key] : [])));
    // A teammate's frames and references are in their storage, so only the settings come over.
    const theirs = gen.owner;
    // Don't claim files were deleted while the library is still loading.
    const restored = extra?.frameKey || !library.loaded || theirs ? undefined : restoreInputs(gen, available);
    const waiting = !extra?.frameKey && !library.loaded && !theirs;
    const pickedModel = catalog().find((model) => model.id === gen.model);
    const frameNote = extra?.frameKey
      ? pickedModel?.capabilities.frames.start
        ? "Last frame saved to Uploads. It's the start frame."
        : "Last frame saved to Uploads. This model doesn't take a start frame, so pick one that does."
      : undefined;
    setPreset((p) => ({
      key: p.key + 1,
      model: gen.model,
      route: gen.route,
      prompt: restored?.prompt ?? gen.prompt,
      ratio: gen.ratio,
      resolution: gen.resolution,
      duration: gen.duration,
      generateAudio: gen.generateAudio,
      cameraMoves: gen.cameraMoves,
      cameraMove: gen.cameraMove,
      look: gen.look,
      lookSwatch: gen.lookSwatch,
      mode: extra?.frameKey ? "frames" : (restored?.mode ?? gen.mode),
      firstFrameKey: extra?.frameKey ?? restored?.firstFrameKey,
      lastFrameKey: extra?.frameKey ? undefined : restored?.lastFrameKey,
      middleFrameKeys: extra?.frameKey ? undefined : restored?.middleFrameKeys,
      referenceKeys: extra?.frameKey ? undefined : restored?.referenceKeys,
      editVideoKey: extra?.frameKey ? undefined : restored?.editVideoKey,
      continueFrom: extra?.continueFrom,
      notice:
        frameNote ??
        (theirs
          ? `Prompt and settings from ${ownerName(theirs)}'s video. Their frames and references stay with them.`
          : waiting
            ? "Uploads are still loading, so frames and references weren't restored. Try Reuse again in a moment."
            : restored?.notice),
    }));
  }

  async function continueFromVideo(src: string, gen: Generation) {
    setContinueBusy(true);
    setError(null);
    try {
      const blob = await extractLastFrame(src);
      const file = new File([blob], "Last frame.jpg", { type: "image/jpeg" });
      const { items, errors } = await library.add([file]);
      if (errors[0] || !items[0]) throw new Error(errors[0] || "Couldn't save the frame");
      const ready = await library.whenReady(items[0].id);
      if (!ready.key) throw new Error("Couldn't save the frame");
      reuse(gen, { frameKey: ready.key, continueFrom: gen.id });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setContinueBusy(false);
    }
  }

  async function nativeExtend(modelId: string, assetKey: string, prompt: string) {
    const offer = extendOffers.find((item) => item.modelIds.includes(modelId));
    if (!offer) throw new Error("This model can't extend a video");
    const job = await apiJson<FalJobView>("/api/fal", {
      method: "POST",
      body: JSON.stringify({ toolId: offer.id, assetIds: [assetKey], params: { prompt } }),
    });
    setExtendJobs((prev) => [job, ...prev.filter((item) => item.id !== job.id)]);
    setGenerations(await apiJson<Generation[]>("/api/generations"));
    setOpen(null);
  }

  async function removeExtend(job: FalJobView) {
    setExtendJobs((prev) => prev.filter((item) => item.id !== job.id));
    const res = await api(`/api/fal/${job.id}`, { method: "DELETE" });
    if (!res.ok) loadJobs();
  }

  async function outputItem(gen: Generation) {
    const match = (items: LibraryItem[]) => items.find((i) => i.generation?.id === gen.id && i.kind === "video");
    return match(library.items) ?? match(await library.reload());
  }

  async function referenceStoredVideo(gen: Generation) {
    setOpen(null);
    if (!panel.current) {
      toast("Add an API key first to generate videos.");
      return;
    }
    revealComposer();
    showPane("create");
    if (gen.status !== "succeeded" || !gen.stored) return;
    const item = await outputItem(gen);
    if (!item) {
      panel.current.notify("This video isn't in your library yet.");
      return;
    }
    panel.current.useAsReference(item);
  }

  async function deleteUpload(item: LibraryItem) {
    // Drop it from the references first, so prompt mentions of it get flagged.
    panel.current?.forget(item.id);
    await library.remove(item.id).catch((e) => setError((e as Error).message));
  }

  const keyed = new Set(me?.keys.map((key) => key.provider) ?? []);
  const activeTemplate = getTemplate(templateId ?? undefined);
  const feed = groupFeed([
    ...generations.map((gen) => ({
      kind: "generation" as const,
      id: gen.id,
      sequenceId: gen.sequenceId,
      part: gen.part,
      createdAt: gen.createdAt,
      gen,
    })),
    ...extendJobs
      .filter((job) => job.sequenceId && job.part)
      .map((job) => ({
        kind: "extend" as const,
        id: job.id,
        sequenceId: job.sequenceId,
        part: job.part,
        createdAt: job.createdAt,
        job,
      })),
  ]);
  const clips = feed.flatMap((group) =>
    group.parts.flatMap((item) => (item.kind === "generation" ? [item.gen] : [])),
  );
  const openIndex = open ? clips.findIndex((item) => item.id === open.id) : -1;
  // Stored videos' library entries: their thumbnails are the cards' posters, made as cards scroll into view.
  const videoAssets = useMemo(
    () => new Map(library.items.flatMap((i) => (i.key?.startsWith("videos/") ? [[i.key, i] as const] : []))),
    [library.items],
  );
  const assetOf = (gen: Generation) => videoAssets.get(`videos/${gen.id}.mp4`);
  const cardAssets = useMemo(
    () => generations.flatMap((gen) => videoAssets.get(`videos/${gen.id}.mp4`) ?? []),
    [generations, videoAssets],
  );
  useLazyThumbs(feedEl, cardAssets, library.ensureThumb);
  const models = sortByAvailability(catalog(), (model) => availabilityFor(routeProviders(model.routes), keyed).available);
  const active = generations.filter((g) => !TERMINAL_STATUSES.includes(g.status)).length;

  return (
    // Side by side from md. Narrower screens switch between the panel and the feed.
    <div ref={root} className="flex min-h-0 w-full flex-1 flex-col overflow-y-auto md:flex-row md:overflow-hidden">
      <div className="sticky top-0 z-20 flex gap-1 border-b border-white/5 bg-ink/90 p-2 backdrop-blur md:hidden">
        {(
          [
            ["create", "Create"],
            ["results", "Generations"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            data-testid={`video-pane-${id}`}
            aria-pressed={pane === id}
            onClick={() => showPane(id)}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-body ${pane === id ? "bg-surface-3 text-fg" : "text-fg-muted"}`}
          >
            {label}
            {id === "results" && active > 0 && <span className="size-1.5 animate-pulse rounded-full bg-accent" />}
            {id === "results" && <span className="text-zinc-500">{generations.length}</span>}
          </button>
        ))}
      </div>
      <aside
        className={`${pane === "create" ? "flex" : "hidden"} w-full shrink-0 flex-col bg-panel md:flex md:h-full md:min-h-0 md:w-[340px] md:overflow-hidden md:border-r md:border-white/5 lg:w-[400px]`}
      >
        <header className="flex items-center justify-between px-5 pt-4 pb-2 text-xs">
          <button onClick={onOpenKeys} className="text-zinc-500 hover:text-zinc-300">
            API keys
          </button>
          {active > 0 && (
            <span className="flex items-center gap-1.5 rounded-full bg-white/5 px-2.5 py-1 text-zinc-400">
              <span className="size-1.5 animate-pulse rounded-full bg-accent" />
              {active} generating
            </span>
          )}
        </header>
        {models.length > 0 && (
          <div className={activeTemplate ? "hidden" : "flex min-h-0 min-w-0 flex-1 flex-col"}>
            <ControlPanel
              ref={panel}
              key={me ? preset.key : "pending"}
              library={library}
              onOpenLibrary={() => {
                setGalleryOpen(false);
                setLibraryOpen(true);
                showPane("results");
              }}
              onReferencesChange={setRefLabels}
              models={models}
              keyed={keyed}
              routePreferences={routePreferences}
              defaultProvider={defaultProvider}
              onSaveRoute={saveRoute}
              preset={preset}
              onGenerate={generate}
              error={error}
              onOpenKeys={onOpenKeys}
              savedLooks={savedLooks}
              onLooks={onLooks}
            />
          </div>
        )}
        {activeTemplate && (
          <TemplateForm
            key={templateKey}
            template={activeTemplate}
            models={models}
            modelsReady={openRouterModels !== null}
            keyed={keyed}
            library={library}
            initial={templateInitial}
            onGenerate={generate}
            onBack={() => setTemplateId(null)}
            onOpenKeys={onOpenKeys}
            error={error}
          />
        )}
      </aside>

      <main
        ref={feedEl}
        className={`${pane === "results" ? "" : "hidden"} @container md:block md:min-h-0 md:flex-1 md:overflow-y-auto`}
      >
        {libraryOpen ? (
          <UploadsPanel
            library={library}
            selected={refLabels}
            onToggle={(item) => {
              revealComposer();
              panel.current?.toggle(item);
            }}
            onDelete={deleteUpload}
            onClose={() => setLibraryOpen(false)}
          />
        ) : galleryOpen ? (
          <TemplateGallery
            category={galleryCategory}
            onCategory={setGalleryCategory}
            selectedId={templateId}
            onSelect={(id) => openTemplate(id)}
            onClose={() => setGalleryOpen(false)}
          />
        ) : (
          <>
            <div className="flex items-center justify-between border-b border-white/5 bg-ink/80 px-6 py-4 backdrop-blur md:sticky md:top-0 md:z-10">
              <h1 className="text-sm font-medium text-zinc-300">
                Generations <span className="text-zinc-500">· {generations.length}</span>
              </h1>
              <div className="flex gap-2">
                <button
                  type="button"
                  data-testid="open-templates"
                  onClick={() => {
                    setLibraryOpen(false);
                    setGalleryOpen(true);
                  }}
                  className="rounded-full bg-white/5 px-3 py-1.5 text-xs text-zinc-300 hover:bg-white/10"
                >
                  Templates
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setGalleryOpen(false);
                    setLibraryOpen(true);
                  }}
                  className="rounded-full bg-white/5 px-3 py-1.5 text-xs text-zinc-300 hover:bg-white/10"
                >
                  Uploads
                </button>
              </div>
            </div>

            {loaded && feed.length === 0 ? (
              <div className="grid h-[60vh] place-items-center text-center">
                <div>
                  <p className="text-lg font-medium text-zinc-300">No videos yet</p>
                  <p className="mt-1 text-sm text-zinc-500">
                    {keyed.size ? "Write a prompt and hit Generate to start." : "Add an API key to start generating."}
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setLibraryOpen(false);
                      setGalleryOpen(true);
                    }}
                    className="mt-3 text-body text-fg underline"
                  >
                    Browse templates
                  </button>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4 p-4 @xl:grid-cols-2 @xl:p-6 @[70rem]:grid-cols-3">
                {feed.map((group) => {
                  const numbered = isNumberedSequence(group.parts);
                  const cards = group.parts.map((item) => {
                    const source =
                      item.kind === "extend"
                        ? generations.find((gen) => gen.id === item.job.sourceGenerationId)
                        : undefined;
                    const asset = item.kind === "generation" ? assetOf(item.gen) : undefined;
                    return (
                      <div key={item.id} data-asset-id={asset?.id}>
                        {numbered && (
                          <p data-testid="sequence-part" className="mb-1.5 text-[11px] font-medium text-zinc-400">
                            Part {item.part}
                          </p>
                        )}
                        {item.kind === "generation" ? (
                          <GenerationCard
                            gen={item.gen}
                            poster={asset?.hasThumb ? thumbSrc(asset) : undefined}
                            onOpen={() => setOpen(item.gen)}
                            onReuse={() => reuse(item.gen)}
                            onUseTemplate={
                              getTemplate(item.gen.templateId) ? () => openTemplateAgain(item.gen) : undefined
                            }
                            onUseAsReference={item.gen.owner ? undefined : () => void referenceStoredVideo(item.gen)}
                            onDelete={item.gen.owner ? undefined : () => remove(item.gen)}
                          />
                        ) : (
                          <ExtendPart
                            job={item.job}
                            source={source}
                            canExtend={!!source && extendOffers.some((offer) => offer.modelIds.includes(source.model))}
                            continueBusy={continueBusy}
                            onContinue={(src, from) => void continueFromVideo(src, from)}
                            onExtend={(modelId, assetKey, prompt) => nativeExtend(modelId, assetKey, prompt)}
                            onReuse={(from) => reuse(from)}
                            onDelete={() => void removeExtend(item.job)}
                          />
                        )}
                      </div>
                    );
                  });
                  if (!numbered)
                    return (
                      <div key={group.id} className="contents">
                        {cards}
                      </div>
                    );
                  return (
                    <section
                      key={group.id}
                      data-testid="sequence"
                      className="col-span-full rounded-2xl border border-white/10 p-3"
                    >
                      <h2 className="mb-3 text-xs font-medium tracking-wide text-zinc-400 uppercase">
                        Sequence · {group.parts.length} parts
                      </h2>
                      <div className="grid grid-cols-1 gap-4 @xl:grid-cols-2 @[70rem]:grid-cols-3">{cards}</div>
                    </section>
                  );
                })}
              </div>
            )}
          </>
        )}
      </main>

      {open && (
        <OpenVideo
          key={open.id}
          gen={open}
          onClose={() => setOpen(null)}
          onPrev={
            openIndex > 0
              ? () => {
                  const prev = clips[openIndex - 1];
                  if (prev) setOpen(prev);
                }
              : undefined
          }
          onNext={
            openIndex >= 0 && openIndex < clips.length - 1
              ? () => {
                  const next = clips[openIndex + 1];
                  if (next) setOpen(next);
                }
              : undefined
          }
          onReuse={() => reuse(open)}
          onUseTemplate={getTemplate(open.templateId) ? () => openTemplateAgain(open) : undefined}
          onUseAsReference={open.owner ? undefined : () => void referenceStoredVideo(open)}
          onContinue={
            open.status === "succeeded" && !open.owner
              ? () => void continueFromVideo(generationBytesUrl(open.id), open)
              : undefined
          }
          continueBusy={continueBusy}
          extendOffer={
            open.status === "succeeded" && !open.owner
              ? extendOffers.find((offer) => offer.modelIds.includes(open.model))
              : undefined
          }
          onNativeExtend={
            open.status === "succeeded" && !open.owner
              ? (prompt) => nativeExtend(open.model, `videos/${open.id}.mp4`, prompt)
              : undefined
          }
          onDelete={open.owner ? undefined : () => remove(open)}
          tools={tools}
          keyed={keyed}
          onOpenKeys={onOpenKeys}
          onToolJob={() => {
            setOpen(null);
            onToolJob();
          }}
          audios={toolAudios(library.items)}
          onUploadAudio={(file) => uploadToolAudio(library, file)}
        />
      )}
    </div>
  );
}

function videoRefs(gen: Generation) {
  const refs: { src: string; alt: string }[] = [];
  const add = (key?: string, alt?: string) => {
    if (key) refs.push({ src: assetFileUrl(key, { owner: gen.owner?.id }), alt: alt || "Reference" });
  };
  add(gen.inputs.firstFrameKey, gen.inputs.firstFrameName ?? "Start frame");
  for (const [index, frame] of (gen.inputs.middleFrames ?? []).entries()) {
    add(frame.key, frame.name ?? `Keyframe ${index + 1}`);
  }
  add(gen.inputs.lastFrameKey, gen.inputs.lastFrameName ?? "End frame");
  for (const block of gen.inputs.blocks ?? []) {
    if (block.kind === "image") add(block.key, block.name ?? "Reference");
  }
  return refs;
}

function OpenVideo({
  gen,
  onClose,
  onPrev,
  onNext,
  onReuse,
  onUseTemplate,
  onUseAsReference,
  onContinue,
  continueBusy,
  extendOffer,
  onNativeExtend,
  onDelete,
  tools,
  keyed,
  onOpenKeys,
  onToolJob,
  audios,
  onUploadAudio,
}: {
  gen: Generation;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  onReuse: () => void;
  onUseTemplate?: () => void;
  onUseAsReference?: () => void;
  onContinue?: () => void;
  continueBusy?: boolean;
  extendOffer?: ExtendOffer;
  onNativeExtend?: (prompt: string) => Promise<void>;
  onDelete?: () => void;
  tools: readonly ToolView[];
  keyed: ReadonlySet<string>;
  onOpenKeys: () => void;
  onToolJob: () => void;
  audios: ReturnType<typeof toolAudios>;
  onUploadAudio: (file: File) => Promise<ReturnType<typeof toolAudios>[number]>;
}) {
  const elapsed = useElapsed(gen);
  const ready = gen.status === "succeeded";
  const details = gen.owner
    ? [{ label: "Made by", value: gen.owner.name ?? gen.owner.email }, ...videoDetails(gen)]
    : videoDetails(gen);
  return (
    <Viewer
      label="Video"
      title={details.find((row) => row.label === "Model")?.value ?? "Video"}
      kind="video"
      src={ready ? videoSrc(gen) : undefined}
      alt={gen.prompt}
      prompt={gen.prompt}
      references={videoRefs(gen)}
      details={details}
      error={gen.error}
      pending={ready ? undefined : <StatusOverlay gen={gen} elapsed={elapsed} />}
      onClose={onClose}
      onPrev={onPrev}
      onNext={onNext}
      onReuse={onReuse}
      onUseTemplate={onUseTemplate}
      onUseAsReference={ready && gen.stored ? onUseAsReference : undefined}
      onContinue={onContinue}
      continueBusy={continueBusy}
      extendOffer={extendOffer}
      onNativeExtend={onNativeExtend}
      onDelete={onDelete}
      downloadHref={ready ? videoDownloadHref(gen) : undefined}
      tools={gen.owner ? undefined : tools}
      toolKind="video"
      assetKey={gen.stored && !gen.owner ? `videos/${gen.id}.mp4` : undefined}
      toolAsset={{ duration: gen.duration }}
      keyed={keyed}
      onOpenKeys={onOpenKeys}
      onToolJob={onToolJob}
      audios={audios}
      onUploadAudio={onUploadAudio}
    />
  );
}

function ExtendPart({
  job,
  source,
  canExtend,
  continueBusy,
  onContinue,
  onExtend,
  onReuse,
  onDelete,
}: {
  job: FalJobView;
  source?: Generation;
  canExtend: boolean;
  continueBusy: boolean;
  onContinue: (src: string, source: Generation) => void;
  onExtend: (modelId: string, assetKey: string, prompt: string) => Promise<void>;
  onReuse: (source: Generation) => void;
  onDelete: () => void;
}) {
  const output = job.outputs.find((item) => item.contentType.startsWith("video/"));
  const mine = !job.owner;
  const [prompt, setPrompt] = useState(job.prompt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <article className="overflow-hidden rounded-2xl border border-white/5 bg-panel">
      <div className="relative grid aspect-video place-items-center bg-black">
        {job.owner && <OwnerBadge owner={job.owner} className="absolute top-2 left-2 z-10" />}
        {output ? (
          <video
            src={assetFileUrl(output.key, { owner: job.owner?.id })}
            controls
            playsInline
            className="size-full object-contain"
          />
        ) : (
          <p className="text-xs text-zinc-400 capitalize">
            {job.status}
            {job.error ? ` · ${job.error}` : ""}
          </p>
        )}
      </div>
      <div className="space-y-2 p-3.5">
        <p className="line-clamp-2 text-sm text-zinc-300">{job.prompt || "Extend"}</p>
        <p className="text-[10px] text-zinc-500">{job.tool?.name ?? "Extend"}</p>
        <div className="flex flex-wrap gap-1.5">
          {output && source && mine && (
            <PartButton disabled={continueBusy} onClick={() => onContinue(assetBytesUrl(output.key), source)}>
              {continueBusy ? "Saving…" : "Continue"}
            </PartButton>
          )}
          {source && <PartButton onClick={() => onReuse(source)}>Reuse</PartButton>}
          {mine && <PartButton onClick={onDelete}>Delete</PartButton>}
        </div>
        {output && source && canExtend && mine && (
          <form
            className="grid gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              const next = prompt.trim();
              if (!next || busy) return;
              setBusy(true);
              setError(null);
              void onExtend(source.model, output.key, next)
                .catch((err: unknown) => setError(err instanceof Error ? err.message : "Couldn't extend"))
                .finally(() => setBusy(false));
            }}
          >
            <textarea
              aria-label="What happens next"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={2}
              className="w-full resize-none rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1.5 text-xs text-zinc-100 outline-none"
            />
            {error && <p className="text-xs text-red-300">{error}</p>}
            <button
              type="submit"
              disabled={busy || !prompt.trim()}
              className="rounded-lg bg-white/10 py-1.5 text-xs hover:bg-white/15 disabled:opacity-40"
            >
              {busy ? "Starting…" : "Extend"}
            </button>
          </form>
        )}
      </div>
    </article>
  );
}

function PartButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-lg bg-white/5 px-2 py-1 text-[11px] text-zinc-300 hover:bg-white/10 hover:text-white disabled:opacity-40"
    >
      {children}
    </button>
  );
}
