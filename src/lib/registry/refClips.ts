// How long reference videos and audio clips may be. A provider that publishes these
// limits rejects the request otherwise, so the panel and the route check them first.

import type { VideoModel } from "./types";

const secs = (seconds: number) => `${Number(seconds.toFixed(1))} s`;

export interface ReferenceClips {
  /** Seconds of each reference video. Undefined when the length couldn't be read. */
  videos?: readonly (number | undefined)[];
  /** Seconds of each reference audio clip. */
  audios?: readonly (number | undefined)[];
  /** Output length the request asks for. */
  duration?: number;
}

/** Why these reference clips can't be sent to this model, or null. Unread lengths are skipped. */
export function referenceClipError(model: VideoModel, clips: ReferenceClips): string | null {
  const caps = model.capabilities;
  const limits = caps.references.clipSeconds;
  const label = model.name;
  for (const [kind, noun, list] of [
    ["video", "reference video", clips.videos],
    ["audio", "reference audio clip", clips.audios],
  ] as const) {
    const limit = limits?.[kind];
    const known = (list ?? []).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    if (!limit || !known.length) continue;
    const bad = known.find((value) => value < limit.min || value > limit.max);
    if (bad !== undefined)
      return `A ${noun} is ${secs(bad)} long. ${label} takes ${noun}s of ${limit.min}–${limit.max} s. Trim it and add it again.`;
    const total = known.reduce((sum, value) => sum + value, 0);
    if (limit.total !== undefined && total > limit.total)
      return `The ${noun}s add up to ${secs(total)}. ${label} takes ${limit.total} s of them in total.`;
  }
  const cap = caps.references.outputPlusVideoSeconds;
  const videoSeconds = (clips.videos ?? []).reduce<number>((sum, value) => sum + (value ?? 0), 0);
  if (cap !== undefined && clips.duration !== undefined && videoSeconds > 0 && clips.duration + videoSeconds > cap)
    return `The video plus its reference videos is ${secs(clips.duration + videoSeconds)}. ${label} takes ${cap} s in total, so shorten the duration or the references.`;
  return null;
}
