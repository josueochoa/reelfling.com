"use client";

import { useEffect, useRef, useState } from "react";
import type { Me } from "./api";

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < units.length - 1);
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

export function UserMenu({ me, onOpen, onOpenKeys }: { me: Me; onOpen: () => void; onOpenKeys: () => void }) {
  const { user, storage } = me;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    // Full reload on purpose: drops all signed-in client state.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = "/login";
  }

  const initial = (user.name ?? user.email).charAt(0).toUpperCase();

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => {
          // Refresh storage usage, which changes as videos finish.
          if (!open) onOpen();
          setOpen((o) => !o);
        }}
        className="grid size-8 place-items-center overflow-hidden rounded-full bg-white/10 text-sm font-medium"
        aria-label="Account menu"
      >
        {user.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={user.avatarUrl} alt="" referrerPolicy="no-referrer" className="size-full object-cover" />
        ) : (
          initial
        )}
      </button>
      {open && (
        <div className="absolute top-full right-0 z-30 mt-2 w-60 rounded-xl border border-white/10 bg-panel p-1.5 shadow-2xl shadow-black/60">
          <div className="px-2.5 py-2">
            {user.name && <p className="truncate text-sm font-medium">{user.name}</p>}
            <p className="truncate text-xs text-zinc-500">{user.email}</p>
          </div>
          <div className="my-1 h-px bg-white/5" />
          <div className="px-2.5 py-2 text-xs">
            <div className="flex justify-between text-zinc-400">
              <span>Storage</span>
              <span className="text-zinc-200 tabular-nums">{formatBytes(storage.bytes)}</span>
            </div>
            <p className="mt-0.5 text-zinc-600">
              {storage.objects} {storage.objects === 1 ? "file" : "files"} ·{" "}
              {storage.driver === "r2" ? "Cloudflare R2" : "Local disk"}
            </p>
          </div>
          <div className="my-1 h-px bg-white/5" />
          <MenuItem
            onClick={() => {
              setOpen(false);
              onOpenKeys();
            }}
          >
            API keys
          </MenuItem>
          <MenuItem onClick={signOut}>Sign out</MenuItem>
        </div>
      )}
    </div>
  );
}

function MenuItem({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="w-full rounded-lg px-2.5 py-2 text-left text-sm text-zinc-300 hover:bg-white/5 hover:text-white"
    >
      {children}
    </button>
  );
}
