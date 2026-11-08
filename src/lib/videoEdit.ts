// Seedance 2.5's edit mode on ArgoLink. The video to edit is the first reference video, and
// the result keeps its length and shape, so duration and ratio aren't sent.
// https://argolink.io/en/models/seedance-2.5

import type { EstimateInput } from "./registry/types";

export const EDIT_VIDEO_TYPES: Readonly<Record<string, string>> = { "video/mp4": "MP4", "video/quicktime": "MOV" };
export const EDIT_VIDEO_MAX_BYTES = 100 * 1024 * 1024;
export const EDIT_VIDEO_SECONDS = { min: 4, max: 30 } as const;

/** Shown with ArgoLink's TaskTypeMismatch error. */
export const TASK_TYPE_MISMATCH_HINT =
  'The model didn\'t read the request as an edit. Start the prompt with "Edit the video:".';

const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
const secs = (seconds: number) => `${Number(seconds.toFixed(1))} s`;

/** Why this file can't be edited, or null. `duration` is undefined when it couldn't be read. */
export function editVideoError(file: { contentType: string; bytes: number; duration?: number }): string | null {
  if (!EDIT_VIDEO_TYPES[file.contentType]) return "The video to edit must be an MP4 or MOV file.";
  if (file.bytes > EDIT_VIDEO_MAX_BYTES)
    return `The video to edit is ${mib(file.bytes)}. The limit is ${mib(EDIT_VIDEO_MAX_BYTES)}.`;
  if (file.duration === undefined || !Number.isFinite(file.duration) || file.duration <= 0)
    return "Couldn't read how long the video is. Try exporting it again as MP4.";
  const { min, max } = EDIT_VIDEO_SECONDS;
  if (file.duration < min || file.duration > max)
    return `The video to edit is ${secs(file.duration)} long. It must be ${min}–${max} s.`;
  return null;
}

/**
 * ArgoLink bills an edit as the input plus an output of the same length:
 * 2 × the video's seconds, at the with-video rate.
 */
export const editEstimateInput = (resolution: string, seconds: number): EstimateInput => ({
  resolution,
  duration: 2 * seconds,
  durationIsBilled: true,
  referenceVideoSeconds: seconds,
});

/** The listed ratio closest to the video's shape, for showing the result. Not sent. */
export function nearestRatio(ratios: readonly string[], width?: number, height?: number): string {
  const fixed = ratios.filter((ratio) => /^\d+:\d+$/.test(ratio));
  if (!width || !height || !fixed.length) return fixed.includes("16:9") ? "16:9" : (fixed[0] ?? "16:9");
  const target = Math.log(width / height);
  const value = (ratio: string) => {
    const [w, h] = ratio.split(":").map(Number);
    return Math.abs(Math.log(w / h) - target);
  };
  return fixed.reduce((best, ratio) => (value(ratio) < value(best) ? ratio : best));
}
