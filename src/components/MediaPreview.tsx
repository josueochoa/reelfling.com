"use client";

// Full-size view of a library file: plays videos and audio, shows images.

import { useEffect } from "react";
import { getImageModel } from "@/lib/imageModels";
import { getModel } from "@/lib/models";
import { fileSrc, type LibraryItem } from "./library";
import { formatDuration, Waveform } from "./MediaBlocks";
import { formatBytes } from "./UserMenu";

const modelLabel = (id: string) => getModel(id)?.label ?? getImageModel(id)?.label ?? id;

export function MediaPreview({
  item,
  label,
  onToggle,
  onPrev,
  onNext,
  onClose,
  actions,
}: {
  item: LibraryItem;
  /** Extra buttons for the footer (e.g. the Assets view's Download / Use in…). */
  actions?: React.ReactNode;
  /** Its mention if it's a reference ("@Video 1"). */
  label?: string;
  /** Add to / remove from references. */
  onToggle?: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  onClose: () => void;
}) {
  const src = fileSrc(item);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft") onPrev?.();
      if (e.key === "ArrowRight") onNext?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onPrev, onNext]);

  const details = [
    item.source === "generated" ? `Generated · ${modelLabel(item.generation?.model ?? "")}` : "Uploaded",
    item.kind === "image" ? "Image" : item.kind === "video" ? "Video" : "Audio",
    formatDuration(item.duration),
    formatBytes(item.bytes),
  ].filter(Boolean);

  return (
    <div className="fixed inset-0 z-50 flex bg-black/85 backdrop-blur-sm" onClick={onClose}>
      <div
        className="m-auto flex max-h-[92dvh] w-[min(1000px,94vw)] flex-col overflow-hidden rounded-2xl border border-white/10 bg-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative grid min-h-[240px] flex-1 place-items-center bg-black">
          {item.kind === "video" && (
            // key: a new element per item, so switching items restarts playback
            <video key={item.id} src={src} controls autoPlay playsInline className="max-h-[78dvh] w-full" />
          )}
          {item.kind === "image" && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={src} alt={item.name} className="max-h-[78dvh] w-full object-contain" />
          )}
          {item.kind === "audio" && (
            <div className="w-full space-y-6 px-8 py-12">
              <Waveform peaks={item.peaks} bars={96} />
              <audio key={item.id} src={src} controls autoPlay className="w-full" />
            </div>
          )}
          {onPrev && (
            <NavButton side="left" onClick={onPrev} label="Previous">
              ‹
            </NavButton>
          )}
          {onNext && (
            <NavButton side="right" onClick={onNext} label="Next">
              ›
            </NavButton>
          )}
        </div>
        <div className="flex items-center gap-3 border-t border-white/5 px-4 py-3">
          <div className="min-w-0 flex-1">
            <p
              className={`text-sm font-medium ${item.source === "generated" ? "line-clamp-2" : "truncate"}`}
              title={item.name}
            >
              {item.generation?.prompt ?? item.name}
            </p>
            <p className="text-xs text-zinc-500">{details.join(" · ")}</p>
          </div>
          {actions}
          {onToggle && item.status === "ready" && (
            <button
              onClick={onToggle}
              className={`rounded-xl px-3.5 py-2 text-sm font-medium ${
                label ? "border border-white/10 text-zinc-200 hover:bg-white/5" : "bg-accent text-ink"
              }`}
            >
              {label ? `Remove ${label} from references` : "Add to references"}
            </button>
          )}
          <button
            onClick={onClose}
            aria-label="Close preview"
            className="grid size-9 place-items-center rounded-full bg-white/5 text-zinc-300 hover:bg-white/10"
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}

function NavButton({
  side,
  onClick,
  label,
  children,
}: {
  side: "left" | "right";
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      className={`absolute top-1/2 ${side === "left" ? "left-3" : "right-3"} grid size-10 -translate-y-1/2 place-items-center rounded-full bg-black/60 text-2xl text-white hover:bg-black/80`}
    >
      {children}
    </button>
  );
}
