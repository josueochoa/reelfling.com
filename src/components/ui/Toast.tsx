"use client";

import { useEffect, useId, useRef, useSyncExternalStore, type ReactNode } from "react";
import { pushLock, redactSecrets } from "./a11y";
import { X } from "./Icon";

type Tone = "info" | "error";

interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastItem {
  id: string;
  message: string;
  tone: Tone;
  action?: ToastAction;
  duration: number;
  confirm?: {
    confirmLabel: string;
    cancelLabel: string;
    resolve: (ok: boolean) => void;
  };
}

const EMPTY: ToastItem[] = [];
let items: ToastItem[] = EMPTY;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot() {
  return items;
}

function empty() {
  return EMPTY;
}

export function dismissToast(id: string) {
  items = items.filter((item) => item.id !== id);
  emit();
}

/** A short message. The text is scrubbed so a key cannot land in it. */
export function toast(
  message: string,
  opts?: { tone?: Tone; action?: ToastAction; duration?: number },
) {
  const id = crypto.randomUUID();
  const item: ToastItem = {
    id,
    message: redactSecrets(message),
    tone: opts?.tone ?? "info",
    action: opts?.action,
    duration: opts?.duration ?? 5000,
  };
  items = [...items, item];
  emit();
  if (item.duration > 0 && typeof window !== "undefined") {
    window.setTimeout(() => dismissToast(id), item.duration);
  }
  return id;
}

/** Asks before a destructive action. Resolves true only when the user confirms. */
export function confirmToast(
  message: string,
  opts?: { confirmLabel?: string; cancelLabel?: string },
): Promise<boolean> {
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      items = items.filter((item) => item.id !== id);
      emit();
      resolve(ok);
    };
    items = [
      ...items,
      {
        id,
        message: redactSecrets(message),
        tone: "info",
        duration: 0,
        confirm: {
          confirmLabel: opts?.confirmLabel ?? "Confirm",
          cancelLabel: opts?.cancelLabel ?? "Cancel",
          resolve: finish,
        },
      },
    ];
    emit();
  });
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const toasts = useSyncExternalStore(subscribe, snapshot, empty);
  return (
    <>
      {children}
      <div
        aria-live="polite"
        aria-relevant="additions"
        className="pointer-events-none fixed right-4 bottom-4 z-[70] flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2"
      >
        {toasts.map((item) => (
          <ToastCard key={item.id} item={item} />
        ))}
      </div>
    </>
  );
}

function ToastCard({ item }: { item: ToastItem }) {
  const ref = useRef<HTMLDivElement>(null);
  const messageId = useId();
  const confirm = item.confirm;

  useEffect(() => {
    if (!confirm) return;
    const el = ref.current;
    if (!el) return;
    const release = pushLock({ el, onEscape: () => confirm.resolve(false) });
    el.querySelector<HTMLElement>("[data-cancel]")?.focus();
    return release;
  }, [confirm]);

  return (
    <div
      ref={ref}
      role={confirm ? "alertdialog" : "status"}
      aria-modal={confirm ? true : undefined}
      aria-labelledby={confirm ? messageId : undefined}
      className={`pointer-events-auto rounded-lg border bg-surface-3 p-3 text-fg shadow-2xl shadow-black/40 ${
        item.tone === "error" ? "border-red-400/40" : "border-line"
      }`}
    >
      <div className="flex items-start gap-3">
        <p id={messageId} className="min-w-0 flex-1 text-body whitespace-pre-line">
          {item.message}
        </p>
        {!confirm && (
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => dismissToast(item.id)}
            className="grid size-7 shrink-0 place-items-center rounded-full text-fg-muted hover:bg-white/10 hover:text-fg"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        )}
      </div>
      <div className="mt-3 flex justify-end gap-2">
        {confirm ? (
          <>
            <button
              type="button"
              data-cancel
              onClick={() => confirm.resolve(false)}
              className="rounded-md border border-line px-3 py-1.5 text-body text-fg-muted hover:text-fg"
            >
              {confirm.cancelLabel}
            </button>
            <button
              type="button"
              onClick={() => confirm.resolve(true)}
              className="rounded-md bg-red-400/15 px-3 py-1.5 text-body font-medium text-red-200 hover:bg-red-400/25"
            >
              {confirm.confirmLabel}
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => {
              item.action?.onClick();
              dismissToast(item.id);
            }}
            className="rounded-md bg-white/10 px-3 py-1.5 text-body text-fg hover:bg-white/15"
          >
            {item.action?.label ?? "Dismiss"}
          </button>
        )}
      </div>
    </div>
  );
}
