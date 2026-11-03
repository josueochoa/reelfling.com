import type { GenerateRequest } from "../types";
import { gptSize } from "./gpt-size";

export interface ImageMapInput {
  prompt: string;
  aspect?: string;
  resolution: string;
  quality?: string;
  count: number;
  images?: { image_url: string }[];
}

type ContentItem =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string }; role?: "first_frame" | "last_frame" | "reference_image" }
  | { type: "video_url"; video_url: { url: string }; role: "reference_video" }
  | { type: "audio_url"; audio_url: { url: string }; role: "reference_audio" };

/** ModelArk video task body. `request.model` is the route endpoint. */
export function buildModelArkVideo(req: GenerateRequest) {
  const content: ContentItem[] = [];
  if (req.prompt.trim()) content.push({ type: "text", text: req.prompt.trim() });

  if (req.mode === "frames") {
    if (req.firstFrame) content.push({ type: "image_url", image_url: { url: req.firstFrame }, role: "first_frame" });
    if (req.firstFrame && req.lastFrame)
      content.push({ type: "image_url", image_url: { url: req.lastFrame }, role: "last_frame" });
  } else {
    for (const url of req.referenceImages ?? [])
      content.push({ type: "image_url", image_url: { url }, role: "reference_image" });
    for (const url of req.referenceVideos ?? [])
      content.push({ type: "video_url", video_url: { url }, role: "reference_video" });
    for (const url of req.referenceAudios ?? [])
      content.push({ type: "audio_url", audio_url: { url }, role: "reference_audio" });
  }

  return {
    model: req.model,
    content,
    ratio: req.ratio,
    resolution: req.resolution,
    duration: req.duration,
    watermark: req.watermark ?? false,
    ...(req.generateAudio !== undefined && { generate_audio: req.generateAudio }),
    ...(req.seed !== undefined && { seed: req.seed }),
    ...(req.cameraFixed && { camera_fixed: true }),
    return_last_frame: true,
  };
}

function imagePath(input: ImageMapInput) {
  return input.images?.length ? "/v1/images/edits" : "/v1/images/generations";
}

export function buildArgoGoogleImage(input: ImageMapInput, endpoint: string) {
  return {
    path: imagePath(input),
    body: {
      model: endpoint,
      prompt: input.prompt,
      n: input.count,
      response_format: "url",
      ...(input.images?.length && { images: input.images }),
      aspect_ratio: input.aspect ?? "1:1",
      resolution: input.resolution,
    },
  };
}

export function buildArgoGptImage(input: ImageMapInput, endpoint: string) {
  const size = input.aspect && gptSize(input.aspect, input.resolution);
  return {
    path: imagePath(input),
    body: {
      model: endpoint,
      prompt: input.prompt,
      n: input.count,
      response_format: "url",
      ...(input.images?.length && { images: input.images }),
      ...(size && { size }),
      ...(input.quality && { quality: input.quality }),
    },
  };
}

/**
 * fal queue input assembled from the canonical request. The fal tab still submits
 * raw JSON; this mapper is what a registry route names.
 */
export function buildFalQueue(req: GenerateRequest, endpoint: string) {
  return {
    endpoint,
    input: {
      prompt: req.prompt,
      ...(req.duration !== undefined && { duration: req.duration }),
      ...(req.resolution && { resolution: req.resolution }),
      ...(req.ratio && { aspect_ratio: req.ratio }),
      ...(req.seed !== undefined && { seed: req.seed }),
      ...(req.generateAudio !== undefined && { generate_audio: req.generateAudio }),
      ...(req.firstFrame && { image_url: req.firstFrame }),
      ...(req.lastFrame && { end_image_url: req.lastFrame }),
    },
  };
}

/**
 * OpenRouter video body. Not called by a provider client — OpenRouter isn't wired up —
 * but the shape matches POST /api/v1/videos so a later provider can use this route.
 * https://openrouter.ai/docs/guides/overview/multimodal/video-generation
 */
export function buildOpenRouterVideo(req: GenerateRequest, endpoint: string) {
  // The video API documents first_frame and last_frame only.
  const frameImages = [
    req.firstFrame && { type: "image_url", image_url: { url: req.firstFrame }, frame_type: "first_frame" },
    req.lastFrame && { type: "image_url", image_url: { url: req.lastFrame }, frame_type: "last_frame" },
  ].filter((frame) => frame !== undefined);
  return {
    model: endpoint,
    prompt: req.prompt,
    duration: req.duration,
    resolution: req.resolution,
    aspect_ratio: req.ratio,
    ...(req.generateAudio !== undefined && { generate_audio: req.generateAudio }),
    ...(req.seed !== undefined && { seed: req.seed }),
    ...(frameImages.length && { frame_images: frameImages }),
  };
}
