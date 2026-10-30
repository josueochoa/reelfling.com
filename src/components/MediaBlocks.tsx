"use client";

// Visual blocks for assets, shared by the References box, the Uploads picker and Assets.

import { useEffect, useRef, useState } from "react";
import { fileSrc, thumbSrc, type LibraryItem } from "./library";

export function formatDuration(seconds?: number) {
  if (seconds === undefined || !Number.isFinite(seconds)) return "";
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Asks for thumbnails of generated assets as their tiles scroll into view (tiles carry
 * `data-asset-id`), so a long list doesn't fetch every full-size file at once.
 */
export function useLazyThumbs(
  root: React.RefObject<HTMLElement | null>,
  items: LibraryItem[],
  ensure: (item: LibraryItem) => void,
) {
  const ensureRef = useRef(ensure);
  useEffect(() => {
    ensureRef.current = ensure;
  });
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const byId = new Map(items.filter((i) => i.source === "generated" && !i.hasThumb).map((i) => [i.id, i]));
    if (!byId.size) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const item = byId.get((e.target as HTMLElement).dataset.assetId ?? "");
          if (item) ensureRef.current(item);
          io.unobserve(e.target);
        }
      },
      { rootMargin: "300px" },
    );
    el.querySelectorAll<HTMLElement>("[data-asset-id]").forEach((n) => io.observe(n));
    return () => io.disconnect();
  }, [root, items]);
}

/** One audio element for the whole view, so starting a clip stops the previous one. */
export function usePlayer() {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);

  useEffect(() => () => audio.current?.pause(), []);

  function toggle(item: LibraryItem) {
    const src = fileSrc(item);
    if (!src) return;
    if (playing === item.id) {
      audio.current?.pause();
      setPlaying(null);
      return;
    }
    audio.current?.pause();
    const el = new Audio(src);
    el.onended = () => setPlaying(null);
    el.onerror = () => setPlaying(null);
    audio.current = el;
    void el.play().catch(() => setPlaying(null));
    setPlaying(item.id);
  }

  function stop() {
    audio.current?.pause();
    setPlaying(null);
  }

  return { playing, toggle, stop };
}
export type Player = ReturnType<typeof usePlayer>;

export function Waveform({ peaks, bars = 40 }: { peaks?: number[]; bars?: number }) {
  // Without decoded peaks, a flat line rather than an invented shape.
  const heights = peaks?.length ? resample(peaks, bars) : Array(bars).fill(12);
  return (
    <div className="flex h-8 items-center gap-[2px]" aria-hidden>
      {heights.map((h, i) => (
        <span key={i} className="w-[2px] flex-1 rounded-full bg-white/45" style={{ height: `${Math.max(8, h)}%` }} />
      ))}
    </div>
  );
}

function resample(values: number[], n: number) {
  return Array.from({ length: n }, (_, i) => values[Math.floor((i * values.length) / n)]);
}

export function PlayButton({
  playing,
  onClick,
  className = "",
}: {
  playing: boolean;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      aria-label={playing ? "Pause" : "Play"}
      className={`grid size-7 shrink-0 place-items-center rounded-full bg-white/90 text-[10px] text-ink hover:bg-white ${className}`}
    >
      {playing ? "❚❚" : "▶"}
    </button>
  );
}

/** The item's picture: image thumbnail, video frame with ▶ and length, or a waveform block. */
export function MediaVisual({
  item,
  player,
  compact,
  onPreview,
}: {
  item: LibraryItem;
  player: Player;
  compact?: boolean;
  /** Makes a video's ▶ open the preview (instead of being decoration). */
  onPreview?: () => void;
}) {
  const thumb = thumbSrc(item);

  if (item.kind === "audio") {
    return (
      <div className="flex size-full flex-col justify-between bg-white/[0.06] p-2.5">
        {!compact && <p className="truncate text-xs font-medium text-zinc-200">{item.name}</p>}
        <Waveform peaks={item.peaks} bars={compact ? 28 : 40} />
        <div className="flex items-center justify-between">
          <PlayButton playing={player.playing === item.id} onClick={() => player.toggle(item)} />
          <span className="text-[11px] text-zinc-300 tabular-nums">{formatDuration(item.duration)}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="relative size-full bg-black">
      {thumb ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={thumb} alt={item.name} draggable={false} className="size-full object-cover" />
      ) : item.kind === "video" && fileSrc(item) ? (
        // No thumbnail yet (generated videos get one lazily): the video's first frame.
        <video
          src={`${fileSrc(item)}#t=0.1`}
          muted
          playsInline
          preload="metadata"
          aria-label={item.name}
          className="pointer-events-none size-full object-cover"
        />
      ) : (
        <div className="grid size-full place-items-center text-xs text-zinc-500">{item.kind}</div>
      )}
      {item.kind === "video" && (
        <>
          <span className="pointer-events-none absolute inset-0 grid place-items-center">
            {onPreview ? (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onPreview();
                }}
                aria-label={`Play ${item.name}`}
                title="Play"
                className="pointer-events-auto grid size-9 place-items-center rounded-full bg-black/60 text-xs text-white transition hover:scale-110 hover:bg-black/80"
              >
                ▶
              </button>
            ) : (
              <span className="grid size-7 place-items-center rounded-full bg-black/50 text-[10px] text-white">▶</span>
            )}
          </span>
          {/* Small blocks carry a mention label along the bottom instead. */}
          {!compact && item.duration !== undefined && (
            <span className="absolute right-1 bottom-1 rounded bg-black/70 px-1 text-[10px] text-white tabular-nums">
              {formatDuration(item.duration)}
            </span>
          )}
        </>
      )}
    </div>
  );
}

/** Progress or error over a block that's still uploading. */
export function UploadOverlay({ item }: { item: LibraryItem }) {
  if (item.status === "ready") return null;
  if (item.status === "error")
    return (
      <div className="absolute inset-0 grid place-items-center bg-red-950/80 p-2 text-center text-[10px] leading-tight text-red-200">
        {item.error ?? "Upload failed"}
      </div>
    );
  return (
    <div className="absolute inset-0 flex items-end bg-black/45">
      <span className="absolute inset-0 grid place-items-center text-xs text-white tabular-nums">
        {Math.round(item.progress * 100)}%
      </span>
      <span className="h-1 bg-accent transition-[width]" style={{ width: `${item.progress * 100}%` }} />
    </div>
  );
}
