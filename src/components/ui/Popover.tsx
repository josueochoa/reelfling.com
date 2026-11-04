"use client";

import { useEffect, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { focusable, moveIndex, placePopover, pushLock, type Align, type Side } from "./a11y";
import { useIsClient } from "./useIsClient";

export function Popover({
  open,
  onClose,
  anchorRef,
  children,
  align = "start",
  side = "bottom",
  className = "",
  autoFocus = true,
}: {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  children: ReactNode;
  align?: Align;
  side?: Side;
  className?: string;
  /** Focus the first item when the panel opens. Select focuses a chosen option itself. */
  autoFocus?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const mounted = useIsClient();

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const anchor = anchorRef.current;
      const panel = panelRef.current;
      if (!anchor || !panel) return;
      const box = anchor.getBoundingClientRect();
      const size = panel.getBoundingClientRect();
      const placed = placePopover(
        box,
        { width: size.width, height: size.height },
        { width: window.innerWidth, height: window.innerHeight },
        side,
        align,
      );
      panel.style.top = `${placed.top}px`;
      panel.style.left = `${placed.left}px`;
      panel.style.visibility = "visible";
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, mounted, side, align, anchorRef]);

  useEffect(() => {
    if (!open || !mounted) return;
    const panel = panelRef.current;
    if (!panel) return;
    const release = pushLock({ el: panel, onEscape: () => onCloseRef.current() });
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panel.contains(target) || anchorRef.current?.contains(target)) return;
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
    };
    document.addEventListener("pointerdown", onPointer, true);
    if (autoFocus) {
      const items = focusable(panel);
      (items[0] ?? panel).focus();
    }
    const anchor = anchorRef.current;
    return () => {
      release();
      document.removeEventListener("pointerdown", onPointer, true);
      if (anchor?.isConnected) anchor.focus();
    };
  }, [open, mounted, autoFocus, anchorRef]);

  function onKeyDown(event: KeyboardEvent) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, select")) return;
    const panel = panelRef.current;
    if (!panel) return;
    const items = focusable(panel);
    if (items.length === 0) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : moveIndex(index, event.key === "ArrowDown" ? 1 : -1, items.length);
    items[next]?.focus();
  }

  if (!open || !mounted) return null;

  return createPortal(
    <div
      ref={panelRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      style={{ top: 0, left: 0, visibility: "hidden" }}
      className={`overlay-in fixed z-[60] max-h-[min(24rem,calc(100dvh-1rem))] overflow-y-auto rounded-lg border border-line bg-surface-3 text-fg shadow-2xl shadow-black/50 outline-none ${className}`}
    >
      {children}
    </div>,
    document.body,
  );
}
