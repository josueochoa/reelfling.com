import type { GenerateRequest } from "../types";
import { cameraMovesFor, isCameraMove } from "./camera";
import { ratioAllowed } from "./price";
import type { ImageModel, ImageQuality, VideoModel } from "./types";

export interface ImageRequestInput {
  prompt?: string;
  ratio: string;
  resolution: string;
  quality?: string;
  count: number;
  references: readonly string[];
}

const nameOf = (model: { name: string }) => model.name;

export function videoRequestError(model: VideoModel, req: GenerateRequest): string | null {
  const caps = model.capabilities;
  const frames = req.mode === "frames";
  const label = nameOf(model);
  if (model.promptRequired && !req.prompt?.trim()) return `${label} needs a prompt`;
  if (!req.prompt?.trim() && !(frames && req.firstFrame) && !req.referenceImages?.length)
    return "Add a prompt or an image";
  if (!caps.ratios.includes(req.ratio)) return `Ratio ${req.ratio} isn't available on ${label}`;
  if (req.ratio === "adaptive" && !(frames && req.firstFrame)) return "Auto ratio needs a start frame";
  if (caps.resolutions.length && !caps.resolutions.includes(req.resolution))
    return `Resolution ${req.resolution} isn't available on ${label} (${caps.resolutions.join(", ")})`;
  const durationError = durationMessage(label, caps.durations, req.duration);
  if (durationError) return durationError;
  if (frames) {
    if (req.firstFrame && !caps.frames.start) return `${label} doesn't support a start frame`;
    if (req.lastFrame && !req.firstFrame) return "An end frame needs a start frame";
    if (req.lastFrame && !caps.frames.end) return `${label} doesn't support end frames`;
  } else {
    const images = req.referenceImages?.length ?? 0;
    const videos = req.referenceVideos?.length ?? 0;
    const audios = req.referenceAudios?.length ?? 0;
    const { image, video, audio, total } = caps.references;
    if (images > image) return `${label} takes up to ${image} reference images`;
    if (videos > video) return `${label} takes up to ${video} reference videos`;
    if (audios > audio) return `${label} takes up to ${audio} reference audio clips`;
    if (images + videos + audios > total) return `${label} takes up to ${total} references in total`;
    if (audios > 0 && images + videos === 0) return "Audio needs at least one image or video reference";
  }
  if (req.generateAudio && caps.audio === false) return `${label} doesn't generate audio`;
  if (req.seed !== undefined && !caps.seed) return `${label} doesn't take a seed`;
  if (req.cameraFixed && !(caps.camera && caps.camera.fixed)) return `${label} doesn't take camera settings`;
  if (req.cameraMove && (!isCameraMove(req.cameraMove) || !cameraMovesFor(model).includes(req.cameraMove)))
    return `${label} doesn't take camera moves`;
  if (req.watermark && !caps.watermark) return `${label} doesn't take a watermark`;
  return null;
}

function durationMessage(
  label: string,
  cap: VideoModel["capabilities"]["durations"],
  duration: number,
): string | null {
  if (!cap) return null;
  if (!Number.isInteger(duration))
    return `Duration ${duration}s isn't a whole number of seconds (${label}'s limit is ${cap.min}–${cap.max}s)`;
  if (cap.options?.length && !cap.options.includes(duration))
    return `Duration ${duration}s isn't available on ${label} (${cap.options.join(", ")}s)`;
  if (duration < cap.min) return `Duration ${duration}s is below ${label}'s ${cap.min}s limit`;
  if (duration > cap.max) return `Duration ${duration}s is above ${label}'s ${cap.max}s limit`;
  return null;
}

export function imageRequestError(model: ImageModel, req: ImageRequestInput): string | null {
  const caps = model.capabilities;
  const label = nameOf(model);
  if (!req.prompt?.trim()) return "Write a prompt";
  if (caps.resolutions.length && !caps.resolutions.includes(req.resolution))
    return `Resolution ${req.resolution} isn't available on ${label} (${caps.resolutions.join(", ")})`;
  if (!ratioAllowed(model, req.ratio, req.resolution))
    return `Ratio ${req.ratio} isn't available on ${label} at ${req.resolution.toUpperCase()}`;
  if (req.quality && !caps.qualities?.includes(req.quality as ImageQuality))
    return `Quality ${req.quality} isn't available on ${label}`;
  if (!Number.isInteger(req.count) || req.count < 1 || req.count > caps.maxImages)
    return `${label} generates 1–${caps.maxImages} images at a time`;
  if (req.references.length > caps.references.image)
    return `${label} takes up to ${caps.references.image} reference images`;
  return null;
}
