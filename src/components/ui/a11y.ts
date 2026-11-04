// Keyboard, placement, and secret-redaction helpers shared by the primitives.
// Pure functions are covered by node:test. DOM helpers run only in the browser.

export type Side = "top" | "bottom";
export type Align = "start" | "end" | "center";

export interface AnchorBox {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/** Place a popover on the preferred side, flipping when it would leave the viewport. */
export function placePopover(
  anchor: AnchorBox,
  popover: { width: number; height: number },
  viewport: { width: number; height: number },
  preferred: Side = "bottom",
  align: Align = "start",
  gap = 8,
  margin = 8,
): { top: number; left: number; side: Side } {
  const spaceBelow = viewport.height - anchor.bottom - gap - margin;
  const spaceAbove = anchor.top - gap - margin;
  let side = preferred;
  if (preferred === "bottom" && popover.height > spaceBelow && spaceAbove > spaceBelow) side = "top";
  if (preferred === "top" && popover.height > spaceAbove && spaceBelow > spaceAbove) side = "bottom";

  let top = side === "bottom" ? anchor.bottom + gap : anchor.top - gap - popover.height;
  let left =
    align === "end"
      ? anchor.right - popover.width
      : align === "center"
        ? anchor.left + anchor.width / 2 - popover.width / 2
        : anchor.left;

  const maxLeft = Math.max(margin, viewport.width - popover.width - margin);
  const maxTop = Math.max(margin, viewport.height - popover.height - margin);
  left = Math.min(Math.max(left, margin), maxLeft);
  top = Math.min(Math.max(top, margin), maxTop);
  return { top, left, side };
}

/** Move a highlight through a list, wrapping at both ends. `current` -1 starts at an end. */
export function moveIndex(current: number, delta: number, length: number): number {
  if (length <= 0) return -1;
  if (current < 0) return delta < 0 ? length - 1 : 0;
  return (current + delta + length) % length;
}

/** Next index for Tab inside a focus trap. `current` -1 means focus is outside the trap. */
export function trapIndex(current: number, count: number, shift: boolean): number {
  if (count <= 0) return -1;
  if (current < 0) return shift ? count - 1 : 0;
  if (shift) return current === 0 ? count - 1 : current - 1;
  return current === count - 1 ? 0 : current + 1;
}

/**
 * Type-ahead match. `includeCurrent` is true once the query is more than one
 * character, so extra letters refine the same option instead of jumping ahead.
 */
export function typeaheadIndex(
  labels: readonly string[],
  query: string,
  from: number,
  includeCurrent: boolean,
): number {
  const q = query.toLowerCase();
  if (!q || labels.length === 0) return from;
  const begin = from < 0 ? 0 : includeCurrent ? from : (from + 1) % labels.length;
  for (let n = 0; n < labels.length; n++) {
    const i = (begin + n) % labels.length;
    if (labels[i].toLowerCase().startsWith(q)) return i;
  }
  return from;
}

function channel(value: number) {
  const s = value / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG contrast ratio for two #rrggbb colors. */
export function contrastRatio(foreground: string, background: string): number {
  const lum = (hex: string) => {
    const n = Number.parseInt(hex.slice(1), 16);
    const r = channel((n >> 16) & 255);
    const g = channel((n >> 8) & 255);
    const b = channel(n & 255);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const a = lum(foreground);
  const b = lum(background);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Remove anything that could be an API key from a user-facing message.
 * A high-entropy token keeps only its last 4 characters.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(?:bearer)\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|pk|rk|ak|fal)_[A-Za-z0-9_-]{6,}\b/g, "[redacted]")
    .replace(/\b(?:sk|pk|rk|ak)-[A-Za-z0-9_-]{6,}\b/g, "[redacted]")
    .replace(/((?:api[_-]?key|token|secret|authorization)\s*[:=]\s*)(\S+)/gi, "$1[redacted]")
    .replace(/\b(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}\b/g, (match) => {
      return `[redacted …${match.slice(-4)}]`;
    });
}

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "video",
  "audio",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function focusable(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => {
    if (el.getAttribute("aria-hidden") === "true") return false;
    if (el.closest("[inert]")) return false;
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden";
  });
}

interface Lock {
  el: HTMLElement;
  onEscape?: () => void;
}

const locks: Lock[] = [];
let listening = false;

export function isTopLock(el: HTMLElement | null): boolean {
  return !!el && locks.at(-1)?.el === el;
}

function onDocumentKey(event: KeyboardEvent) {
  const lock = locks.at(-1);
  if (!lock) return;
  if (event.key === "Escape" && lock.onEscape) {
    event.preventDefault();
    event.stopPropagation();
    lock.onEscape();
    return;
  }
  if (event.key !== "Tab") return;
  const items = focusable(lock.el);
  event.preventDefault();
  if (items.length === 0) {
    lock.el.focus();
    return;
  }
  const current = items.indexOf(document.activeElement as HTMLElement);
  items[trapIndex(current, items.length, event.shiftKey)]?.focus();
}

function ensureListener() {
  if (listening || typeof document === "undefined") return;
  listening = true;
  document.addEventListener("keydown", onDocumentKey, true);
}

/** The top lock traps Tab and handles Escape. Returns an unregister function. */
export function pushLock(lock: Lock): () => void {
  ensureListener();
  locks.push(lock);
  return () => {
    const index = locks.lastIndexOf(lock);
    if (index >= 0) locks.splice(index, 1);
  };
}

let scrollLocks = 0;
let previousOverflow = "";

export function lockScroll(): () => void {
  if (typeof document === "undefined") return () => {};
  if (scrollLocks === 0) {
    previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  scrollLocks += 1;
  return () => {
    scrollLocks = Math.max(0, scrollLocks - 1);
    if (scrollLocks === 0) document.body.style.overflow = previousOverflow;
  };
}
