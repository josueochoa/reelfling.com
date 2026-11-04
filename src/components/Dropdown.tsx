"use client";

// A compact picker for the image composer: a pill button that opens a menu above it.

import { useEffect, useRef, useState } from "react";
import { UnlockHint } from "./UnlockHint";

export interface DropdownOption<T extends string> {
  value: T;
  label: React.ReactNode;
  hint?: string;
  disabled?: boolean;
  /** Shown on hover or tap when the option can't be selected. Opens the keys dialog. */
  unlock?: string;
  /** Family heading, drawn once when it changes. */
  group?: string;
}

export function Dropdown<T extends string>({
  title,
  icon,
  value,
  options,
  onChange,
  display,
  onOpenKeys,
}: {
  title: string;
  icon?: React.ReactNode;
  value: T;
  options: DropdownOption<T>[];
  onChange: (value: T) => void;
  /** What the button shows; defaults to the selected option's label. */
  display?: React.ReactNode;
  onOpenKeys?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`flex h-9 items-center gap-1.5 rounded-xl px-3 text-sm whitespace-nowrap transition ${
          selected?.disabled
            ? "bg-white/[0.04] text-zinc-500"
            : open
              ? "bg-white/15 text-white"
              : "bg-white/[0.06] text-zinc-200 hover:bg-white/10"
        }`}
      >
        {icon && <span className="text-zinc-400">{icon}</span>}
        {display ?? selected?.label}
      </button>
      {open && (
        <div
          role="listbox"
          className="absolute bottom-full left-0 z-30 mb-2 max-h-80 min-w-44 overflow-y-auto rounded-xl border border-white/10 bg-panel p-1.5 shadow-2xl shadow-black/60"
        >
          <p className="px-2.5 pt-1 pb-1.5 text-xs text-zinc-500">{title}</p>
          {options.map((o, index) => {
            const locked = !!o.disabled;
            const showUnlock = locked && !!o.unlock && hover === o.value;
            const showGroup = !!o.group && o.group !== options[index - 1]?.group;
            return (
              <div
                key={o.value}
                onMouseEnter={() => setHover(o.value)}
                onMouseLeave={() => setHover((current) => (current === o.value ? null : current))}
              >
                {showGroup && (
                  <p data-testid="model-family" data-family={o.group} className="px-2.5 pt-2 pb-0.5 text-[10px] font-medium tracking-wide text-zinc-500 uppercase">
                    {o.group}
                  </p>
                )}
                <button
                  type="button"
                  role="option"
                  data-available={locked ? "false" : "true"}
                  aria-selected={o.value === value}
                  aria-disabled={locked || undefined}
                  disabled={locked && !o.unlock}
                  onClick={() => {
                    if (locked) {
                      setHover(o.value);
                      return;
                    }
                    onChange(o.value);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm ${
                    locked
                      ? "cursor-not-allowed text-zinc-500 disabled:opacity-30"
                      : o.value === value
                        ? "bg-white/10 text-white"
                        : "text-zinc-300 hover:bg-white/5"
                  } ${o.value === value && locked ? "bg-white/5" : ""}`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block">{o.label}</span>
                    {o.hint && !showUnlock && <span className="block text-xs text-zinc-500">{o.hint}</span>}
                  </span>
                  {o.value === value && !locked && <span className="text-accent">✓</span>}
                </button>
                {showUnlock && onOpenKeys && (
                  <div className="px-2.5 pb-1.5">
                    <UnlockHint hint={o.unlock!} onOpen={onOpenKeys} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
