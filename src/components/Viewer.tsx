"use client";

// Full-screen viewer for a video, image, or audio file. One Modal for every entry point.

import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  Trash2,
  Volume2,
  VolumeX,
  X,
} from "@/components/ui/Icon";
import { Modal } from "@/components/ui/Modal";
import { toast } from "@/components/ui/Toast";
import type { ExtendOffer, ToolView } from "@/lib/toolTypes";
import { Waveform } from "./MediaBlocks";
import { ToolsMenu } from "./ToolsMenu";
import {
  clock,
  keyTargetOf,
  promptParts,
  scrubberAria,
  seekTo,
  toolbarFlags,
  viewerKeyAction,
  type ViewerDetail,
} from "./viewer/model";

const RATES = [0.5, 1, 1.5, 2];

export interface ViewerReference {
  src: string;
  alt: string;
}

export interface ViewerLineage {
  toolName?: string;
  parent?: { id: string; name: string };
  children: { id: string; name: string }[];
  onOpen: (id: string) => void;
}

export function Viewer({
  label,
  title,
  kind,
  src,
  alt = "",
  prompt,
  references = [],
  details = [],
  error,
  pending,
  peaks,
  poster,
  onClose,
  onPrev,
  onNext,
  onReuse,
  onUseAsReference,
  referenceLabel = "Use as reference",
  onDownload,
  downloadHref,
  onDelete,
  onContinue,
  continueBusy = false,
  extendOffer,
  onNativeExtend,
  tools = [],
  toolKind,
  assetKey,
  toolAsset,
  keyed,
  onOpenKeys,
  onToolJob,
  lineage,
  extra,
}: {
  label: string;
  title?: string;
  kind: "image" | "video" | "audio";
  src?: string;
  alt?: string;
  prompt?: string;
  references?: ViewerReference[];
  details?: ViewerDetail[];
  error?: string;
  /** Shown in place of the file when it isn't ready. */
  pending?: React.ReactNode;
  peaks?: number[];
  /** Still image for the video element and the blurred backdrop. Never a second video. */
  poster?: string;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  onReuse?: () => void;
  onUseAsReference?: () => void;
  referenceLabel?: string;
  onDownload?: () => void;
  downloadHref?: string;
  onDelete?: () => void;
  /** Extract the last frame and use it as the start frame. */
  onContinue?: () => void;
  continueBusy?: boolean;
  /** Set when this clip's model has a native extend endpoint. */
  extendOffer?: ExtendOffer;
  onNativeExtend?: (prompt: string) => Promise<void>;
  tools?: readonly ToolView[];
  toolKind?: "image" | "video";
  assetKey?: string;
  toolAsset?: { width?: number; height?: number; duration?: number };
  keyed?: ReadonlySet<string>;
  onOpenKeys?: () => void;
  onToolJob?: () => void;
  lineage?: ViewerLineage;
  extra?: React.ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const mediaRef = useRef<HTMLMediaElement>(null);
  const [tab, setTab] = useState<"info" | "tools">("info");
  const [entry, setEntry] = useState<string | null>(null);
  const [entryVersion, setEntryVersion] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [full, setFull] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(true);
  const playable = (kind === "video" || kind === "audio") && !!src && !pending;
  const flags = toolbarFlags(tools, toolKind ?? kind);
  const onKeyRef = useRef<(event: KeyboardEvent) => void>(() => {});
  const showTools = !!toolKind && tools.length > 0;

  function close() {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
      return;
    }
    onClose();
  }

  function seek(next: number) {
    const el = mediaRef.current;
    if (!el) return;
    const clamped = seekTo(el.currentTime, Number.isFinite(el.duration) ? el.duration : duration, next - el.currentTime);
    el.currentTime = clamped;
    setTime(clamped);
  }

  function seekBy(seconds: number) {
    const el = mediaRef.current;
    const current = el?.currentTime ?? time;
    const max = el && Number.isFinite(el.duration) ? el.duration : duration;
    const next = seekTo(current, max, seconds);
    if (el) el.currentTime = next;
    setTime(next);
  }

  function togglePlay() {
    const el = mediaRef.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => {});
    else el.pause();
  }

  function toggleMute() {
    const el = mediaRef.current;
    if (!el) return;
    el.muted = !el.muted;
    setMuted(el.muted);
  }

  function cycleRate() {
    const next = RATES[(RATES.indexOf(rate) + 1) % RATES.length] ?? 1;
    setRate(next);
    if (mediaRef.current) mediaRef.current.playbackRate = next;
  }

  function toggleFull() {
    const el = stageRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen().catch(() => {});
  }

  function openTool(name: string | null) {
    setTab("tools");
    setEntry(name);
    setEntryVersion((version) => version + 1);
  }

  useEffect(() => {
    const el = mediaRef.current;
    if (!el || !playable) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reduce) void el.play().catch(() => {});
  }, [playable, src]);

  useEffect(() => {
    const onFull = () => setFull(document.fullscreenElement === stageRef.current);
    document.addEventListener("fullscreenchange", onFull);
    return () => document.removeEventListener("fullscreenchange", onFull);
  }, []);

  useEffect(() => {
    onKeyRef.current = (event: KeyboardEvent) => {
      const root = rootRef.current;
      const target = event.target;
      const dialog = root?.closest("[role='dialog']");
      const inside = target instanceof Node && (root?.contains(target) || target === dialog);
      if (!inside) return;
      const action = viewerKeyAction({
        key: event.key,
        shiftKey: event.shiftKey,
        target: keyTargetOf(event.target),
      });
      if (action.type === "ignore" || action.type === "close") return;
      if ((action.type === "play" || action.type === "seek") && !playable) return;
      event.preventDefault();
      if (action.type === "play") togglePlay();
      else if (action.type === "step") {
        if (action.delta < 0) onPrev?.();
        else onNext?.();
      } else if (action.type === "seek") seekBy(action.seconds);
      else if (action.type === "fullscreen") toggleFull();
    };
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => onKeyRef.current(event);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const aria = scrubberAria(time, duration);
  const pct = duration > 0 ? Math.min(100, (time / duration) * 100) : 0;

  return (
    <Modal size="full" surface="ink" onClose={close} label={label} showClose={false}>
      <div ref={rootRef} data-testid="viewer" className="flex h-full min-h-0 flex-col bg-ink lg:flex-row">
        <div ref={stageRef} className="relative flex min-h-[42dvh] min-w-0 flex-1 flex-col bg-ink">
          <Backdrop src={kind === "image" ? src : poster} />
          <div className="relative z-10 flex min-h-0 flex-1 items-center justify-center px-14 py-4">
            {pending ? (
              pending
            ) : kind === "image" && src ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={src} alt={alt} className="max-h-full max-w-full object-contain" />
            ) : kind === "video" && src ? (
              <video
                key={src}
                ref={(node) => {
                  mediaRef.current = node;
                }}
                src={src}
                poster={poster}
                playsInline
                preload="metadata"
                className="max-h-full max-w-full object-contain"
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
                onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)}
                onDurationChange={(event) => setDuration(event.currentTarget.duration || 0)}
              />
            ) : kind === "audio" && src ? (
              <div className="w-full max-w-lg px-6">
                <Waveform peaks={peaks} bars={96} />
                <audio
                  key={src}
                  ref={(node) => {
                    mediaRef.current = node;
                  }}
                  src={src}
                  preload="metadata"
                  className="sr-only"
                  onPlay={() => setPlaying(true)}
                  onPause={() => setPlaying(false)}
                  onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
                  onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)}
                />
              </div>
            ) : (
              <p className="text-body text-fg-muted">Nothing to show yet.</p>
            )}
            {onPrev && <Nav side="left" onClick={onPrev} />}
            {onNext && <Nav side="right" onClick={onNext} />}
          </div>

          <div className="relative z-10 flex flex-col items-center gap-2 px-4 pb-4">
            {(flags.upscale || flags.more) && (
              <div className="flex items-center gap-0.5 rounded-full border border-line bg-surface-3/95 p-1">
                {flags.upscale && (
                  <Pill testId="viewer-upscale" onClick={() => openTool("Upscale")}>
                    Upscale
                  </Pill>
                )}
                {flags.more && (
                  <Pill testId="viewer-more" onClick={() => openTool(null)}>
                    More
                  </Pill>
                )}
              </div>
            )}
            {playable && (
              <div className="flex w-full max-w-xl items-center gap-2 rounded-full border border-line bg-ink/80 px-2 py-1.5">
                <IconButton label={playing ? "Pause" : "Play"} testId="viewer-play" onClick={togglePlay}>
                  {playing ? <Pause className="size-4" aria-hidden /> : <Play className="size-4" aria-hidden />}
                </IconButton>
                <div
                  data-viewer-slider
                  data-testid="viewer-scrubber"
                  role="slider"
                  tabIndex={0}
                  aria-label="Playback position"
                  aria-valuemin={aria["aria-valuemin"]}
                  aria-valuemax={aria["aria-valuemax"]}
                  aria-valuenow={aria["aria-valuenow"]}
                  aria-valuetext={aria["aria-valuetext"]}
                  className="relative h-1.5 min-w-0 flex-1 cursor-pointer rounded-full bg-white/15"
                  onPointerDown={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    const ratio = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
                    const max = mediaRef.current && Number.isFinite(mediaRef.current.duration) ? mediaRef.current.duration : duration;
                    seek(Math.min(max, Math.max(0, ratio * max)));
                  }}
                >
                  <span className="pointer-events-none absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${pct}%` }} />
                </div>
                <button
                  type="button"
                  onClick={cycleRate}
                  aria-label={`Playback speed, ${rate}×`}
                  className="rounded-full px-2 py-1 text-label text-fg tabular-nums"
                >
                  {rate}×
                </button>
                <IconButton label={muted ? "Unmute" : "Mute"} onClick={toggleMute}>
                  {muted ? <VolumeX className="size-4" aria-hidden /> : <Volume2 className="size-4" aria-hidden />}
                </IconButton>
                <span className="text-label text-fg tabular-nums">
                  {clock(time)} / {clock(duration)}
                </span>
                <IconButton label={full ? "Exit fullscreen" : "Enter fullscreen"} onClick={toggleFull}>
                  {full ? <Minimize2 className="size-4" aria-hidden /> : <Maximize2 className="size-4" aria-hidden />}
                </IconButton>
              </div>
            )}
          </div>
        </div>

        <aside className="flex h-[46%] w-full shrink-0 flex-col border-t border-line bg-panel lg:h-full lg:w-[320px] lg:border-t-0 lg:border-l">
              <header className="flex items-start justify-between gap-3 px-4 pt-4">
                <h2 className="min-w-0 truncate text-title text-fg">{title || "Details"}</h2>
                <IconButton label="Close" onClick={close}>
                  <X className="size-4" aria-hidden />
                </IconButton>
              </header>
              <div role="tablist" aria-label="Viewer" className="mx-4 mt-3 flex gap-1 rounded-lg bg-surface-2 p-1">
                <TabButton id="info" selected={tab === "info"} onSelect={() => setTab("info")} controls="viewer-panel-info">
                  Info
                </TabButton>
                <TabButton id="tools" selected={tab === "tools"} onSelect={() => setTab("tools")} controls="viewer-panel-tools">
                  Tools
                </TabButton>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
                {tab === "info" ? (
                  <div id="viewer-panel-info" role="tabpanel" aria-labelledby="viewer-tab-info">
                    <PromptBlock prompt={prompt} />
                    {references.length > 0 && (
                      <ul className="mt-3 flex gap-2">
                        {references.map((ref) => (
                          <li key={ref.src}>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={ref.src} alt={ref.alt} className="size-12 rounded-md object-cover" />
                          </li>
                        ))}
                      </ul>
                    )}
                    {details.length > 0 && (
                      <div className="mt-4">
                        <button
                          type="button"
                          aria-expanded={detailsOpen}
                          onClick={() => setDetailsOpen((open) => !open)}
                          className="flex w-full items-center justify-between text-label tracking-wide text-fg-muted uppercase"
                        >
                          Details
                          <ChevronDown className={`size-4 motion-reduce:transform-none ${detailsOpen ? "rotate-180" : ""}`} aria-hidden />
                        </button>
                        {detailsOpen && (
                          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-body">
                            {details.map((row) => (
                              <div key={row.label} className="contents">
                                <dt className="text-fg-muted">{row.label}</dt>
                                <dd className="text-right text-fg">{row.value}</dd>
                              </div>
                            ))}
                          </dl>
                        )}
                      </div>
                    )}
                    {lineage && <Lineage lineage={lineage} />}
                    {error && <p className="mt-3 rounded-md bg-red-400/10 p-2.5 text-body text-red-200">{error}</p>}
                    {extra}
                  </div>
                ) : (
                  <div id="viewer-panel-tools" role="tabpanel" aria-labelledby="viewer-tab-tools">
                    {showTools ? (
                      <ToolsMenu
                        key={`${entry ?? "list"}:${entryVersion}:${tools.length}`}
                        inline
                        entry={entry}
                        kind={toolKind}
                        assetKey={assetKey}
                        asset={toolAsset}
                        tools={tools}
                        keyed={keyed}
                        onOpenKeys={onOpenKeys}
                        onStarted={() => onToolJob?.()}
                        label="Tools"
                      />
                    ) : (
                      <p className="text-body text-fg-muted">No tools for this file.</p>
                    )}
                  </div>
                )}
              </div>
              <footer className="flex flex-col gap-2 border-t border-line p-3">
                {onContinue && (
                  <button
                    type="button"
                    data-testid="continue-last-frame"
                    onClick={onContinue}
                    disabled={continueBusy}
                    className="w-full rounded-md border border-line px-3 py-2 text-body text-fg disabled:opacity-50"
                  >
                    {continueBusy ? "Saving the last frame…" : "Continue from last frame"}
                  </button>
                )}
                {extendOffer && onNativeExtend && (
                  <NativeExtend offer={extendOffer} initialPrompt={prompt ?? ""} onExtend={onNativeExtend} />
                )}
                <div className="flex flex-wrap items-center gap-2">
                {onReuse && (
                  <button
                    type="button"
                    data-testid="viewer-reuse"
                    onClick={onReuse}
                    className="min-w-0 flex-1 rounded-md bg-accent px-3 py-2 text-body font-semibold text-accent-fg"
                  >
                    Reuse
                  </button>
                )}
                {onUseAsReference && (
                  <button
                    type="button"
                    onClick={onUseAsReference}
                    className="rounded-md border border-line px-3 py-2 text-body text-fg"
                  >
                    {referenceLabel}
                  </button>
                )}
                {downloadHref && (
                  <a href={downloadHref} aria-label="Download" className="grid size-9 place-items-center rounded-full text-fg hover:bg-white/10">
                    <Download className="size-4" aria-hidden />
                  </a>
                )}
                {onDownload && (
                  <IconButton label="Download" onClick={onDownload}>
                    <Download className="size-4" aria-hidden />
                  </IconButton>
                )}
                {onDelete && (
                  <IconButton label="Delete" testId="viewer-delete" onClick={onDelete}>
                    <Trash2 className="size-4" aria-hidden />
                  </IconButton>
                )}
                </div>
              </footer>
        </aside>
      </div>
    </Modal>
  );
}

function NativeExtend({
  offer,
  initialPrompt,
  onExtend,
}: {
  offer: ExtendOffer;
  initialPrompt: string;
  onExtend: (prompt: string) => Promise<void>;
}) {
  const [extendPrompt, setExtendPrompt] = useState(initialPrompt);
  const [extendBusy, setExtendBusy] = useState(false);
  const [extendError, setExtendError] = useState<string | null>(null);
  return (
    <form
      data-testid="extend-option"
      className="grid gap-2 rounded-md border border-line p-2.5"
      onSubmit={(event) => {
        event.preventDefault();
        const next = extendPrompt.trim();
        if (!next || extendBusy) return;
        setExtendBusy(true);
        setExtendError(null);
        void onExtend(next)
          .catch((err: unknown) => setExtendError(err instanceof Error ? err.message : "Couldn't extend"))
          .finally(() => setExtendBusy(false));
      }}
    >
      <p className="text-body text-fg">{offer.name}</p>
      <textarea
        aria-label="What happens next"
        value={extendPrompt}
        onChange={(event) => setExtendPrompt(event.target.value)}
        rows={3}
        className="w-full resize-none rounded-md border border-line bg-surface-2 px-2 py-1.5 text-body text-fg outline-none"
      />
      {extendError && <p className="text-label text-red-200">{extendError}</p>}
      <button
        type="submit"
        disabled={extendBusy || !extendPrompt.trim()}
        className="rounded-md bg-white/10 py-2 text-body text-fg disabled:opacity-40"
      >
        {extendBusy ? "Starting…" : "Extend"}
      </button>
    </form>
  );
}

function Backdrop({ src }: { src?: string }) {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden bg-ink">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" className="viewer-backdrop size-full object-cover" />
      ) : null}
      <div className="absolute inset-0 bg-ink/75" />
    </div>
  );
}

function Nav({ side, onClick }: { side: "left" | "right"; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={side === "left" ? "Previous" : "Next"}
      onClick={onClick}
      className={`absolute top-0 bottom-0 my-auto grid size-10 place-items-center rounded-full border border-line bg-ink/70 text-fg ${
        side === "left" ? "left-3" : "right-3"
      }`}
    >
      {side === "left" ? <ChevronLeft className="size-5" aria-hidden /> : <ChevronRight className="size-5" aria-hidden />}
    </button>
  );
}

function Pill({
  children,
  onClick,
  testId,
}: {
  children: React.ReactNode;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-body text-fg hover:bg-white/10"
    >
      {children}
    </button>
  );
}

function IconButton({
  label,
  onClick,
  testId,
  children,
}: {
  label: string;
  onClick: () => void;
  testId?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      data-testid={testId}
      onClick={onClick}
      className="grid size-8 shrink-0 place-items-center rounded-full text-fg hover:bg-white/10"
    >
      {children}
    </button>
  );
}

function TabButton({
  id,
  selected,
  onSelect,
  controls,
  children,
}: {
  id: string;
  selected: boolean;
  onSelect: () => void;
  controls: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      id={`viewer-tab-${id}`}
      aria-selected={selected}
      aria-controls={controls}
      tabIndex={selected ? 0 : -1}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
        event.preventDefault();
        const tabs = event.currentTarget.parentElement?.querySelectorAll<HTMLElement>("[role='tab']");
        if (!tabs?.length) return;
        const list = [...tabs];
        const index = list.indexOf(event.currentTarget);
        const next = event.key === "ArrowRight" ? (index + 1) % list.length : (index - 1 + list.length) % list.length;
        list[next]?.focus();
        list[next]?.click();
      }}
      className={`flex-1 rounded-md px-3 py-1.5 text-body ${selected ? "bg-surface-3 text-fg" : "text-fg-muted"}`}
    >
      {children}
    </button>
  );
}

function PromptBlock({ prompt }: { prompt?: string }) {
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    setOverflows(el.scrollHeight > el.clientHeight + 1);
  }, [prompt, open]);

  async function copy() {
    if (!prompt) return;
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast("Couldn't copy the prompt.");
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <p className="text-label tracking-wide text-fg-muted uppercase">Prompt</p>
        {prompt && (
          <button type="button" onClick={() => void copy()} aria-label="Copy prompt" className="inline-flex items-center gap-1 text-label text-fg-muted hover:text-fg">
            <Copy className="size-3.5" aria-hidden />
            {copied ? "Copied" : "Copy"}
          </button>
        )}
      </div>
      <p ref={ref} className={`mt-1 text-body whitespace-pre-wrap text-fg ${open ? "" : "line-clamp-4"}`}>
        {prompt
          ? promptParts(prompt).map((part, index) =>
              part.mention ? (
                <span key={index} className="rounded-sm bg-accent-soft px-0.5 font-medium text-fg">
                  {part.text}
                </span>
              ) : (
                <span key={index}>{part.text}</span>
              ),
            )
          : "No prompt"}
      </p>
      {(overflows || open) && prompt && (
        <button type="button" onClick={() => setOpen((value) => !value)} className="mt-1 text-body text-fg-muted underline">
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

function Lineage({ lineage }: { lineage: ViewerLineage }) {
  if (!lineage.parent && !lineage.toolName && lineage.children.length === 0) return null;
  return (
    <div className="mt-3 space-y-1 text-body text-fg-muted">
      {lineage.parent && (
        <p>
          Made from{" "}
          <button type="button" onClick={() => lineage.onOpen(lineage.parent!.id)} className="text-fg underline">
            {lineage.parent.name}
          </button>
          {lineage.toolName ? ` · ${lineage.toolName}` : ""}
        </p>
      )}
      {!lineage.parent && lineage.toolName && <p>Made with {lineage.toolName}</p>}
      {lineage.children.length > 0 && (
        <p>
          Made from this:{" "}
          {lineage.children.map((child, index) => (
            <span key={child.id}>
              {index > 0 && ", "}
              <button type="button" onClick={() => lineage.onOpen(child.id)} className="text-fg underline">
                {child.name}
              </button>
            </span>
          ))}
        </p>
      )}
    </div>
  );
}
