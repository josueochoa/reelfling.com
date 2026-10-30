"use client";

// A compact picker for the image composer: a pill button that opens a menu above it.

import { useEffect, useRef, useState } from "react";

export interface DropdownOption<T extends string> {
  value: T;
  label: React.ReactNode;
  hint?: string;
  disabled?: boolean;
}

export function Dropdown<T extends string>({
  title,
  icon,
  value,
  options,
  onChange,
  display,
}: {
  title: string;
  icon?: React.ReactNode;
  value: T;
  options: DropdownOption<T>[];
  onChange: (value: T) => void;
  /** What the button shows; defaults to the selected option's label. */
  display?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
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
          open ? "bg-white/15 text-white" : "bg-white/[0.06] text-zinc-200 hover:bg-white/10"
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
          {options.map((o) => (
            <button
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              disabled={o.disabled}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
              className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm disabled:opacity-30 ${
                o.value === value ? "bg-white/10 text-white" : "text-zinc-300 hover:bg-white/5"
              }`}
            >
              <span className="min-w-0 flex-1">
                <span className="block">{o.label}</span>
                {o.hint && <span className="block text-xs text-zinc-500">{o.hint}</span>}
              </span>
              {o.value === value && <span className="text-accent">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
