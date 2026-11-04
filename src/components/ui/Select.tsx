"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { moveIndex, typeaheadIndex } from "./a11y";
import { Check, ChevronDown, Lock } from "./Icon";
import { Popover } from "./Popover";

export interface SelectOption {
  value: string;
  label: string;
  subtitle?: string;
  /** Visible, but Enter and click do not select it. */
  locked?: boolean;
}

export function Select({
  value,
  onChange,
  options,
  label = "Choose",
  placeholder = "Choose",
  locked = false,
  disabled = false,
  className = "",
}: {
  value: string;
  onChange: (value: string) => void;
  options: readonly SelectOption[];
  /** Accessible name, announced with the current value. */
  label?: string;
  placeholder?: string;
  /** The whole control stays visible and cannot be opened. */
  locked?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const buffer = useRef("");
  const bufferTimer = useRef(0);
  const selected = options.find((option) => option.value === value);
  const unavailable = locked || disabled;

  useEffect(() => {
    if (!open) return;
    document.getElementById(`${listId}-${active}`)?.focus();
  }, [open, active, listId]);

  function openList() {
    if (unavailable) return;
    const selectedIndex = options.findIndex((option) => option.value === value);
    setActive(selectedIndex >= 0 ? selectedIndex : 0);
    setOpen(true);
  }

  function choose(index: number) {
    const option = options[index];
    if (!option || option.locked) return;
    onChange(option.value);
    setOpen(false);
  }

  function onListKey(event: KeyboardEvent) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
      event.preventDefault();
      event.stopPropagation();
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? options.length - 1
            : moveIndex(active, event.key === "ArrowDown" ? 1 : -1, options.length);
      setActive(next);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      choose(active);
      return;
    }
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      event.stopPropagation();
      const grew = buffer.current.length > 0;
      buffer.current = (buffer.current + event.key).slice(-32);
      window.clearTimeout(bufferTimer.current);
      bufferTimer.current = window.setTimeout(() => {
        buffer.current = "";
      }, 500);
      const next = typeaheadIndex(
        options.map((option) => option.label),
        buffer.current,
        active,
        grew && buffer.current.length > 1,
      );
      setActive(next);
    }
  }

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-disabled={locked || undefined}
        aria-label={`${label}, ${selected?.label ?? placeholder}`}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={(event) => {
          if (unavailable || open) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            openList();
          }
        }}
        className={`inline-flex max-w-full items-center gap-2 rounded-full border border-line bg-surface-2 px-3 py-1.5 text-left text-body text-fg disabled:opacity-40 ${
          locked ? "cursor-not-allowed text-fg-subtle" : "hover:border-line-strong"
        } ${className}`}
      >
        <span className="truncate">{selected?.label ?? placeholder}</span>
        {locked ? (
          <Lock className="size-3.5 shrink-0" aria-hidden />
        ) : (
          <ChevronDown className="size-3.5 shrink-0 text-fg-muted" aria-hidden />
        )}
      </button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        autoFocus={false}
        className="min-w-52 p-1"
      >
        <div id={listId} role="listbox" aria-label={label} tabIndex={-1} onKeyDown={onListKey} className="outline-none">
          {options.map((option, index) => {
            const isSelected = option.value === value;
            const isActive = index === active;
            return (
              <button
                key={`${option.value}-${index}`}
                id={`${listId}-${index}`}
                type="button"
                role="option"
                aria-selected={isSelected}
                aria-disabled={option.locked || undefined}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(index)}
                className={`flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left ${
                  option.locked ? "cursor-not-allowed text-fg-subtle" : isActive ? "bg-white/10 text-fg" : "text-fg"
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-body">{option.label}</span>
                  {option.subtitle && <span className="block text-label text-fg-subtle">{option.subtitle}</span>}
                </span>
                {option.locked && <Lock className="size-3.5 shrink-0" aria-hidden />}
                {isSelected && !option.locked && <Check className="size-3.5 shrink-0 text-accent" aria-hidden />}
              </button>
            );
          })}
        </div>
      </Popover>
    </>
  );
}
