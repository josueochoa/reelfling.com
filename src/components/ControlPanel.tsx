"use client";

import { useRef, useState } from "react";
import { invalidMentions, mentionToken, renumberAfterRemoval, type RefCounts, type RefKind } from "@/lib/mentions";
import { estimateCost, type ModelSpec, type Ratio, type Resolution } from "@/lib/models";
import type { GenerateRequest, GenerationMode } from "@/lib/types";
import { ImageSlot, ReferenceImages, UrlList } from "./MediaInputs";
import { PromptEditor, type MentionItem, type PromptEditorHandle } from "./PromptEditor";

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

interface Props {
  models: ModelSpec[];
  preset: Preset;
  onGenerate: (req: GenerateRequest) => Promise<boolean>;
  error: string | null;
}

const fileName = (url: string) => decodeURIComponent(url.split(/[?#]/)[0].split("/").pop() ?? url);

const clamp = (n: number, m: ModelSpec) => Math.min(m.durations.max, Math.max(m.durations.min, n));

export function ControlPanel({ models, preset, onGenerate, error }: Props) {
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
  const [refImages, setRefImages] = useState<string[]>([]);
  const [refVideos, setRefVideos] = useState<string[]>([]);
  const [refAudios, setRefAudios] = useState<string[]>([]);
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

  // @-mentions only resolve in references mode; anywhere else they're flagged.
  const refs = effectiveMode === "references";
  const counts: RefCounts = refs
    ? { Image: refImages.length, Video: refVideos.length, Audio: refAudios.length }
    : { Image: 0, Video: 0, Audio: 0 };
  const badMentions = invalidMentions(prompt, counts);
  const mentionItems: MentionItem[] = !refs
    ? []
    : [
        ...refImages.map((thumb, i) => ({
          token: mentionToken("Image", i + 1),
          kind: "Image" as const,
          n: i + 1,
          thumb,
        })),
        ...refVideos.map((url, i) => ({
          token: mentionToken("Video", i + 1),
          kind: "Video" as const,
          n: i + 1,
          detail: fileName(url),
        })),
        ...refAudios.map((url, i) => ({
          token: mentionToken("Audio", i + 1),
          kind: "Audio" as const,
          n: i + 1,
          detail: fileName(url),
        })),
      ];

  const setRefs: Record<RefKind, React.Dispatch<React.SetStateAction<string[]>>> = {
    Image: setRefImages,
    Video: setRefVideos,
    Audio: setRefAudios,
  };

  function addRefs(kind: RefKind, items: string[]) {
    setRefs[kind]((v) => [...v, ...items]);
  }

  function removeRef(kind: RefKind, i: number) {
    setRefs[kind]((v) => v.filter((_, j) => j !== i));
    setPrompt((p) => renumberAfterRemoval(p, kind, i + 1));
  }

  function mentionRef(kind: RefKind, i: number) {
    editor.current?.insert(mentionToken(kind, i + 1));
  }

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

  const canSubmit =
    !submitting &&
    badMentions.length === 0 &&
    (prompt.trim().length > 0 ||
      (!model.promptRequired && (effectiveMode === "frames" ? !!firstFrame : refImages.length > 0)));

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
        : { referenceImages: refImages, referenceVideos: refVideos, referenceAudios: refAudios }),
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
          <div className="space-y-4">
            {model.references.images > 0 && (
              <ReferenceImages
                max={model.references.images}
                value={refImages}
                onAdd={(items) => addRefs("Image", items)}
                onRemove={(i) => removeRef("Image", i)}
                onMention={(i) => mentionRef("Image", i)}
              />
            )}
            {model.references.videos > 0 && (
              <UrlList
                label="Reference videos"
                kind="Video"
                placeholder="https://…/clip.mp4"
                max={model.references.videos}
                value={refVideos}
                onAdd={(items) => addRefs("Video", items)}
                onRemove={(i) => removeRef("Video", i)}
                onMention={(i) => mentionRef("Video", i)}
              />
            )}
            {model.references.audios > 0 && (
              <UrlList
                label="Reference audio"
                kind="Audio"
                placeholder="https://…/track.mp3"
                max={model.references.audios}
                value={refAudios}
                onAdd={(items) => addRefs("Audio", items)}
                onRemove={(i) => removeRef("Audio", i)}
                onMention={(i) => mentionRef("Audio", i)}
              />
            )}
          </div>
        )}

        <Section label="Prompt" aside={model.promptRequired ? undefined : "optional with an image"}>
          <PromptEditor
            ref={editor}
            value={prompt}
            onChange={setPrompt}
            onSubmit={submit}
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
