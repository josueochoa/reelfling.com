"use client";

import { useEffect, useRef, useState } from "react";
import { getModel } from "@/lib/models";
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
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
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
  onDelete,
}: {
  gen: Generation;
  onOpen: () => void;
  onReuse: () => void;
  onDelete: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const elapsed = useElapsed(gen);
  const model = getModel(gen.model);
  const ready = gen.status === "succeeded";

  return (
    <article className="group overflow-hidden rounded-2xl border border-white/5 bg-panel">
      <div
        className={`relative w-full cursor-pointer bg-black ${ratioClass[gen.ratio] ?? "aspect-video"} max-h-[70vh]`}
        onClick={onOpen}
        onMouseEnter={() => videoRef.current?.play().catch(() => {})}
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
            src={videoSrc(gen)}
            muted
            loop
            playsInline
            preload="metadata"
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
        <div className="flex items-center justify-between gap-2">
          <div className="flex flex-wrap gap-1 text-[10px] text-zinc-500">
            <Meta>{model?.label ?? gen.model}</Meta>
            <Meta>{gen.resolution}</Meta>
            <Meta>{gen.duration}s</Meta>
            <Meta>{gen.ratio}</Meta>
            {ready && <Meta>{formatSecs(elapsed)}</Meta>}
          </div>
          <div className="flex shrink-0 gap-1 opacity-0 transition group-hover:opacity-100">
            <IconButton title="Reuse settings" onClick={onReuse}>
              ↺
            </IconButton>
            {ready && (
              <a
                href={`${videoSrc(gen)}?download`}
                title="Download"
                className="grid size-7 place-items-center rounded-lg text-sm text-zinc-400 hover:bg-white/10 hover:text-white"
              >
                ↓
              </a>
            )}
            <IconButton title="Delete" onClick={onDelete}>
              ✕
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
      <div className="shimmer absolute inset-0" />
      <div className="absolute inset-0 grid place-items-center">
        <div className="flex flex-col items-center gap-2">
          <span className="size-6 animate-spin rounded-full border-2 border-white/15 border-t-accent" />
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

function Meta({ children }: { children: React.ReactNode }) {
  return <span className="rounded-md bg-white/5 px-1.5 py-0.5">{children}</span>;
}

function IconButton({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="grid size-7 place-items-center rounded-lg text-sm text-zinc-400 hover:bg-white/10 hover:text-white"
    >
      {children}
    </button>
  );
}
