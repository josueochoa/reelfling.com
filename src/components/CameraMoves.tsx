"use client";

import type { ReactNode } from "react";
import { CAMERA_MOVES, type CameraMove } from "@/lib/registry";

/** Original glyphs for the composer. Not copied from a provider. */
function MoveIcon({ id }: { id: CameraMove }) {
  const mark: Record<CameraMove, ReactNode> = {
    static: <path d="M22 11h9" />,
    "push-in": (
      <>
        <path d="M21 11h8" />
        <path d="M26 8.2 30 11l-4 2.8" />
        <path d="M33 7.2v7.6" />
      </>
    ),
    "pull-out": (
      <>
        <path d="M33 7.2v7.6" />
        <path d="M31 11H22" />
        <path d="M26 8.2 22 11l4 2.8" />
      </>
    ),
    "pan-left": (
      <>
        <path d="M32 11H22" />
        <path d="M26 8.2 22 11l4 2.8" />
      </>
    ),
    "pan-right": (
      <>
        <path d="M22 11h10" />
        <path d="M28 8.2 32 11l-4 2.8" />
      </>
    ),
    "tilt-up": (
      <>
        <path d="M27 16V7" />
        <path d="M23.6 10.2 27 7l3.4 3.2" />
      </>
    ),
    "tilt-down": (
      <>
        <path d="M27 6v9" />
        <path d="M23.6 11.8 27 15l3.4-3.2" />
      </>
    ),
    orbit: (
      <>
        <path d="M23 14.5a5 5 0 1 1 1.2-6.2" />
        <path d="M23.2 7.2 24.6 9.6 22 9.8" />
      </>
    ),
    "crane-up": (
      <>
        <path d="M22 15.5 31 7" />
        <path d="M26.6 7H31v4.4" />
      </>
    ),
    handheld: <path d="M21 12c1.4-2.2 2.2-2.2 3.6 0s2.2 2.2 3.6 0 2.2-2.2 3.6 0" />,
    "dolly-zoom": (
      <>
        <path d="M21 8h7" />
        <path d="M25 5.8 29 8l-4 2.2" />
        <path d="M33 14.2H26" />
        <path d="M29 12 25 14.2 29 16.4" />
      </>
    ),
  };
  return (
    <svg viewBox="0 0 36 22" className="h-5 w-9" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
      <rect x="1.5" y="6" width="14" height="10" rx="2" />
      <circle cx="8.5" cy="11" r="2.1" />
      {mark[id]}
    </svg>
  );
}

export function CameraMoves({
  value,
  onChange,
}: {
  value?: CameraMove;
  onChange: (move: CameraMove | undefined) => void;
}) {
  return (
    <div className="grid grid-cols-4 gap-1.5" role="group" aria-label="Camera move">
      {CAMERA_MOVES.map((move) => {
        const active = value === move.id;
        return (
          <button
            key={move.id}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(active ? undefined : move.id)}
            className={`flex flex-col items-center gap-1 rounded-lg border px-1 py-1.5 text-[10px] leading-tight transition ${
              active
                ? "border-accent/70 bg-accent/10 text-accent"
                : "border-white/10 text-zinc-400 hover:border-white/25 hover:text-zinc-200"
            }`}
          >
            <MoveIcon id={move.id} />
            {move.label}
          </button>
        );
      })}
    </div>
  );
}
