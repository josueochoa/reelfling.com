"use client";

import { useEffect, useImperativeHandle, useRef, useState } from "react";
import { invalidMentions, mentionToken, remapMentions, type RefCounts, type RefKind } from "@/lib/mentions";
import { estimateCost, type ModelSpec, type Ratio, type Resolution } from "@/lib/models";
import type { GenerateRequest, GenerationMode } from "@/lib/types";
import type { UploadKind } from "@/lib/uploads";
import { fileSrc, thumbSrc, type Library, type LibraryItem } from "./library";
import { ImageSlot } from "./MediaInputs";
import { PromptEditor, type MentionItem, type PromptEditorHandle } from "./PromptEditor";
import { ReferenceBox } from "./ReferenceBox";

export interface Preset {
  key: number;
  model?: string;
  prompt?: string;
  ratio?: Ratio;
  resolution?: Resolution;
  duration?: number;
  generateAudio?: boolean;
  firstFrame?: string;
}

/** Lets the Uploads panel add, remove and forget references. */
export interface ControlPanelHandle {
  /** Adds the item as a reference, or removes it if it already is one. */
  toggle: (item: LibraryItem) => void;
  /** Adds the item as a reference (no-op if it already is one). */
  add: (item: LibraryItem) => void;
  /** Drops a reference whose file is being deleted (call before removing it from the library). */
  forget: (id: string) => void;
}

interface Props {
  ref?: React.Ref<ControlPanelHandle>;
  models: ModelSpec[];
  preset: Preset;
  onGenerate: (req: GenerateRequest) => Promise<boolean>;
  error: string | null;
  library: Library;
  onOpenLibrary: () => void;
  /** Library item id → its mention ("@Image 2"), for showing selection in the Uploads panel. */
  onReferencesChange: (labels: Map<string, string>) => void;
}

const KIND: Record<UploadKind, RefKind> = { image: "Image", video: "Video", audio: "Audio" };
const PLURAL: Record<UploadKind, string> = { image: "images", video: "videos", audio: "audio clips" };

const clamp = (n: number, m: ModelSpec) => Math.min(m.durations.max, Math.max(m.durations.min, n));

export function ControlPanel({
  ref,
  models,
  preset,
  onGenerate,
  error,
  library,
  onOpenLibrary,
  onReferencesChange,
}: Props) {
  const initialModel = models.find((m) => m.id === preset.model) ?? models[0];
  const [model, setModel] = useState<ModelSpec>(initialModel);
  const [mode, setMode] = useState<GenerationMode>("frames");
  const [prompt, setPrompt] = useState(preset.prompt ?? "");
  const [ratio, setRatio] = useState<Ratio>(
    preset.ratio && initialModel.ratios.includes(preset.ratio) && (preset.ratio !== "adaptive" || preset.firstFrame)
      ? preset.ratio
      : "16:9",
  );
  const [resolution, setResolution] = useState<Resolution>(
    preset.resolution && initialModel.resolutions.includes(preset.resolution) ? preset.resolution : "720p",
  );
  const [duration, setDuration] = useState(clamp(preset.duration ?? initialModel.durations.default, initialModel));
  const [generateAudio, setGenerateAudio] = useState(preset.generateAudio ?? true);
  const [firstFrame, setFirstFrameRaw] = useState<string | undefined>(preset.firstFrame);
  const [lastFrame, setLastFrame] = useState<string>();
  // References: library item ids, in the order shown. Numbering is per kind.
  const [refIds, setRefIds] = useState<string[]>([]);
  // Latest list for handlers that run after an await.
  const refsNow = useRef(refIds);
  const [seed, setSeed] = useState("");
  const [cameraFixed, setCameraFixed] = useState(false);
  const [watermark, setWatermark] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const editor = useRef<PromptEditorHandle>(null);

  const hasRefs = model.references.total > 0;
  const effectiveMode: GenerationMode = hasRefs ? mode : "frames";
  // "adaptive" follows the start frame, so it only makes sense with one.
  const canAdapt = effectiveMode === "frames" && !!firstFrame;
  const cost = estimateCost(model, resolution, duration);

  const byId = new Map(library.items.map((i) => [i.id, i]));
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
    const limit = { image: model.references.images, video: model.references.videos, audio: model.references.audios };
    let total = current.length;
    const added: string[] = [];
    const skipped = new Set<UploadKind>();
    for (const item of items) {
      if (refsNow.current.includes(item.id) || added.includes(item.id)) continue;
      if (used[item.kind] >= limit[item.kind] || total >= model.references.total) {
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
    if (skipped.size)
      alert(
        [...skipped]
          .map((k) =>
            limit[k] === 0
              ? `${model.label} doesn't take ${PLURAL[k]} as references.`
              : `${model.label} takes up to ${limit[k]} ${PLURAL[k]} (${model.references.total} references in total).`,
          )
          .join("\n") + "\nThe files are still in your Uploads.",
      );
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

  useImperativeHandle(ref, () => ({
    toggle(item) {
      if (!hasRefs) {
        alert(`${model.label} doesn't take references. Pick a model that does.`);
        return;
      }
      if (refsNow.current.includes(item.id)) updateRefs(refsNow.current.filter((x) => x !== item.id));
      else addRefs([item]);
    },
    add(item) {
      if (!hasRefs) alert(`${model.label} doesn't take references. Pick a model that does.`);
      else addRefs([item]);
    },
    forget(id) {
      if (refsNow.current.includes(id)) updateRefs(refsNow.current.filter((x) => x !== id));
    },
  }));

  function setFirstFrame(v: string | undefined) {
    setFirstFrameRaw(v);
    if (!v && ratio === "adaptive") setRatio("16:9");
  }

  function changeMode(m: GenerationMode) {
    setMode(m);
    if (m === "references" && ratio === "adaptive") setRatio("16:9");
  }

  function changeModel(id: string) {
    const m = models.find((x) => x.id === id)!;
    setModel(m);
    if (!m.ratios.includes(ratio)) setRatio(m.ratios[0]);
    if (!m.resolutions.includes(resolution)) setResolution(m.resolutions.at(-1)!);
    setDuration((d) => clamp(d, m));
    if (!m.lastFrame) setLastFrame(undefined);
  }

  const uploading = refs && refList.some((r) => r.item.status !== "ready");
  const canSubmit =
    !submitting &&
    !uploading &&
    badMentions.length === 0 &&
    (prompt.trim().length > 0 ||
      (!model.promptRequired && (effectiveMode === "frames" ? !!firstFrame : perKind.Image > 0)));

  const refValues = (kind: UploadKind) =>
    refList.filter((r) => r.item.kind === kind).map((r) => `upload:${r.item.key}`);

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
      generateAudio: model.audio ? generateAudio : undefined,
      seed: model.features.seed && seed.trim() !== "" ? Number(seed) : undefined,
      cameraFixed: model.features.cameraFixed ? cameraFixed : undefined,
      watermark: model.features.watermark ? watermark : undefined,
      ...(frames
        ? { firstFrame, lastFrame: firstFrame ? lastFrame : undefined }
        : {
            referenceImages: refValues("image"),
            referenceVideos: refValues("video"),
            referenceAudios: refValues("audio"),
          }),
    }).finally(() => setSubmitting(false));
    if (ok) setSeed("");
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 pb-5">
        <Section label="Model">
          <select
            value={model.id}
            onChange={(e) => changeModel(e.target.value)}
            className="w-full appearance-none rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-2.5 text-sm outline-none focus:border-accent/60"
          >
            {models.map((m) => (
              <option key={m.id} value={m.id} className="bg-panel">
                {m.label}
              </option>
            ))}
          </select>
          <p className="mt-1.5 text-xs text-zinc-500">{model.description}</p>
        </Section>

        {hasRefs && (
          <div className="grid grid-cols-2 gap-1 rounded-xl bg-white/[0.04] p-1 text-sm">
            {(["frames", "references"] as const).map((m) => (
              <button
                key={m}
                onClick={() => changeMode(m)}
                className={`rounded-lg py-1.5 capitalize transition ${
                  effectiveMode === m ? "bg-white/10 text-white" : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        )}

        {effectiveMode === "frames" ? (
          <div className={`grid gap-3 ${model.lastFrame ? "grid-cols-2" : "grid-cols-1"}`}>
            <ImageSlot label="Start frame" value={firstFrame} onChange={setFirstFrame} />
            {model.lastFrame && (
              <ImageSlot label="End frame" value={lastFrame} onChange={setLastFrame} disabled={!firstFrame} />
            )}
          </div>
        ) : (
          <ReferenceBox
            blocks={blocks}
            max={model.references.total}
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
                ? "The cat from @Image 1 dances on the rooftop from @Image 2… (type @ to reference)"
                : "A slow dolly-in on a neon-lit ramen stall at night, rain on the window, steam rising…"
            }
          />
          {badMentions.length > 0 && (
            <p className="mt-1.5 text-xs text-red-300">
              {refs
                ? `${badMentions.join(", ")} ${badMentions.length === 1 ? "doesn't" : "don't"} match an attached reference`
                : "@-references only work in References mode"}
            </p>
          )}
        </Section>

        <Section label="Aspect ratio">
          <div className="flex flex-wrap gap-1.5">
            {model.ratios.map((r) => (
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
        </Section>

        <Section label="Resolution">
          <div className="flex gap-1.5">
            {model.resolutions.map((r) => (
              <Chip key={r} active={resolution === r} onClick={() => setResolution(r)}>
                {r === "4k" ? "4K" : r}
              </Chip>
            ))}
          </div>
        </Section>

        <Section label="Duration" aside={`${duration}s`}>
          <input
            type="range"
            min={model.durations.min}
            max={model.durations.max}
            value={duration}
            onChange={(e) => setDuration(Number(e.target.value))}
            className="w-full accent-[var(--color-accent)]"
          />
        </Section>

        {model.audio && <Toggle label="Generate audio" checked={generateAudio} onChange={setGenerateAudio} />}

        {(model.features.seed || model.features.cameraFixed || model.features.watermark) && (
          <div>
            <button onClick={() => setShowAdvanced((s) => !s)} className="text-xs text-zinc-500 hover:text-zinc-300">
              {showAdvanced ? "− Hide" : "+ Show"} advanced
            </button>
            {showAdvanced && (
              <div className="mt-3 space-y-3">
                {model.features.seed && (
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
                {model.features.cameraFixed && (
                  <Toggle label="Fixed camera" checked={cameraFixed} onChange={setCameraFixed} />
                )}
                {model.features.watermark && <Toggle label="Watermark" checked={watermark} onChange={setWatermark} />}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="border-t border-white/5 p-5">
        {error && <p className="mb-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</p>}
        <button
          onClick={submit}
          disabled={!canSubmit}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-accent py-3 text-sm font-semibold text-ink transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {submitting ? (
            <span className="size-4 animate-spin rounded-full border-2 border-ink/30 border-t-ink" />
          ) : (
            "Generate"
          )}
          <span className="text-xs font-normal opacity-60">
            {resolution} · {duration}s{cost !== undefined && ` · ~$${cost.toFixed(2)}`}
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
