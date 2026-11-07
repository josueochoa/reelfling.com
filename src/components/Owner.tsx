"use client";

// Teammates' work in the main tabs: a badge with who made it, and a slow refresh so
// their new generations show up without reloading.

import { useEffect, useRef } from "react";
import type { TeamAuthor } from "@/lib/teamPolicy";

const TEAM_REFRESH_MS = 30_000;

export const ownerName = (owner: TeamAuthor) => owner.name?.split(" ")[0] || owner.email.split("@")[0];

export function OwnerBadge({ owner, className = "" }: { owner: TeamAuthor; className?: string }) {
  return (
    <span
      data-testid="owner-badge"
      title={`Made by ${owner.name ?? owner.email}`}
      className={`inline-flex max-w-full items-center gap-1 rounded-full bg-black/70 py-0.5 pr-2 pl-0.5 text-[10px] text-zinc-200 ${className}`}
    >
      <span aria-hidden className="grid size-4 shrink-0 place-items-center rounded-full bg-white/25 text-[9px] font-semibold text-white">
        {(owner.name ?? owner.email).charAt(0).toUpperCase()}
      </span>
      <span className="truncate">{ownerName(owner)}</span>
    </span>
  );
}

/** Calls `reload` every 30 s while the page is visible. Off when the user has no teammates. */
export function useTeamRefresh(enabled: boolean, reload: () => void) {
  const latest = useRef(reload);
  useEffect(() => {
    latest.current = reload;
  });
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") latest.current();
    }, TEAM_REFRESH_MS);
    return () => clearInterval(timer);
  }, [enabled]);
}
