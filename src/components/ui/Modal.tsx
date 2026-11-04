"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { isTopLock, lockScroll, pushLock } from "./a11y";
import { useIsClient } from "./useIsClient";
import { X } from "./Icon";

const SIZES = {
  sm: "w-full max-w-sm",
  md: "w-full max-w-lg",
  lg: "w-[min(1100px,94vw)]",
  full: "h-full w-full max-w-none",
} as const;

/** Replaces the size's width. Lightboxes keep their previous caps. */
const WIDTHS = {
  1200: "w-[min(1200px,94vw)]",
  1300: "w-[min(1300px,94vw)]",
} as const;

const SURFACES = {
  panel: "bg-panel",
  ink: "bg-ink",
  black: "bg-black",
} as const;

export type ModalSize = keyof typeof SIZES;
export type ModalWidth = keyof typeof WIDTHS;
export type ModalSurface = keyof typeof SURFACES;

export function Modal({
  open = true,
  onClose,
  title,
  description,
  label,
  size = "md",
  width,
  surface = "panel",
  showClose = true,
  children,
  className = "",
}: {
  /** Render nothing while closed. Defaults to open so `{cond && <Modal>}` still works. */
  open?: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  /** Accessible name when there is no visible title. */
  label?: string;
  size?: ModalSize;
  /** When set, replaces the width from `size`. */
  width?: ModalWidth;
  /** Dialog fill. Defaults to panel so callers don't pass a competing `bg-*` class. */
  surface?: ModalSurface;
  showClose?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const titleId = useId();
  const descriptionId = useId();
  const mounted = useIsClient();

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open || !mounted) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previously = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const releaseScroll = lockScroll();
    const releaseLock = pushLock({ el: dialog, onEscape: () => onCloseRef.current() });
    dialog.focus();
    return () => {
      releaseLock();
      releaseScroll();
      const fallback = document.querySelector<HTMLElement>("[data-dialog-return]");
      const target = previously?.isConnected ? previously : fallback;
      target?.focus();
    };
  }, [open, mounted]);

  if (!open || !mounted) return null;

  return createPortal(
    <div
      className={`overlay-in fixed inset-0 z-50 flex bg-black/80 p-3 sm:p-4 ${
        size === "full" ? "" : "items-center justify-center"
      }`}
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (!isTopLock(dialogRef.current)) return;
        onCloseRef.current();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-describedby={description ? descriptionId : undefined}
        aria-label={title ? undefined : label}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        className={`relative flex max-h-[min(92dvh,100%)] flex-col overflow-hidden rounded-xl border border-line text-fg shadow-2xl outline-none ${SURFACES[surface]} ${width ? WIDTHS[width] : SIZES[size]} ${className}`}
      >
        {title ? (
          <div className="flex items-start justify-between gap-3 px-5 pt-5">
            <div className="min-w-0">
              <h2 id={titleId} className="text-title text-fg">
                {title}
              </h2>
              {description && (
                <p id={descriptionId} className="mt-1 text-body text-fg-muted">
                  {description}
                </p>
              )}
            </div>
            {showClose && <CloseButton onClose={() => onCloseRef.current()} />}
          </div>
        ) : (
          showClose && <CloseButton onClose={() => onCloseRef.current()} floating />
        )}
        <div className={`min-h-0 flex-1 overflow-y-auto ${title ? "px-5 pt-4 pb-5" : ""}`}>{children}</div>
      </div>
    </div>,
    document.body,
  );
}

function CloseButton({ onClose, floating }: { onClose: () => void; floating?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label="Close"
      className={`grid size-8 shrink-0 place-items-center rounded-full text-fg-muted hover:bg-white/10 hover:text-fg ${
        floating ? "absolute top-3 right-3 z-10 bg-black/60 text-white" : ""
      }`}
    >
      <X className="size-4" aria-hidden />
    </button>
  );
}
