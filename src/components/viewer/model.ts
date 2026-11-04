// Pure viewer behavior: keyboard map, scrubber text, mention splits, optional route.
// Covered by node:test. No DOM.

import { MENTION_RE } from "@/lib/mentions";

export interface PromptPart {
  text: string;
  mention: boolean;
}

/** Splits a prompt so @mentions can be marked without using the accent as text. */
export function promptParts(prompt: string): PromptPart[] {
  const parts: PromptPart[] = [];
  let last = 0;
  for (const match of prompt.matchAll(new RegExp(MENTION_RE.source, "gi"))) {
    const index = match.index ?? 0;
    if (index > last) parts.push({ text: prompt.slice(last, index), mention: false });
    parts.push({ text: match[0], mention: true });
    last = index + match[0].length;
  }
  if (last < prompt.length || parts.length === 0) parts.push({ text: prompt.slice(last), mention: false });
  return parts;
}

/** Playback time as m:ss. Minutes can grow past 59. */
export function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

/** ARIA values for the scrubber. `aria-valuetext` is always m:ss. */
export function scrubberAria(current: number, duration: number) {
  const max = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const raw = Number.isFinite(current) && current > 0 ? current : 0;
  const now = max > 0 ? Math.min(raw, max) : 0;
  return {
    role: "slider" as const,
    "aria-valuemin": 0,
    "aria-valuemax": Math.round(max),
    "aria-valuenow": Math.round(now),
    "aria-valuetext": clock(now),
  };
}

/** Clamp a seek. Infinite deltas jump to the start or the end. */
export function seekTo(current: number, duration: number, delta: number): number {
  const max = Number.isFinite(duration) && duration > 0 ? duration : 0;
  if (delta === Number.NEGATIVE_INFINITY) return 0;
  if (delta === Number.POSITIVE_INFINITY) return max;
  const base = Number.isFinite(current) ? current : 0;
  return Math.min(max, Math.max(0, base + delta));
}

export type KeyTarget = "field" | "slider" | "tab" | "control" | "other";

export type ViewerAction =
  | { type: "ignore" }
  | { type: "play" }
  | { type: "step"; delta: -1 | 1 }
  | { type: "seek"; seconds: number }
  | { type: "fullscreen" }
  | { type: "close" };

const SEEK = 1;
const SEEK_SHIFT = 5;

/**
 * Space plays and pauses unless a control needs that key.
 * Arrow keys step through the feed. Shift, or focus on the scrubber, seeks.
 * F toggles fullscreen. Escape closes.
 */
export function viewerKeyAction(input: { key: string; shiftKey?: boolean; target: KeyTarget }): ViewerAction {
  if (input.target === "field") return { type: "ignore" };
  if (input.key === "Escape") return { type: "close" };
  if (input.key === "f" || input.key === "F") return { type: "fullscreen" };
  if (input.key === " " || input.key === "Spacebar") {
    if (input.target === "control" || input.target === "tab") return { type: "ignore" };
    return { type: "play" };
  }
  if (input.key === "ArrowLeft" || input.key === "ArrowRight") {
    if (input.target === "tab") return { type: "ignore" };
    const dir = input.key === "ArrowLeft" ? -1 : 1;
    if (input.target === "slider" || input.shiftKey) {
      return { type: "seek", seconds: dir * (input.shiftKey ? SEEK_SHIFT : SEEK) };
    }
    return { type: "step", delta: dir };
  }
  if (input.target === "slider" && input.key === "Home") return { type: "seek", seconds: Number.NEGATIVE_INFINITY };
  if (input.target === "slider" && input.key === "End") return { type: "seek", seconds: Number.POSITIVE_INFINITY };
  return { type: "ignore" };
}

/** Where a key landed, so a button keeps Space and the scrubber keeps the arrows. */
export function keyTargetOf(el: EventTarget | null): KeyTarget {
  if (!(el instanceof Element)) return "other";
  if (el.closest("[data-viewer-slider]")) return "slider";
  if (el.closest("[role='tab']")) return "tab";
  if (el.closest("input, textarea, select, [contenteditable='true']")) return "field";
  if (el.closest("button, a, [role='menuitem']")) return "control";
  return "other";
}

/** Provider route stored on a generation. Empty values stay off the details list. */
export function detailRoute(route: string | undefined): string | undefined {
  const value = route?.trim();
  return value ? value : undefined;
}

export interface ViewerDetail {
  label: string;
  value: string;
}

export function formatCreated(ms: number): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(ms);
}

/** Upscale gets its own pill. Every other tool for this kind sits behind More. */
export function toolbarFlags(tools: readonly { name: string; menu?: string; accepts: string }[], kind: string) {
  const labels = tools
    .filter((tool) => tool.accepts === kind)
    .map((tool) => (tool.menu ?? tool.name).toLowerCase());
  return {
    upscale: labels.includes("upscale"),
    more: labels.some((label) => label !== "upscale"),
  };
}
