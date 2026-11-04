"use client";

// The Video tab: Seedance generations with the control panel on the left.

import { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { restoreInputs } from "@/lib/inputs";
import { isVideo, MODELS, type VideoModel } from "@/lib/registry";
import { availabilityFor, routeProviders, sortByAvailability } from "@/lib/registry/availability";
import { TERMINAL_STATUSES, type GenerateRequest, type Generation } from "@/lib/types";
import { confirmToast, toast } from "@/components/ui/Toast";
import { assetFileUrl } from "@/lib/uploads";
import { api, apiJson, type Me } from "./api";
import { ControlPanel, type ControlPanelHandle, type Preset } from "./ControlPanel";
import { GenerationCard, StatusOverlay, useElapsed, videoSrc } from "./GenerationCard";
import type { Library, LibraryItem } from "./library";
import type { ToolView } from "@/lib/toolTypes";
import { UploadsPanel } from "./UploadsPanel";
import { Viewer } from "./Viewer";
import { videoDetails } from "./viewer/details";

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
  onToolJob,
}: {
  ref?: React.Ref<StudioTabHandle>;
  me: Me | null;
  library: Library;
  onOpenKeys: () => void;
  /** Null until /api/models returns. Empty when that request failed. */
  openRouterModels: VideoModel[] | null;
  tools: readonly ToolView[];
  onToolJob: () => void;
}) {
  const [generations, setGenerations] = useState<Generation[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [preset, setPreset] = useState<Preset>({ key: 0 });
  const [open, setOpen] = useState<Generation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [refLabels, setRefLabels] = useState<Map<string, string>>(new Map());
  const panel = useRef<ControlPanelHandle>(null);
  const defaultProvider = me?.user.activeProvider ?? null;
  const [routePreferences, setRoutePreferences] = useState<Record<string, string>>(me?.routePreferences ?? {});
  const gensRef = useRef(generations);
  const openIndex = open ? generations.findIndex((item) => item.id === open.id) : -1;
  useEffect(() => {
    gensRef.current = generations;
  }, [generations]);

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
      else toast("Add an API key first to generate videos.");
    },
    setStartFrame(item) {
      if (panel.current) panel.current.setStartFrame(item);
      else toast("Add an API key first to generate videos.");
    },
    reload() {
      apiJson<Generation[]>("/api/generations")
        .then(setGenerations)
        .catch(() => {});
    },
  }));

  useEffect(() => {
    apiJson<Generation[]>("/api/generations")
      .then(setGenerations)
      .finally(() => setLoaded(true));
  }, []);

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
    const ok = await confirmToast("Delete this generation? This can't be undone.", { confirmLabel: "Delete" });
    if (!ok) return;
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

  function reuse(gen: Generation, asFirstFrame?: string) {
    setOpen(null);
    const available = new Set(library.items.flatMap((i) => (i.key ? [i.key] : [])));
    // Don't claim files were deleted while the library is still loading.
    const restored = asFirstFrame || !library.loaded ? undefined : restoreInputs(gen, available);
    const waiting = !asFirstFrame && !library.loaded;
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
      mode: asFirstFrame ? "frames" : (restored?.mode ?? gen.mode),
      firstFrame: asFirstFrame,
      firstFrameKey: restored?.firstFrameKey,
      lastFrameKey: restored?.lastFrameKey,
      referenceKeys: restored?.referenceKeys,
      notice: waiting
        ? "Uploads are still loading, so frames and references weren't restored. Try Reuse again in a moment."
        : restored?.notice,
    }));
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

            {loaded && generations.length === 0 ? (
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
                {generations.map((g) => (
                  <GenerationCard
                    key={g.id}
                    gen={g}
                    onOpen={() => setOpen(g)}
                    onReuse={() => reuse(g)}
                    onUseAsReference={() => void referenceStoredVideo(g)}
                    onDelete={() => remove(g)}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </main>

      {open && (
        <OpenVideo
          gen={open}
          onClose={() => setOpen(null)}
          onPrev={
            openIndex > 0
              ? () => {
                  const prev = generations[openIndex - 1];
                  if (prev) setOpen(prev);
                }
              : undefined
          }
          onNext={
            openIndex >= 0 && openIndex < generations.length - 1
              ? () => {
                  const next = generations[openIndex + 1];
                  if (next) setOpen(next);
                }
              : undefined
          }
          onReuse={() => reuse(open)}
          onUseAsReference={() => void referenceStoredVideo(open)}
          onExtend={open.lastFrameUrl ? () => reuse(open, open.lastFrameUrl) : undefined}
          onDelete={() => remove(open)}
          tools={tools}
          keyed={keyed}
          onOpenKeys={onOpenKeys}
          onToolJob={() => {
            setOpen(null);
            onToolJob();
          }}
        />
      )}
    </div>
  );
}

function videoRefs(gen: Generation) {
  const refs: { src: string; alt: string }[] = [];
  const add = (key?: string, alt?: string) => {
    if (key) refs.push({ src: assetFileUrl(key), alt: alt || "Reference" });
  };
  add(gen.inputs.firstFrameKey, gen.inputs.firstFrameName ?? "Start frame");
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
  onUseAsReference,
  onExtend,
  onDelete,
  tools,
  keyed,
  onOpenKeys,
  onToolJob,
}: {
  gen: Generation;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  onReuse: () => void;
  onUseAsReference: () => void;
  onExtend?: () => void;
  onDelete: () => void;
  tools: readonly ToolView[];
  keyed: ReadonlySet<string>;
  onOpenKeys: () => void;
  onToolJob: () => void;
}) {
  const elapsed = useElapsed(gen);
  const ready = gen.status === "succeeded";
  const details = videoDetails(gen);
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
      poster={gen.lastFrameUrl}
      pending={ready ? undefined : <StatusOverlay gen={gen} elapsed={elapsed} />}
      onClose={onClose}
      onPrev={onPrev}
      onNext={onNext}
      onReuse={onReuse}
      onUseAsReference={ready && gen.stored ? onUseAsReference : undefined}
      onExtend={onExtend}
      onDelete={onDelete}
      downloadHref={ready ? `${videoSrc(gen)}?download` : undefined}
      tools={tools}
      toolKind="video"
      assetKey={gen.stored ? `videos/${gen.id}.mp4` : undefined}
      toolAsset={{ duration: gen.duration }}
      keyed={keyed}
      onOpenKeys={onOpenKeys}
      onToolJob={onToolJob}
    />
  );
}
