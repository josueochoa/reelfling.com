// Lip-sync cost, duration limits, and mismatch copy. No catalog and no keys.
// Schemas and prices were read on Nov 4, 2026, with no API key:
//   GET https://api.fal.ai/v1/models?endpoint_id=…&expand=openapi-3.0
//   https://fal.ai/models/<endpoint>/llms.txt
// GET /v1/models/pricing returns 401 without a key. The llms.txt price is the published one.
//
// sync-3's per-mode sentences are the behavior matrix for the enum fal publishes
// (`cut_off`, `loop`, `bounce`, `silence`, `remap`). fal names the modes and says
// they handle a duration mismatch; the matrix is Sync's sync_mode guide, which is
// the same enum. https://sync.so/docs/developer-guides/sync-mode.md

import type { ToolQuote } from "./toolTypes";
import { formatUpscaleCost } from "./upscaleQuote";

const EPS = 0.05;

export interface DurationNote {
  audioLonger: string;
  videoLonger: string;
}

export interface LipsyncMedia {
  duration?: number;
  contentType?: string;
  bytes?: number;
}

interface LipsyncSpec {
  id: string;
  quote: ToolQuote;
  rateLabel: string;
  limits?: {
    videoMin?: number;
    videoMax?: number;
    audioMin?: number;
    audioMax?: number;
    audioMaxBytes?: number;
    videoTypes?: readonly string[];
    videoTypeLabel?: string;
  };
  /** Enum field whose value picks the note. Absent when the schema has no such field. */
  field?: string;
  byOption?: Readonly<Record<string, DurationNote>>;
  note?: DurationNote;
}

const SYNC_NOTE: Record<string, DurationNote> = {
  cut_off: {
    audioLonger: "Cut off clips the extra audio so the output matches the video.",
    videoLonger: "Cut off trims the video to the audio.",
  },
  loop: {
    audioLonger: "Loop restarts the video until the audio ends.",
    videoLonger: "Loop trims the video to the audio.",
  },
  bounce: {
    audioLonger: "Bounce plays the video forward, then backward, until the audio ends.",
    videoLonger: "Bounce trims the video to the audio.",
  },
  silence: {
    audioLonger: "Silence keeps the full audio length.",
    videoLonger: "Silence pads the rest of the video with silence.",
  },
  remap: {
    audioLonger: "Remap slows the video down to the audio length.",
    videoLonger: "Remap speeds the video up to the audio length.",
  },
};

const SPECS: readonly LipsyncSpec[] = [
  {
    id: "fal:fal-ai/sync-lipsync/v3",
    quote: { type: "per_second", usd: 8 / 60, basis: "sync_output", perMinute: 8 },
    rateLabel: `${perSecond(8 / 60)} ($8/min)`,
    field: "sync_mode",
    byOption: SYNC_NOTE,
  },
  {
    id: "fal:fal-ai/kling-video/lipsync/audio-to-video",
    quote: { type: "per_second", usd: 0.014, basis: "video_ceil_5", step: 5 },
    rateLabel: `${perSecond(0.014)} of video, in 5s steps`,
    limits: {
      videoMin: 2,
      videoMax: 10,
      audioMin: 2,
      audioMax: 60,
      audioMaxBytes: 5_000_000,
      videoTypes: ["video/mp4", "video/quicktime"],
      videoTypeLabel: "MP4 or MOV",
    },
    note: {
      audioLonger: "Kling publishes no trim or loop setting. It accepts audio that runs past a 2–10s clip.",
      videoLonger: "Kling publishes no trim or loop setting. It accepts a 2–10s clip with shorter audio.",
    },
  },
  {
    id: "fal:veed/lipsync/v2",
    quote: { type: "per_second", usd: 0.07, basis: "output_video" },
    rateLabel: `${perSecond(0.07)} of output`,
    note: {
      audioLonger: "VEED publishes no trim or loop setting. The request is the video and the new audio.",
      videoLonger: "VEED publishes no trim or loop setting. The request is the video and the new audio.",
    },
  },
  {
    id: "fal:fal-ai/latentsync",
    quote: { type: "per_second", usd: 0.005, basis: "latent_output", flat: 0.2, flatUntil: 40 },
    rateLabel: `${perSecond(0.005)} after 40s, or $0.20 up to 40s`,
    field: "loop_mode",
    byOption: {
      loop: {
        audioLonger: "Loop restarts the video until the audio ends.",
        videoLonger: "LatentSync only publishes a loop mode for when audio is longer. It publishes no trim for the extra video.",
      },
      pingpong: {
        audioLonger: "Ping-pong plays the video forward and back until the audio ends.",
        videoLonger: "LatentSync only publishes a loop mode for when audio is longer. It publishes no trim for the extra video.",
      },
    },
  },
];

function specFor(id: string): LipsyncSpec | undefined {
  return SPECS.find((item) => item.id === id);
}

export function lipsyncQuote(id: string): ToolQuote | undefined {
  return specFor(id)?.quote;
}

export function isLipsyncTool(id: string): boolean {
  return specFor(id) !== undefined;
}

/** "$0.133/s". Three decimals under a dollar, trailing zeros dropped. */
export function perSecond(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(2)}/s`;
  return `$${usd.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}/s`;
}

export function formatSeconds(seconds: number): string {
  const rounded = Math.round(seconds * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}s` : `${rounded.toFixed(1)}s`;
}

function close(a: number, b: number): boolean {
  return Math.abs(a - b) < EPS;
}

function finite(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Output length sync-3's mode produces: the shorter input for cut_off, the longer for silence, else the audio. */
export function syncOutputSeconds(mode: string, video: number, audio: number): number {
  if (mode === "cut_off") return Math.min(video, audio);
  if (mode === "silence") return Math.max(video, audio);
  return audio;
}

/** Kling bills the video, rounded up to the next 5 seconds. 7s bills as 10s. */
export function klingBilledSeconds(video: number): number {
  return Math.ceil((video - 1e-9) / 5) * 5;
}

function latentOutputSeconds(video: number, audio: number): number {
  return audio > video + EPS ? audio : video;
}

function latentUsd(seconds: number): number {
  if (seconds <= 40) return 0.2;
  return seconds * 0.005;
}

export function lipsyncUsd(
  id: string,
  input: { video?: number; audio?: number; option?: string },
): number | undefined {
  const spec = specFor(id);
  const quote = spec?.quote;
  if (!spec || !quote || quote.type !== "per_second") return undefined;
  const video = input.video;
  const audio = input.audio;
  if (quote.basis === "video_ceil_5") {
    if (!finite(video)) return undefined;
    return klingBilledSeconds(video) * quote.usd;
  }
  if (!finite(video) || !finite(audio)) return undefined;
  if (quote.basis === "sync_output") return syncOutputSeconds(input.option || "cut_off", video, audio) * quote.usd;
  if (quote.basis === "output_video") return close(video, audio) ? video * quote.usd : undefined;
  if (quote.basis === "latent_output") return latentUsd(latentOutputSeconds(video, audio));
  return undefined;
}

/** The line shown before Run. Always includes the per-second rate when this is a lip-sync tool. */
export function lipsyncEstimate(
  id: string,
  input: { video?: number; audio?: number; option?: string },
): { text: string; usd?: number } | undefined {
  const spec = specFor(id);
  if (!spec) return undefined;
  const usd = lipsyncUsd(id, input);
  const text = usd === undefined ? spec.rateLabel : `Est. cost ${formatUpscaleCost(usd)} · ${spec.rateLabel}`;
  return { text, ...(usd !== undefined ? { usd } : {}) };
}

/**
 * What this endpoint does when the lengths differ. Undefined when they match,
 * or when there is no audio yet.
 */
export function mismatchNotice(
  id: string,
  input: { video?: number; audio?: number; option?: string },
): string | undefined {
  const spec = specFor(id);
  if (!spec) return undefined;
  const video = input.video;
  const audio = input.audio;
  if (!finite(video) || !finite(audio)) {
    if (finite(video) || finite(audio))
      return "Duration isn't stored on both files, so a length mismatch can't be checked.";
    return undefined;
  }
  if (close(video, audio)) return undefined;
  const note = spec.field ? spec.byOption?.[input.option || ""] : spec.note;
  if (!note) return undefined;
  const handling = audio > video ? note.audioLonger : note.videoLonger;
  const which = audio > video ? "Audio is longer" : "Video is longer";
  return `${which} (${formatSeconds(audio)} audio, ${formatSeconds(video)} video). ${handling}`;
}

/** Why this pair can't be sent. Undefined when it can. */
export function lipsyncLimitError(id: string, video: LipsyncMedia, audio: LipsyncMedia, name: string): string | undefined {
  const limits = specFor(id)?.limits;
  if (!limits) return undefined;
  if (video.contentType && limits.videoTypes && !limits.videoTypes.includes(video.contentType)) {
    return `This file is ${video.contentType}. ${name}'s limit is ${limits.videoTypeLabel ?? limits.videoTypes.join(" or ")}.`;
  }
  if (limits.videoMin !== undefined && limits.videoMax !== undefined) {
    if (!finite(video.duration)) return `This video has no duration. ${name}'s limit is ${limits.videoMin}–${limits.videoMax}s.`;
    if (video.duration < limits.videoMin || video.duration > limits.videoMax)
      return `This video is ${formatSeconds(video.duration)}. ${name}'s limit is ${limits.videoMin}–${limits.videoMax}s.`;
  }
  if (limits.audioMin !== undefined && limits.audioMax !== undefined) {
    if (!finite(audio.duration)) return `This audio has no duration. ${name}'s limit is ${limits.audioMin}–${limits.audioMax}s.`;
    if (audio.duration < limits.audioMin || audio.duration > limits.audioMax)
      return `This audio is ${formatSeconds(audio.duration)}. ${name}'s limit is ${limits.audioMin}–${limits.audioMax}s.`;
  }
  if (limits.audioMaxBytes !== undefined && audio.bytes !== undefined && audio.bytes > limits.audioMaxBytes) {
    const shown = `${(audio.bytes / 1_000_000).toFixed(1)} MB`;
    const cap = `${limits.audioMaxBytes / 1_000_000} MB`;
    return `This audio is ${shown}. ${name}'s limit is ${cap}.`;
  }
  return undefined;
}

/** Drop loop_mode when audio is not longer. The schema only defines it for that case. */
export function omitInactiveLoop(
  params: Record<string, string | number | boolean>,
  video?: number,
  audio?: number,
): Record<string, string | number | boolean> {
  if (params.loop_mode === undefined || !finite(video) || !finite(audio) || audio > video + EPS) return params;
  const next = { ...params };
  delete next.loop_mode;
  return next;
}
