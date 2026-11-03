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

export interface OpenRouterImageCall {
  path: "/images";
  /** How many POSTs to make. Nano Banana rejects n > 1, so each image is its own request. */
  times: number;
  body: Record<string, unknown>;
}

/**
 * OpenRouter image body.
 * Nano Banana (`google/gemini-nano-banana-2.1`) accepts resolution and n = 1.
 * GPT Image accepts quality, aspect_ratio (including auto), and n up to 10.
 * Checked against GET https://openrouter.ai/api/v1/images/models (Nov 2026).
 */
export function buildOpenRouterImage(input: ImageMapInput, endpoint: string): OpenRouterImageCall {
  const google = endpoint === "google/gemini-nano-banana-2.1";
  const references = input.images?.map((image) => ({
    type: "image_url",
    image_url: { url: image.image_url },
  }));
  return {
    path: "/images",
    times: google ? input.count : 1,
    body: {
      model: endpoint,
      prompt: input.prompt,
      aspect_ratio: input.aspect ?? "auto",
      ...(google ? { resolution: input.resolution.toUpperCase(), n: 1 } : { n: input.count }),
      ...(!google && input.quality && { quality: input.quality }),
      ...(references?.length && { input_references: references }),
    },
  };
}

