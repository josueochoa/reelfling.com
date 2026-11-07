"use client";

import { useEffect, useRef, useState } from "react";
import { cameraSummary } from "@/lib/registry";
import { lookupModel } from "@/lib/registry/lookup";
import { getTemplate } from "@/lib/templates/templates";
import { Download, RotateCcw, X } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/Skeleton";
import { TERMINAL_STATUSES, type Generation } from "@/lib/types";

export const videoSrc = (g: Generation) => `/api/generations/${g.id}/video`;

export function useElapsed(gen: Generation) {
  const running = !TERMINAL_STATUSES.includes(gen.status);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  const end = running ? now : (gen.completedAt ?? gen.updatedAt);
  return Math.max(0, Math.round((end - gen.createdAt) / 1000));
}

export function formatSecs(s: number) {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${String(Math.floor(s / 60) % 60).padStart(2, "0")}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor(s / 3600) % 24}h`;
}

const ratioClass: Record<string, string> = {
  "16:9": "aspect-video",
  "21:9": "aspect-[21/9]",
  "4:3": "aspect-[4/3]",
  "1:1": "aspect-square",
  "3:4": "aspect-[3/4]",
  "9:16": "aspect-[9/16]",
};

export function GenerationCard({
  gen,
  onOpen,
  onReuse,
  onUseTemplate,
  onUseAsReference,
  onDelete,
  poster,
}: {
  gen: Generation;
  /** Thumbnail shown before the video loads. */
  poster?: string;
  onOpen: () => void;
  onReuse: () => void;
  onUseTemplate?: () => void;
  onUseAsReference: () => void;
  onDelete: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const elapsed = useElapsed(gen);
  const model = lookupModel(gen.model);
  const template = getTemplate(gen.templateId);
  const camera = cameraSummary(gen.cameraMoves, gen.cameraMove);
  const ready = gen.status === "succeeded";
  // The output is a video, so it can be a reference only once it's stored.
  const canReference = ready && !!gen.stored;

  return (
    <article data-testid="generation-card" className="group overflow-hidden rounded-2xl border border-white/5 bg-panel">
      <div
        className={`relative w-full cursor-pointer bg-black ${ratioClass[gen.ratio] ?? "aspect-video"} max-h-[70vh]`}
        onClick={onOpen}
        onMouseEnter={() => {
          if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
          videoRef.current?.play().catch(() => {});
        }}
        onMouseLeave={() => {
          const v = videoRef.current;
          if (v) {
            v.pause();
            v.currentTime = 0;
          }
        }}
      >
        {ready ? (
          <video
            ref={videoRef}
            // #t=0.1 makes browsers paint a frame instead of black. With a poster, nothing loads until hover.
            src={`${videoSrc(gen)}#t=0.1`}
            poster={poster}
            muted
            loop
            playsInline
            preload={poster ? "none" : "metadata"}
            className="mx-auto size-full object-contain"
          />
        ) : (
          <StatusOverlay gen={gen} elapsed={elapsed} />
        )}
      </div>

      <div className="space-y-2 p-3.5">
        <p className="line-clamp-2 text-sm text-zinc-300" title={gen.prompt}>
          {gen.prompt || <span className="text-zinc-500 italic">No prompt</span>}
        </p>
        {(canReference || onUseTemplate) && (
          <div className="flex flex-wrap gap-1.5">
            {canReference && <TextAction onClick={onUseAsReference}>Use as reference</TextAction>}
            {onUseTemplate && (
              <TextAction testId="use-template-again" onClick={onUseTemplate}>
                Use this template again
              </TextAction>
            )}
          </div>
        )}
        <div className="flex items-center justify-between gap-2">
          <div className="flex flex-wrap gap-1 text-[10px] text-zinc-500">
            <Meta>{model?.name ?? gen.model}</Meta>
            {template && <Meta>{template.name}</Meta>}
            {gen.estimatedCost !== undefined && <Meta testId="generation-cost">~${gen.estimatedCost.toFixed(2)}</Meta>}
            <Meta>{gen.resolution}</Meta>
            <Meta>{gen.duration}s</Meta>
            <Meta>{gen.ratio}</Meta>
            {camera && <Meta>{camera}</Meta>}
            {ready && <Meta>{formatSecs(elapsed)}</Meta>}
          </div>
          <div className="flex shrink-0 gap-1">
            <IconButton label="Reuse settings" onClick={onReuse}>
              <RotateCcw className="size-3.5" aria-hidden />
            </IconButton>
            {ready && (
              <a
                href={`${videoSrc(gen)}?download`}
                aria-label="Download"
                title="Download"
                className="grid size-7 place-items-center rounded-lg text-zinc-400 hover:bg-white/10 hover:text-white"
              >
                <Download className="size-3.5" aria-hidden />
              </a>
            )}
            <IconButton label="Delete" onClick={onDelete}>
              <X className="size-3.5" aria-hidden />
            </IconButton>
          </div>
        </div>
      </div>
    </article>
  );
}

export function StatusOverlay({ gen, elapsed }: { gen: Generation; elapsed: number }) {
  if (gen.status === "failed" || gen.status === "expired" || gen.status === "cancelled") {
    return (
      <div className="absolute inset-0 grid place-items-center p-6 text-center">
        <div>
          <p className="text-sm font-medium text-red-300 capitalize">{gen.status}</p>
          {gen.error && <p className="mt-1 line-clamp-4 text-xs text-zinc-500">{gen.error}</p>}
        </div>
      </div>
    );
  }
  return (
    <div className="absolute inset-0 overflow-hidden">
      <Skeleton fill />
      <div className="absolute inset-0 grid place-items-center">
        <div className="flex flex-col items-center gap-2">
          <span className="size-6 animate-spin rounded-full border-2 border-white/15 border-t-accent motion-reduce:animate-none" />
          <p className="text-xs text-zinc-400 capitalize">
            {gen.status}
            {gen.progress ? ` ${gen.progress}%` : ""} · {formatSecs(elapsed)}
          </p>
        </div>
      </div>
      {!!gen.progress && (
        <div className="absolute inset-x-0 bottom-0 h-0.5 bg-white/5">
          <div className="h-full bg-accent transition-[width] duration-700" style={{ width: `${gen.progress}%` }} />
        </div>
      )}
    </div>
  );
}

function Meta({ children, testId }: { children: React.ReactNode; testId?: string }) {
  return (
    <span data-testid={testId} className="rounded-md bg-white/5 px-1.5 py-0.5">
      {children}
    </span>
  );
}

function TextAction({ onClick, children, testId }: { onClick: () => void; children: React.ReactNode; testId?: string }) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className="rounded-lg bg-white/5 px-2 py-1 text-[11px] text-zinc-300 hover:bg-white/10 hover:text-white"
    >
      {children}
    </button>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid size-7 place-items-center rounded-lg text-zinc-400 hover:bg-white/10 hover:text-white"
    >
      {children}
    </button>
  );
}
