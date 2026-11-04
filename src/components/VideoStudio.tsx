"use client";

// The Video tab: Seedance generations with the control panel on the left.

import { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { shouldPollFal, type FalJobView } from "@/lib/falTypes";
import { restoreInputs } from "@/lib/inputs";
import { extractLastFrame, generationBytesUrl } from "@/lib/lastFrame";
import { isVideo, MODELS, type VideoModel } from "@/lib/registry";
import { availabilityFor, routeProviders, sortByAvailability } from "@/lib/registry/availability";
import { groupFeed, isNumberedSequence } from "@/lib/sequence";
import type { ExtendOffer, ToolView } from "@/lib/toolTypes";
import { TERMINAL_STATUSES, type GenerateRequest, type Generation } from "@/lib/types";
import { assetFileUrl } from "@/lib/uploads";
import { api, apiJson, type Me } from "./api";
import { ControlPanel, type ControlPanelHandle, type Preset } from "./ControlPanel";
import { GenerationCard } from "./GenerationCard";
import type { Library, LibraryItem } from "./library";
import { Lightbox } from "./Lightbox";
import { UploadsPanel } from "./UploadsPanel";

const POLL_MS = 5000;

const needsPoll = (g: Generation) => !TERMINAL_STATUSES.includes(g.status) || (g.status === "succeeded" && !g.stored);

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
}) {
  const [generations, setGenerations] = useState<Generation[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [preset, setPreset] = useState<Preset>({ key: 0 });
  const [open, setOpen] = useState<Generation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [continueBusy, setContinueBusy] = useState(false);
  const [extendJobs, setExtendJobs] = useState<FalJobView[]>([]);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [refLabels, setRefLabels] = useState<Map<string, string>>(new Map());
  const panel = useRef<ControlPanelHandle>(null);
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

  useImperativeHandle(ref, () => ({
    addReference(item) {
      if (panel.current) panel.current.add(item);
      else alert("Add an API key first to generate videos.");
    },
    setStartFrame(item) {
      if (panel.current) panel.current.setStartFrame(item);
      else alert("Add an API key first to generate videos.");
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
      const pending = jobsRef.current.filter((job) => job.sequenceId && shouldPollFal(job.status));
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
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }

  async function remove(gen: Generation) {
    setGenerations((prev) => prev.filter((g) => g.id !== gen.id));
    if (open?.id === gen.id) setOpen(null);
    await api(`/api/generations/${gen.id}`, { method: "DELETE" });
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
    const available = new Set(library.items.flatMap((i) => (i.key ? [i.key] : [])));
    // Don't claim files were deleted while the library is still loading.
    const restored = extra?.frameKey || !library.loaded ? undefined : restoreInputs(gen, available);
    const waiting = !extra?.frameKey && !library.loaded;
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
      mode: extra?.frameKey ? "frames" : (restored?.mode ?? gen.mode),
      firstFrameKey: extra?.frameKey ?? restored?.firstFrameKey,
      lastFrameKey: extra?.frameKey ? undefined : restored?.lastFrameKey,
      referenceKeys: extra?.frameKey ? undefined : restored?.referenceKeys,
      continueFrom: extra?.continueFrom,
      notice:
        frameNote ??
        (waiting
          ? "Uploads are still loading, so frames and references weren't restored. Try Reuse again in a moment."
          : restored?.notice),
    }));
  }

  async function continueClip(gen: Generation) {
    setContinueBusy(true);
    setError(null);
    try {
      const blob = await extractLastFrame(generationBytesUrl(gen.id));
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

  async function nativeExtend(gen: Generation, prompt: string) {
    const offer = extendOffers.find((item) => item.modelIds.includes(gen.model));
    if (!offer) throw new Error("This model can't extend a video");
    const probe = await api(generationBytesUrl(gen.id), { headers: { Range: "bytes=0-1" } });
    await probe.body?.cancel().catch(() => {});
    if (!probe.ok) throw new Error("Save the video before extending it");
    const job = await apiJson<FalJobView>("/api/fal", {
      method: "POST",
      body: JSON.stringify({ toolId: offer.id, assetIds: [`videos/${gen.id}.mp4`], params: { prompt } }),
    });
    setExtendJobs((prev) => [job, ...prev.filter((item) => item.id !== job.id)]);
    setGenerations(await apiJson<Generation[]>("/api/generations"));
    setOpen(null);
  }

  async function outputItem(gen: Generation) {
    const match = (items: LibraryItem[]) => items.find((i) => i.generation?.id === gen.id && i.kind === "video");
    return match(library.items) ?? match(await library.reload());
  }

  async function referenceStoredVideo(gen: Generation) {
    setOpen(null);
    if (!panel.current) {
      alert("Add an API key first to generate videos.");
      return;
    }
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
  const models = sortByAvailability(catalog(), (model) => availabilityFor(routeProviders(model.routes), keyed).available);
  const active = generations.filter((g) => !TERMINAL_STATUSES.includes(g.status)).length;

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col overflow-hidden lg:flex-row">
      <aside className="flex min-h-0 w-full shrink-0 flex-col overflow-hidden border-b border-white/5 bg-panel lg:h-full lg:w-[400px] lg:border-r lg:border-b-0">
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
          <ControlPanel
            ref={panel}
            key={me ? preset.key : "pending"}
            library={library}
            onOpenLibrary={() => setLibraryOpen(true)}
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
          />
        )}
      </aside>

      <main className="min-h-0 flex-1 overflow-y-auto">
        {libraryOpen ? (
          <UploadsPanel
            library={library}
            selected={refLabels}
            onToggle={(item) => panel.current?.toggle(item)}
            onDelete={deleteUpload}
            onClose={() => setLibraryOpen(false)}
          />
        ) : (
          <>
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-white/5 bg-ink/80 px-6 py-4 backdrop-blur">
              <h1 className="text-sm font-medium text-zinc-300">
                Generations <span className="text-zinc-500">· {generations.length}</span>
              </h1>
              <button
                onClick={() => setLibraryOpen(true)}
                className="rounded-full bg-white/5 px-3 py-1.5 text-xs text-zinc-300 hover:bg-white/10"
              >
                Uploads
              </button>
            </div>

            {loaded && feed.length === 0 ? (
              <div className="grid h-[60vh] place-items-center text-center">
                <div>
                  <p className="text-lg font-medium text-zinc-300">No videos yet</p>
                  <p className="mt-1 text-sm text-zinc-500">
                    {keyed.size ? "Write a prompt and hit Generate to start." : "Add an API key to start generating."}
                  </p>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4 p-6 sm:grid-cols-2 2xl:grid-cols-3">
                {feed.map((group) => {
                  const numbered = isNumberedSequence(group.parts);
                  const cards = group.parts.map((item) => (
                    <div key={item.id}>
                      {numbered && (
                        <p data-testid="sequence-part" className="mb-1.5 text-[11px] font-medium text-zinc-400">
                          Part {item.part}
                        </p>
                      )}
                      {item.kind === "generation" ? (
                        <GenerationCard
                          gen={item.gen}
                          onOpen={() => setOpen(item.gen)}
                          onReuse={() => reuse(item.gen)}
                          onUseAsReference={() => void referenceStoredVideo(item.gen)}
                          onDelete={() => remove(item.gen)}
                        />
                      ) : (
                        <ExtendPart job={item.job} />
                      )}
                    </div>
                  ));
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
                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 2xl:grid-cols-3">{cards}</div>
                    </section>
                  );
                })}
              </div>
            )}
          </>
        )}
      </main>

      {open && (
        <Lightbox
          key={open.id}
          gen={open}
          onClose={() => setOpen(null)}
          onReuse={() => reuse(open)}
          onUseAsReference={() => void referenceStoredVideo(open)}
          onContinue={open.status === "succeeded" ? () => void continueClip(open) : undefined}
          continueBusy={continueBusy}
          extendOffer={extendOffers.find((offer) => offer.modelIds.includes(open.model))}
          onNativeExtend={(prompt) => nativeExtend(open, prompt)}
          onDelete={() => remove(open)}
          tools={tools}
          keyed={keyed}
          onOpenKeys={onOpenKeys}
          onToolJob={onToolJob}
        />
      )}
    </div>
  );
}

function ExtendPart({ job }: { job: FalJobView }) {
  const output = job.outputs.find((item) => item.contentType.startsWith("video/"));
  return (
    <article className="overflow-hidden rounded-2xl border border-white/5 bg-panel">
      <div className="relative grid aspect-video place-items-center bg-black">
        {output ? (
          <video src={assetFileUrl(output.key)} controls playsInline className="size-full object-contain" />
        ) : (
          <p className="text-xs text-zinc-400 capitalize">
            {job.status}
            {job.error ? ` · ${job.error}` : ""}
          </p>
        )}
      </div>
      <div className="space-y-1 p-3.5">
        <p className="line-clamp-2 text-sm text-zinc-300">{job.prompt || "Extend"}</p>
        <p className="text-[10px] text-zinc-500">{job.tool?.name ?? "Extend"}</p>
      </div>
    </article>
  );
}
