"use client";

import { useEffect, useImperativeHandle, useRef, useState } from "react";
import { invalidMentions, mentionToken, remapMentions, type RefCounts, type RefKind } from "@/lib/mentions";
import {
  CAMERA_MOVE_MAX,
  cameraMoveLabel,
  cameraMovesFor,
  cameraPresets,
  compileCamera,
  estimateRouteCost,
  keptCameraMoves,
  type RouteProvider,
  type VideoModel,
} from "@/lib/registry";
import { availabilityFor, availabilityHint, routeProviders } from "@/lib/registry/availability";
import { preferredRoute } from "@/lib/registry/routing";
import type { GenerateRequest, GenerationMode } from "@/lib/types";
import { CameraMoves } from "./CameraMoves";
import { ModelMenu } from "./ModelMenu";
import { UnlockHint } from "./UnlockHint";
import type { UploadKind } from "@/lib/uploads";
import { fileSrc, thumbSrc, type Library, type LibraryItem } from "./library";
import { ImageSlot } from "./MediaInputs";
import { PromptEditor, type MentionItem, type PromptEditorHandle } from "./PromptEditor";
import { ReferenceBox } from "./ReferenceBox";

export interface Preset {
  key: number;
  model?: string;
  prompt?: string;
  ratio?: string;
  resolution?: string;
  duration?: number;
  generateAudio?: boolean;
  mode?: GenerationMode;
  /** Direct URL, for "continue from last frame". */
  firstFrame?: string;
  /** Library key of a start frame to restore. */
  firstFrameKey?: string;
  /** Library key of an end frame to restore. */
  lastFrameKey?: string;
  /** Library keys of reference blocks, in order. */
  referenceKeys?: string[];
  /** Inline note, for a Reuse that couldn't find every file. */
  notice?: string;
  /** Camera chips to restore, in order. */
  cameraMoves?: string[];
  /** One preset from a generation saved before chips. */
  cameraMove?: string;
  /** Provider this generation ran on. Reuse sends it again. */
  route?: string;
  /** Set when this generation continues another clip. */
  continueFrom?: string;
}

/** A frame is a library item, or a one-off URL that isn't in the library. */
interface FrameRef {
  id?: string;
  url?: string;
}

const findItem = (items: LibraryItem[], key: string) => items.find((i) => i.key === key || i.id === key);

function initialFrame(items: LibraryItem[], key?: string, url?: string): FrameRef | undefined {
  if (key) {
    const item = findItem(items, key);
    if (item) return { id: item.id };
  }
  if (url) return { url };
  return undefined;
}

function initialRefIds(items: LibraryItem[], keys?: string[]) {
  return (keys ?? []).flatMap((key) => {
    const item = findItem(items, key);
    return item ? [item.id] : [];
  });
}

/** Lets the Uploads panel add, remove and forget references. */
export interface ControlPanelHandle {
  /** Adds the item as a reference, or removes it if it already is one. */
  toggle: (item: LibraryItem) => void;
  /** Adds the item as a reference (no-op if it already is one). */
  add: (item: LibraryItem) => void;
  /** Drops a reference whose file is being deleted (call before removing it from the library). */
  forget: (id: string) => void;
  /** Switches to Frames and uses this image as the start frame. */
  setStartFrame: (item: LibraryItem) => void;
  /** Switches to References and attaches this item. */
  useAsReference: (item: LibraryItem) => void;
  /** Inline note in the panel. No alert(). */
  notify: (message: string) => void;
}

interface Props {
  ref?: React.Ref<ControlPanelHandle>;
  models: VideoModel[];
  /** Providers this user has a key for. Names only. */
  keyed: ReadonlySet<string>;
  routePreferences?: Readonly<Record<string, string>>;
  /** users.active_provider, used only when this model has no saved route. */
  defaultProvider?: string | null;
  onSaveRoute?: (modelId: string, provider: string) => void;
  preset: Preset;
  onGenerate: (req: GenerateRequest) => Promise<boolean>;
  error: string | null;
  library: Library;
  onOpenLibrary: () => void;
  onOpenKeys: () => void;
  /** Library item id → its mention ("@Image 2"), for showing selection in the Uploads panel. */
  onReferencesChange: (labels: Map<string, string>) => void;
}

const KIND: Record<UploadKind, RefKind> = { image: "Image", video: "Video", audio: "Audio" };
const PLURAL: Record<UploadKind, string> = { image: "images", video: "videos", audio: "audio clips" };

const clampDuration = (n: number, model: VideoModel) => {
  const cap = model.capabilities.durations;
  if (!cap) return n;
  if (cap.options?.length)
    return cap.options.reduce((best, step) => (Math.abs(step - n) < Math.abs(best - n) ? step : best), cap.options[0]);
  return Math.min(cap.max, Math.max(cap.min, n));
};

const pickResolution = (model: VideoModel, prefer?: string) => {
  const list = model.capabilities.resolutions;
  if (prefer && list.includes(prefer)) return prefer;
  if (list.includes("720p")) return "720p";
  return list[0] ?? "720p";
};

const pickRatio = (model: VideoModel, prefer?: string, hasFrame?: boolean) => {
  const list = model.capabilities.ratios;
  if (prefer && list.includes(prefer) && (prefer !== "adaptive" || hasFrame)) return prefer;
  return list.find((ratio) => ratio === "16:9") ?? list.find((ratio) => ratio !== "adaptive") ?? list[0] ?? "16:9";
};

export function ControlPanel({
  ref,
  models,
  keyed,
  routePreferences,
  defaultProvider,
  onSaveRoute,
  preset,
  onGenerate,
  error,
  library,
  onOpenLibrary,
  onOpenKeys,
  onReferencesChange,
}: Props) {
  const initialModel = models.find((m) => m.id === preset.model) ?? models[0];
  const [model, setModel] = useState<VideoModel>(initialModel);
  const [prompt, setPrompt] = useState(preset.prompt ?? "");
  const [ratio, setRatio] = useState(
    pickRatio(initialModel, preset.ratio, !!(preset.firstFrame || preset.firstFrameKey)),
  );
  const [resolution, setResolution] = useState(pickResolution(initialModel, preset.resolution));
  const [duration, setDuration] = useState(
    clampDuration(preset.duration ?? initialModel.capabilities.durations?.default ?? 5, initialModel),
  );
  const [generateAudio, setGenerateAudio] = useState(preset.generateAudio ?? true);
  const [mode, setMode] = useState<GenerationMode>(
    preset.mode === "references" && initialModel.capabilities.references.total > 0 ? "references" : "frames",
  );
  const [notice, setNotice] = useState(preset.notice ?? "");
  const [firstFrame, setFirstFrameRaw] = useState<FrameRef | undefined>(() =>
    initialFrame(library.items, preset.firstFrameKey, preset.firstFrame),
  );
  const [lastFrame, setLastFrame] = useState<FrameRef | undefined>(() => initialFrame(library.items, preset.lastFrameKey));
  // References: library item ids, in the order shown. Numbering is per kind.
  const [refIds, setRefIds] = useState<string[]>(() => initialRefIds(library.items, preset.referenceKeys));
  // Latest list for handlers that run after an await.
  const refsNow = useRef(refIds);
  const [seed, setSeed] = useState("");
  const [cameraMoves, setCameraMoves] = useState<string[]>(() =>
    keptCameraMoves(initialModel, preset.cameraMoves, preset.cameraMove),
  );
  const [routeChoice, setRouteChoice] = useState<string | undefined>(preset.route);
  const [cameraFixed, setCameraFixed] = useState(false);
  const [watermark, setWatermark] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [modeHover, setModeHover] = useState<GenerationMode | null>(null);
  const editor = useRef<PromptEditorHandle>(null);

  const caps = model.capabilities;
  const moves = cameraMovesFor(model);
  const showFixed = moves.length === 0 && !!(caps.camera && caps.camera.fixed);
  const durations = caps.durations;
  const hasRefs = caps.references.total > 0;
  const routesOpen = availabilityFor(routeProviders(model.routes), keyed).available;
  const effectiveMode: GenerationMode = hasRefs && mode === "references" && routesOpen ? "references" : "frames";
  // "adaptive" follows the start frame, so it only makes sense with one.
  const canAdapt = effectiveMode === "frames" && !!firstFrame && caps.frames.start;
  const audioOn = caps.audio === "required" || (caps.audio === "optional" && generateAudio);

  const byId = new Map(library.items.map((i) => [i.id, i]));
  const frameItem = (frame?: FrameRef) =>
    frame?.id ? (byId.get(frame.id) ?? library.items.find((i) => i.key === frame.id)) : undefined;
  const frameSrc = (frame?: FrameRef) => {
    if (!frame) return undefined;
    if (frame.url) return frame.url;
    const item = frameItem(frame);
    return item ? (thumbSrc(item) ?? (item.kind === "image" ? fileSrc(item) : undefined)) : undefined;
  };
  const framePayload = (frame?: FrameRef) => {
    if (!frame) return undefined;
    if (frame.id) {
      const item = frameItem(frame);
      return item?.key && item.status === "ready" ? `upload:${item.key}` : undefined;
    }
    return frame.url;
  };
  const framePending = (frame?: FrameRef) => {
    const item = frameItem(frame);
    return !!item && item.status !== "ready";
  };
  const tag = (ids: string[]) =>
    ids.flatMap((id) => {
      const item = byId.get(id);
      return item ? [{ id, kind: KIND[item.kind], item }] : [];
    });
  const refList = tag(refIds);
  const perKind = { Image: 0, Video: 0, Audio: 0 };
  const numbered = refList.map((r) => ({ ...r, n: ++perKind[r.kind] }));
  const blocks = numbered.map((r) => ({ item: r.item, label: mentionToken(r.kind, r.n) }));

  // @-mentions only resolve in references mode; anywhere else they're flagged.
  const refs = effectiveMode === "references";
  const referenceVideos = refs ? refList.filter((r) => r.item.kind === "video") : [];
  // A reference video with no readable length still selects the with-video rate.
  // Reference images are billed only when that model's formula says so.
  const referenceVideoSeconds = referenceVideos.length
    ? referenceVideos.reduce((sum, r) => sum + (r.item.duration ?? 0), 0)
    : undefined;
  const referenceImages = refs ? refList.filter((r) => r.item.kind === "image").length : undefined;
  const routeProvider = preferredRoute(model, keyed, [routeChoice, routePreferences?.[model.id], defaultProvider])?.provider;
  const estimateInput = { resolution, duration, audio: audioOn, referenceVideoSeconds, referenceImages };
  const cost = estimateRouteCost(model, routeProvider, estimateInput);
  const counts: RefCounts = refs ? perKind : { Image: 0, Video: 0, Audio: 0 };
  const badMentions = invalidMentions(prompt, counts);
  const mentionItems: MentionItem[] = !refs
    ? []
    : numbered.map(({ kind, n, item }) => ({
        token: mentionToken(kind, n),
        kind,
        n,
        thumb: item.kind === "image" ? thumbSrc(item) : undefined,
        preview: item.kind === "video" ? fileSrc(item) : undefined,
        detail: item.name,
      }));

  useEffect(() => {
    onReferencesChange(new Map(blocks.map((b) => [b.item.id, b.label])));
    // Only when the references or their numbering change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refIds.join(), library.items.length]);

  /** Every change to the list goes through here, so prompt mentions follow their file. */
  function updateRefs(next: string[]) {
    const prev = refsNow.current;
    refsNow.current = next;
    setRefIds(next);
    setPrompt((p) => remapMentions(p, tag(prev), tag(next)));
  }

  /** Adds library items as references, within the model's limits. Returns the ids added. */
  function addRefs(items: LibraryItem[]) {
    const current = tag(refsNow.current);
    const used = { image: 0, video: 0, audio: 0 };
    for (const r of current) used[r.item.kind]++;
    const limit = { image: caps.references.image, video: caps.references.video, audio: caps.references.audio };
    let total = current.length;
    const added: string[] = [];
    const skipped = new Set<UploadKind>();
    for (const item of items) {
      if (refsNow.current.includes(item.id) || added.includes(item.id)) continue;
      if (used[item.kind] >= limit[item.kind] || total >= caps.references.total) {
        skipped.add(item.kind);
        continue;
      }
      used[item.kind]++;
      total++;
      added.push(item.id);
    }
    if (added.length) {
      updateRefs([...refsNow.current, ...added]);
      // Picking a reference means References mode.
      setMode("references");
      if (ratio === "adaptive") setRatio("16:9");
    }
    if (skipped.size) {
      const message =
        [...skipped]
          .map((k) =>
            limit[k] === 0
              ? `${model.name} doesn't take ${PLURAL[k]} as references.`
              : `${model.name} takes up to ${limit[k]} ${PLURAL[k]} (${caps.references.total} references in total).`,
          )
          .join(" ") + " The files are still in your Uploads.";
      setNotice(message);
    }
    return added;
  }

  async function addFiles(files: File[]) {
    const { items, errors } = await library.add(files);
    if (errors.length) alert(errors.join("\n"));
    const added = addRefs(items);
    return items.filter((i) => added.includes(i.id));
  }

  /** Pasted into the prompt: attach as references and mention them where the cursor is. */
  async function pasteFiles(files: File[]) {
    const counts = { Image: 0, Video: 0, Audio: 0 };
    for (const r of tag(refsNow.current)) counts[r.kind]++;
    const added = await addFiles(files);
    if (added.length)
      editor.current?.insert(added.map((i) => mentionToken(KIND[i.kind], ++counts[KIND[i.kind]])).join(" "));
  }

  function removeRef(index: number) {
    const id = blocks[index]?.item.id;
    if (id) updateRefs(refsNow.current.filter((x) => x !== id));
  }

  function moveRef(from: number, to: number) {
    const ids = blocks.map((b) => b.item.id);
    if (from === to || !ids[from]) return;
    ids.splice(to, 0, ...ids.splice(from, 1));
    updateRefs(ids);
  }

  function mentionRef(index: number) {
    const b = blocks[index];
    if (b) editor.current?.insert(b.label);
  }

  function setFirstFrame(v: FrameRef | undefined) {
    setFirstFrameRaw(v);
    if (!v && ratio === "adaptive") setRatio("16:9");
  }

  async function pickFrame(which: "first" | "last", file: File) {
    const { items, errors } = await library.add([file]);
    if (errors.length) setNotice(errors.join(" "));
    const item = items[0];
    if (!item) return;
    if (which === "first") setFirstFrame({ id: item.id });
    else setLastFrame({ id: item.id });
  }

  useImperativeHandle(ref, () => ({
    toggle(item) {
      if (!hasRefs) {
        alert(`${model.name} doesn't take references. Pick a model that does.`);
        return;
      }
      if (refsNow.current.includes(item.id)) updateRefs(refsNow.current.filter((x) => x !== item.id));
      else addRefs([item]);
    },
    add(item) {
      if (!hasRefs) alert(`${model.name} doesn't take references. Pick a model that does.`);
      else addRefs([item]);
    },
    forget(id) {
      if (refsNow.current.includes(id)) updateRefs(refsNow.current.filter((x) => x !== id));
    },
    setStartFrame(item) {
      if (item.kind !== "image") {
        setNotice("Only an image can be a start frame.");
        return;
      }
      if (!model.capabilities.frames.start) {
        setNotice(`${model.name} doesn't support a start frame.`);
        return;
      }
      setMode("frames");
      setFirstFrame({ id: item.id });
      setNotice("");
    },
    useAsReference(item) {
      if (!hasRefs) {
        setNotice(`${model.name} doesn't take references. Pick a model that does.`);
        return;
      }
      addRefs([item]);
    },
    notify(message) {
      setNotice(message);
    },
  }));

  function changeMode(m: GenerationMode) {
    if (!routesOpen) return;
    setMode(m);
    if (m === "references" && ratio === "adaptive") setRatio("16:9");
  }

  function changeModel(id: string) {
    const m = models.find((x) => x.id === id);
    if (!m || !availabilityFor(routeProviders(m.routes), keyed).available) return;
    setModel(m);
    if (!m.capabilities.ratios.includes(ratio)) setRatio(pickRatio(m));
    setResolution(pickResolution(m, resolution));
    setDuration((d) => clampDuration(d, m));
    if (!m.capabilities.frames.end) setLastFrame(undefined);
    if (!m.capabilities.frames.start) setFirstFrame(undefined);
    setCameraMoves((moves) => keptCameraMoves(m, moves));
    setRouteChoice(undefined);
  }

  function changeRoute(provider: RouteProvider) {
    if (!availabilityFor([provider], keyed).available) return;
    if (!model.routes.some((item) => item.provider === provider)) return;
    setRouteChoice(provider);
    onSaveRoute?.(model.id, provider);
  }

  const uploading =
    (refs && refList.some((r) => r.item.status !== "ready")) ||
    (effectiveMode === "frames" && (framePending(firstFrame) || framePending(lastFrame)));
  const gate = availabilityFor(routeProviders(model.routes), keyed);
  const canSubmit =
    gate.available &&
    !submitting &&
    !uploading &&
    badMentions.length === 0 &&
    (prompt.trim().length > 0 ||
      (!model.promptRequired && (effectiveMode === "frames" ? !!framePayload(firstFrame) : perKind.Image > 0)));

  const refValues = (kind: UploadKind) =>
    refList.filter((r) => r.item.kind === kind).map((r) => `upload:${r.item.key}`);

  function changeCamera(id: string, toggle: boolean) {
    if (!moves.includes(id)) return;
    if (cameraMoves.includes(id)) {
      if (toggle) setCameraMoves(cameraMoves.filter((move) => move !== id));
      return;
    }
    if (cameraMoves.length >= CAMERA_MOVE_MAX) {
      setNotice(`Up to ${CAMERA_MOVE_MAX} camera moves.`);
      return;
    }
    setCameraMoves([...cameraMoves, id]);
  }

  const compiled = moves.length ? compileCamera(model, prompt, cameraMoves) : undefined;

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    const frames = effectiveMode === "frames";
    const ok = await onGenerate({
      model: model.id,
      prompt,
      mode: effectiveMode,
      ratio,
      resolution,
      duration,
      route: routeProvider,
      generateAudio: caps.audio === "required" ? true : caps.audio === "optional" ? generateAudio : undefined,
      seed: caps.seed && seed.trim() !== "" ? Number(seed) : undefined,
      cameraMoves: moves.length && cameraMoves.length ? cameraMoves : undefined,
      cameraFixed: showFixed ? cameraFixed : undefined,
      watermark: caps.watermark ? watermark : undefined,
      ...(frames
        ? {
            firstFrame: caps.frames.start ? framePayload(firstFrame) : undefined,
            lastFrame: caps.frames.end && framePayload(firstFrame) ? framePayload(lastFrame) : undefined,
            ...(caps.frames.start &&
            framePayload(firstFrame) &&
            preset.continueFrom &&
            preset.firstFrameKey &&
            frameItem(firstFrame)?.key === preset.firstFrameKey
              ? { continueFrom: preset.continueFrom }
              : {}),
          }
        : {
            referenceImages: refValues("image"),
            referenceVideos: refValues("video"),
            referenceAudios: refValues("audio"),
            referenceOrder: refList.flatMap((r) => (r.item.key ? [r.item.key] : [])),
          }),
    }).finally(() => setSubmitting(false));
    if (ok) setSeed("");
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 pb-5">
        {notice && (
          <p data-testid="reference-limit" className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
            {notice}
          </p>
        )}
        <Section label="Model">
          <ModelMenu
            models={models}
            value={model.id}
            route={routeProvider}
            estimate={estimateInput}
            keyed={keyed}
            onChange={changeModel}
            onRoute={changeRoute}
            onOpenKeys={onOpenKeys}
          />
          <p className="mt-1.5 text-xs text-zinc-500">{model.description}</p>
        </Section>

        {hasRefs && (
          <div onMouseLeave={() => setModeHover(null)}>
            <div className="grid grid-cols-2 gap-1 rounded-xl bg-white/[0.04] p-1 text-sm">
              {(["frames", "references"] as const).map((m) => {
                const active = effectiveMode === m;
                return (
                  <button
                    key={m}
                    type="button"
                    data-testid={`mode-${m}`}
                    data-available={routesOpen ? "true" : "false"}
                    aria-disabled={!routesOpen}
                    aria-pressed={active && routesOpen}
                    onMouseEnter={() => setModeHover(m)}
                    onClick={() => {
                      if (!routesOpen) {
                        setModeHover(m);
                        return;
                      }
                      changeMode(m);
                    }}
                    className={`rounded-lg py-1.5 capitalize transition ${
                      !routesOpen
                        ? "cursor-not-allowed text-zinc-600"
                        : active
                          ? "bg-white/10 text-white"
                          : "text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    {m}
                  </button>
                );
              })}
            </div>
            {modeHover && !routesOpen && (
              <div className="mt-2">
                <UnlockHint hint={availabilityHint(gate.needs)} onOpen={onOpenKeys} />
              </div>
            )}
          </div>
        )}

        {effectiveMode === "frames" ? (
          (caps.frames.start || caps.frames.end) && (
            <div className={`grid gap-3 ${caps.frames.start && caps.frames.end ? "grid-cols-2" : "grid-cols-1"}`}>
              {caps.frames.start && (
                <ImageSlot
                  label="Start frame"
                  value={frameSrc(firstFrame)}
                  onChange={(v) => !v && setFirstFrame(undefined)}
                  onFile={(file) => void pickFrame("first", file)}
                />
              )}
              {caps.frames.end && (
                <ImageSlot
                  label="End frame"
                  value={frameSrc(lastFrame)}
                  onChange={(v) => !v && setLastFrame(undefined)}
                  onFile={(file) => void pickFrame("last", file)}
                  disabled={!firstFrame}
                />
              )}
            </div>
          )
        ) : (
          <ReferenceBox
            blocks={blocks}
            max={caps.references.total}
            onAddFiles={(files) => void addFiles(files)}
            onOpenLibrary={onOpenLibrary}
            onRemove={removeRef}
            onMove={moveRef}
            onMention={mentionRef}
          />
        )}

        <Section label="Prompt" aside={model.promptRequired ? undefined : "optional with an image"}>
          <PromptEditor
            ref={editor}
            value={prompt}
            onChange={setPrompt}
            onSubmit={submit}
            onPasteFiles={(files) => void pasteFiles(files)}
            mentions={mentionItems}
            counts={counts}
            placeholder={
              refs
                ? "The cat from @Image 1 dances on the rooftop from @Image 2… (type @ to reference, # for a camera move)"
                : "A paper boat in the rain… (type # for a camera move)"
            }
            cameras={
              moves.length
                ? cameraPresets
                    .filter((preset) => moves.includes(preset.id))
                    .map((preset) => ({
                      id: preset.id,
                      name: preset.name,
                      description: preset.description,
                      category: preset.category,
                    }))
                : undefined
            }
            onAddCamera={(id) => changeCamera(id, false)}
          />
          {cameraMoves.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {cameraMoves.map((id, index) => (
                <span
                  key={`${id}-${index}`}
                  className="inline-flex items-center gap-1 rounded-full border border-accent/40 bg-accent/10 py-0.5 pr-1 pl-2 text-xs text-accent"
                >
                  {cameraMoveLabel(id) ?? id}
                  <button
                    type="button"
                    aria-label={`Remove ${cameraMoveLabel(id) ?? "camera move"}`}
                    onClick={() => setCameraMoves((cur) => cur.filter((_, at) => at !== index))}
                    className="grid size-4 place-items-center rounded-full text-accent/80 hover:bg-accent/20 hover:text-accent"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          {compiled && cameraMoves.length > 0 && (
            <div className="mt-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs leading-relaxed text-zinc-300">
              <p className="mb-1 text-[10px] font-medium tracking-wide text-zinc-500 uppercase">Prompt sent</p>
              <p>{compiled.prompt || "—"}</p>
              {compiled.cameraFixed && <p className="mt-1 text-zinc-500">Static is sent as a fixed camera.</p>}
            </div>
          )}
          {badMentions.length > 0 && (
            <p className="mt-1.5 text-xs text-red-300">
              {refs
                ? `${badMentions.join(", ")} ${badMentions.length === 1 ? "doesn't" : "don't"} match an attached reference`
                : "@-references only work in References mode"}
            </p>
          )}
        </Section>

        {moves.length > 0 && (
          <Section label="Camera" aside={cameraMoves.length ? `${cameraMoves.length}/${CAMERA_MOVE_MAX}` : "Type #"}>
            <CameraMoves value={cameraMoves} onToggle={(id) => changeCamera(id, true)} />
          </Section>
        )}

        {caps.ratios.length > 0 && <Section label="Aspect ratio">
          <div className="flex flex-wrap gap-1.5">
            {caps.ratios.map((r) => (
              <Chip
                key={r}
                active={ratio === r}
                onClick={() => setRatio(r)}
                disabled={r === "adaptive" && !canAdapt}
                title={r === "adaptive" ? "Match the start frame's shape" : undefined}
              >
                {r === "adaptive" ? "Auto" : r}
              </Chip>
            ))}
          </div>
        </Section>}

        {caps.resolutions.length > 0 && <Section label="Resolution">
          <div className="flex gap-1.5">
            {caps.resolutions.map((r) => (
              <Chip key={r} active={resolution === r} onClick={() => setResolution(r)}>
                {r === "4k" ? "4K" : r}
              </Chip>
            ))}
          </div>
        </Section>}

        {durations && (
          <Section label="Duration" aside={`${duration}s`}>
            {durations.options ? (
              <div className="flex flex-wrap gap-1.5">
                {durations.options.map((step) => (
                  <Chip key={step} active={duration === step} onClick={() => setDuration(step)}>
                    {step}s
                  </Chip>
                ))}
              </div>
            ) : (
              <input
                type="range"
                min={durations.min}
                max={durations.max}
                value={duration}
                onChange={(e) => setDuration(Number(e.target.value))}
                className="w-full accent-[var(--color-accent)]"
              />
            )}
          </Section>
        )}

        {caps.audio === "optional" && (
          <Toggle label="Generate audio" checked={generateAudio} onChange={setGenerateAudio} />
        )}
        {caps.audio === "required" && <p className="text-xs text-zinc-500">Audio is included with this model.</p>}

        {(caps.seed || showFixed || caps.watermark) && (
          <div>
            <button onClick={() => setShowAdvanced((s) => !s)} className="text-xs text-zinc-500 hover:text-zinc-300">
              {showAdvanced ? "− Hide" : "+ Show"} advanced
            </button>
            {showAdvanced && (
              <div className="mt-3 space-y-3">
                {caps.seed && (
                  <Section label="Seed">
                    <div className="flex gap-2">
                      <input
                        value={seed}
                        onChange={(e) => setSeed(e.target.value.replace(/[^\d-]/g, ""))}
                        placeholder="Random"
                        className="w-full rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-2 text-sm outline-none focus:border-accent/60"
                      />
                      <button
                        onClick={() => setSeed(String(Math.floor(Math.random() * 2 ** 31)))}
                        className="rounded-xl border border-white/10 px-3 text-sm text-zinc-400 hover:text-white"
                        title="Pick a random seed"
                      >
                        🎲
                      </button>
                    </div>
                  </Section>
                )}
                {showFixed && <Toggle label="Fixed camera" checked={cameraFixed} onChange={setCameraFixed} />}
                {caps.watermark && <Toggle label="Watermark" checked={watermark} onChange={setWatermark} />}
              </div>
            )}
          </div>
        )}
      </div>

      <div data-testid="generate-bar" className="border-t border-white/5 p-5">
        {error && <p className="mb-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</p>}
        {!gate.available && (
          <div className="mb-3">
            <UnlockHint hint={availabilityHint(gate.needs)} onOpen={onOpenKeys} />
          </div>
        )}
        <button
          type="button"
          data-testid="generate"
          onClick={submit}
          disabled={!canSubmit}
          className={`flex w-full items-center justify-center gap-2 rounded-xl py-3 text-sm font-semibold transition disabled:cursor-not-allowed ${
            gate.available
              ? "bg-accent text-ink hover:brightness-110 disabled:opacity-40"
              : "cursor-not-allowed bg-white/10 text-zinc-500"
          }`}
        >
          {submitting ? (
            <span className="size-4 animate-spin rounded-full border-2 border-ink/30 border-t-ink" />
          ) : (
            "Generate"
          )}
          <span className="text-xs font-normal opacity-60">
            {resolution}
            {durations ? ` · ${duration}s` : ""}
            {cost !== undefined && ` · ~$${cost.toFixed(2)}`}
          </span>
        </button>
      </div>
    </div>
  );
}

function Section({ label, aside, children }: { label: string; aside?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-xs font-medium tracking-wide text-zinc-400 uppercase">
        <span>{label}</span>
        {aside && <span className="text-zinc-200 normal-case">{aside}</span>}
      </div>
      {children}
    </div>
  );
}

function Chip({
  active,
  onClick,
  disabled,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`rounded-lg border px-2.5 py-1.5 text-xs transition disabled:cursor-not-allowed disabled:opacity-30 ${
        active
          ? "border-accent/70 bg-accent/10 text-accent"
          : "border-white/10 text-zinc-400 hover:border-white/25 hover:text-zinc-200"
      }`}
    >
      {children}
    </button>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center justify-between text-sm text-zinc-300">
      {label}
      <button
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative h-5 w-9 rounded-full transition ${checked ? "bg-accent" : "bg-white/15"}`}
      >
        <span
          className={`absolute top-0.5 size-4 rounded-full bg-white transition-all ${checked ? "left-[18px]" : "left-0.5"}`}
        />
      </button>
    </label>
  );
}
