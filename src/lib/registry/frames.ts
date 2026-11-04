import type { GenerateRequest } from "../types";
import type { VideoModel } from "./types";

/** Adaptive ratio matches the start frame. Without one, use 16:9. */
export function ratioForStartFrame(ratio: string, hasStartFrame: boolean): string {
  if (ratio === "adaptive" && !hasStartFrame) return "16:9";
  return ratio;
}

export function keyframeLimitOf(model: VideoModel): number {
  const frames = model.capabilities.frames;
  if (!frames.middle) return 0;
  const limit = frames.keyframeLimit ?? 0;
  return limit > 0 ? limit : 0;
}

/** Images that count toward the published keyframe cap. */
export function keyframesUsed(
  parts: { start: boolean; end: boolean; middle: number },
  shared: boolean,
): number {
  if (!shared) return parts.middle;
  return (parts.start ? 1 : 0) + parts.middle + (parts.end ? 1 : 0);
}

/**
 * The published schema must name the field. A capability flag alone is not enough
 * on a fal route: the queue body only sends `inputs.middle` or `inputs.keyframes`.
 */
export function schemaSupportsKeyframes(model: VideoModel): boolean {
  if (!model.capabilities.frames.middle || keyframeLimitOf(model) <= 0) return false;
  if (model.inputs) return !!(model.inputs.middle || model.inputs.keyframes);
  return model.routes.every((route) => route.provider !== "fal");
}

export function keyframesError(model: VideoModel, req: GenerateRequest): string | null {
  if (req.mode !== "frames") return null;
  const middle = req.middleFrames ?? [];
  if (middle.some((url) => !url)) return "A keyframe is missing its image";
  if (!middle.length) return null;
  const label = model.name;
  if (!schemaSupportsKeyframes(model)) return `${label} doesn't support keyframes`;
  if (!req.firstFrame) return "Keyframes need a start frame";
  const limit = keyframeLimitOf(model);
  const used = keyframesUsed(
    { start: !!req.firstFrame, end: !!req.lastFrame, middle: middle.length },
    !!model.capabilities.frames.sharedKeyframes,
  );
  if (used > limit) return `${label} takes up to ${limit} keyframes`;
  return null;
}
