import type { CameraCapabilities, ImageModel, ImageResolution, PerSecondPrice, VideoModel } from "./types";

const RATIOS = ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"] as const;

// BytePlus bills Seedance in tokens: duration × width × height × 24 / 1024, times the
// per-token rate. Sizes are the published 16:9 examples, so a 5s 720p Seedance 2.0 clip
// estimates at about $0.76 — the figure in the ModelArk pricing examples.
// https://www.byteplus.com/en/product/modelark/pricing
// https://ai.byteplus.com/ark/region:ap-southeast-1/docs/model-pricing

const SEEDANCE_2_PIXELS = {
  "480p": { width: 864, height: 480 },
  "720p": { width: 1280, height: 720 },
  "1080p": { width: 1920, height: 1080 },
} as const;

const modelarkCaps = {
  seed: true,
  promptExpansion: false,
  watermark: true,
  lastFrameOutput: true,
} as const;

// `camera_fixed` is a boolean lock. BytePlus's create-task page lists it for
// Seedance 1.0 Pro, 1.0 Pro Fast, and 1.5 Pro — not the 2.0 series.
// https://ai.byteplus.com/ark/region:ap-southeast-1/docs/create-video-generation-task-api
const seedance10Camera: CameraCapabilities = {
  fixed: true,
  prompt: true,
  native: { static: { param: "camera_fixed", value: true } },
};

// No camera parameter: ArgoLink doesn't expose one, and BytePlus doesn't list
// camera_fixed for the Seedance 2.0 series. The preset is a prompt line.
const promptCamera: CameraCapabilities = { prompt: true };

const argolinkCaps = {
  seed: false,
  promptExpansion: false,
  camera: { prompt: true },
  watermark: false,
  lastFrameOutput: false,
  ratios: RATIOS,
  audio: "optional",
  frames: { start: true, middle: false, end: true },
} as const;

function video(model: VideoModel & { price: NonNullable<VideoModel["price"]> }): VideoModel {
  return model;
}

function image(model: ImageModel & { price: NonNullable<ImageModel["price"]> }): ImageModel {
  return model;
}

const perImage = (price: Record<ImageResolution, number>) => ({ type: "per_image" as const, byResolution: price });

/** Per-second price with ArgoLink's reference-video billing (floor seconds, 5/3 minimum). */
function argolinkSeconds(
  byResolution: PerSecondPrice["byResolution"],
  byResolutionWithVideo: PerSecondPrice["byResolution"],
): PerSecondPrice {
  return { type: "per_second", byResolution, byResolutionWithVideo, referenceBilling: "argolink" };
}

/** ModelArk and ArgoLink. Edited by hand; fal and OpenRouter come from catalog:sync. */
export const HAND_MODELS: Array<VideoModel | ImageModel> = [
  video({
    id: "dreamina-seedance-2-0-260128",
    family: "Seedance",
    name: "Seedance 2.0",
    description: "Multimodal references, native audio, up to 15s",
    group: "video",
    task: "t2v",
    tasks: ["t2v", "i2v", "ref2v"],
    routes: [{ provider: "modelark", endpoint: "dreamina-seedance-2-0-260128", mapper: "modelark.video" }],
    promptRequired: false,
    refSyntax: "brackets",
    capabilities: {
      ...modelarkCaps,
      camera: promptCamera,
      ratios: RATIOS,
      resolutions: ["480p", "720p", "1080p"],
      durations: { min: 4, max: 15, default: 5 },
      audio: "optional",
      frames: { start: true, middle: false, end: true },
      references: { image: 9, video: 3, audio: 3, total: 15 },
    },
    // Without video: $7.00 / M tokens at 480p and 720p, $7.70 / M at 1080p.
    // With video: $4.30 / M at 480p and 720p, $4.70 / M at 1080p. Input video seconds
    // are added to the token count; reference images and audio are free.
    // https://ai.byteplus.com/ark/region:ap-southeast-1/docs/model-pricing
    price: {
      type: "tokens",
      usdPerToken: 0.000007,
      usdPerTokenWithVideo: 0.0000043,
      byResolution: { "480p": 0.000007, "720p": 0.000007, "1080p": 0.0000077 },
      byResolutionWithVideo: { "480p": 0.0000043, "720p": 0.0000043, "1080p": 0.0000047 },
      fps: 24,
      pixels: SEEDANCE_2_PIXELS,
    },
  }),
  video({
    id: "seedance-1-0-pro-250528",
    family: "Seedance",
    name: "Seedance 1.0 Pro",
    description: "Text and image to video, 1080p",
    group: "video",
    task: "t2v",
    tasks: ["t2v", "i2v"],
    routes: [{ provider: "modelark", endpoint: "seedance-1-0-pro-250528", mapper: "modelark.video" }],
    promptRequired: false,
    refSyntax: "brackets",
    capabilities: {
      ...modelarkCaps,
      camera: seedance10Camera,
      ratios: RATIOS,
      resolutions: ["480p", "720p", "1080p"],
      durations: { min: 2, max: 12, default: 5 },
      audio: false,
      frames: { start: true, middle: false, end: false },
      references: { image: 0, video: 0, audio: 0, total: 0 },
    },
    // $2.50 / M tokens. Pixel sizes are the published 16:9 examples ($0.12 / $0.26 / $0.61 for 5s).
    price: {
      type: "tokens",
      usdPerToken: 0.0000025,
      fps: 24,
      pixels: {
        "480p": { width: 864, height: 480 },
        "720p": { width: 1248, height: 704 },
        "1080p": { width: 1920, height: 1088 },
      },
    },
  }),
  video({
    id: "seedance-2.5",
    family: "Seedance",
    name: "Seedance 2.5",
    description: "Newest model, up to 30s, 30 reference images",
    group: "video",
    task: "t2v",
    tasks: ["t2v", "i2v", "ref2v"],
    routes: [{ provider: "argolink", endpoint: "seedance-2.5", mapper: "argolink.video" }],
    promptRequired: true,
    refSyntax: "at",
    capabilities: {
      ...argolinkCaps,
      resolutions: ["480p", "720p", "1080p"],
      durations: { min: 4, max: 30, default: 5 },
      references: { image: 30, video: 10, audio: 10, total: 50 },
    },
    // https://argolink.io/en/models/seedance-2.5 — with-video rates are the lower tier.
    price: argolinkSeconds(
      { "480p": 0.0874, "720p": 0.196, "1080p": 0.483 },
      { "480p": 0.0523, "720p": 0.117, "1080p": 0.289 },
    ),
  }),
  video({
    id: "seedance-2.0",
    family: "Seedance",
    name: "Seedance 2.0",
    description: "Multimodal references, native audio, up to 4K",
    group: "video",
    task: "t2v",
    tasks: ["t2v", "i2v", "ref2v"],
    routes: [{ provider: "argolink", endpoint: "seedance-2.0", mapper: "argolink.video" }],
    promptRequired: true,
    refSyntax: "at",
    capabilities: {
      ...argolinkCaps,
      resolutions: ["480p", "720p", "1080p", "4k"],
      durations: { min: 4, max: 15, default: 5 },
      references: { image: 9, video: 3, audio: 3, total: 15 },
    },
    // https://argolink.io/en/models/seedance-2.0
    price: argolinkSeconds(
      { "480p": 0.0598, "720p": 0.129, "1080p": 0.318, "4k": 0.661 },
      { "480p": 0.0367, "720p": 0.0792, "1080p": 0.194, "4k": 0.397 },
    ),
  }),
  video({
    id: "seedance-2.0-fast",
    family: "Seedance",
    name: "Seedance 2.0 Fast",
    description: "Faster, cheaper 2.0 — up to 720p",
    group: "video",
    task: "t2v",
    tasks: ["t2v", "i2v", "ref2v"],
    routes: [{ provider: "argolink", endpoint: "seedance-2.0-fast", mapper: "argolink.video" }],
    promptRequired: true,
    refSyntax: "at",
    capabilities: {
      ...argolinkCaps,
      resolutions: ["480p", "720p"],
      durations: { min: 4, max: 15, default: 5 },
      references: { image: 9, video: 3, audio: 3, total: 15 },
    },
    // https://argolink.io/en/models/seedance-2.0-fast
    price: argolinkSeconds(
      { "480p": 0.0478, "720p": 0.103 },
      { "480p": 0.0282, "720p": 0.0607 },
    ),
  }),
  video({
    id: "seedance-2.0-mini",
    family: "Seedance",
    name: "Seedance 2.0 Mini",
    description: "Cheapest drafts — up to 720p",
    group: "video",
    task: "t2v",
    tasks: ["t2v", "i2v", "ref2v"],
    routes: [{ provider: "argolink", endpoint: "seedance-2.0-mini", mapper: "argolink.video" }],
    promptRequired: true,
    refSyntax: "at",
    capabilities: {
      ...argolinkCaps,
      resolutions: ["480p", "720p"],
      durations: { min: 4, max: 15, default: 5 },
      references: { image: 9, video: 3, audio: 3, total: 15 },
    },
    // https://argolink.io/en/models/seedance-2.0-mini
    price: argolinkSeconds(
      { "480p": 0.0299, "720p": 0.0643 },
      { "480p": 0.0179, "720p": 0.0386 },
    ),
  }),
  image({
    id: "nano-banana-2.1",
    family: "Nano Banana",
    name: "Nano Banana 2.1",
    mark: "G",
    description: "Google's image model. Thinks before drawing; great at edits that keep faces and details.",
    group: "image",
    task: "image",
    tasks: ["image", "image-edit"],
    routes: [
      { provider: "argolink", endpoint: "nano-banana-2.1", mapper: "argolink.image.google" },
      { provider: "openrouter", endpoint: "google/gemini-nano-banana-2.1", mapper: "openrouter.image" },
    ],
    promptRequired: true,
    refSyntax: "plain",
    capabilities: {
      ratios: [
        "auto",
        "1:1",
        "16:9",
        "9:16",
        "4:3",
        "3:4",
        "3:2",
        "2:3",
        "5:4",
        "4:5",
        "21:9",
        "1:4",
        "4:1",
        "1:8",
        "8:1",
      ],
      // Extreme ratios exist at 1K only. The limit is data, not a name check.
      ratioResolutions: { "1:4": ["1k"], "4:1": ["1k"], "1:8": ["1k"], "8:1": ["1k"] },
      resolutions: ["1k", "2k", "4k"],
      references: { image: 14, video: 0, audio: 0, total: 14 },
      maxImages: 4,
      autoFallback: "1:1",
      seed: false,
      promptExpansion: false,
    },
    price: perImage({ "1k": 0.02, "2k": 0.02, "4k": 0.025 }),
  }),
  image({
    id: "gpt-image-2.5-sunburst",
    family: "GPT Image",
    name: "GPT Image 2.5 Sunburst",
    mark: "✺",
    description: "OpenAI's image model for precise generation and editing.",
    group: "image",
    task: "image",
    tasks: ["image", "image-edit"],
    routes: [
      { provider: "argolink", endpoint: "gpt-image-2.5-sunburst", mapper: "argolink.image.openai" },
      { provider: "openrouter", endpoint: "openai/gpt-image-2.5-sunburst", mapper: "openrouter.image" },
    ],
    promptRequired: true,
    refSyntax: "plain",
    capabilities: {
      ratios: ["auto", "1:1", "3:4", "4:3", "2:3", "3:2", "9:16", "16:9", "21:9", "5:2"],
      resolutions: ["1k", "2k", "4k"],
      qualities: ["auto", "low", "medium", "high"],
      references: { image: 16, video: 0, audio: 0, total: 16 },
      maxImages: 4,
      seed: false,
      promptExpansion: false,
    },
    price: perImage({ "1k": 0.015, "2k": 0.015, "4k": 0.02 }),
  }),
];
