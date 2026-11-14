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
  params: ["camera_fixed"],
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

// Wan 3.0 and 3.0 Prime: reference videos and audio clips are 1–15 s each and 15 s per
// kind together, and the output plus the reference videos may not pass 30 s.
// https://argolink.io/en/models/wan-3, https://argolink.io/en/models/wan-3-prime
const WAN_REFERENCES = {
  image: 10,
  video: 5,
  audio: 5,
  total: 20,
  clipSeconds: { video: { min: 1, max: 15, total: 15 }, audio: { min: 1, max: 15, total: 15 } },
  outputPlusVideoSeconds: 30,
} as const;

function video(model: VideoModel & { price: NonNullable<VideoModel["price"]> }): VideoModel {
  return model;
}

function image(model: ImageModel & { price: NonNullable<ImageModel["price"]> }): ImageModel {
  return model;
}

/** One price per resolution the route offers. GPT Image 2.6 has no 4K, for example. */
const perImage = (price: Partial<Record<ImageResolution, number>>) => ({ type: "per_image" as const, byResolution: price });

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
      edit: { images: 30, seconds: { min: 4, max: 30 } },
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
  video({
    id: "kling-4.0",
    family: "Kling",
    name: "Kling 4.0",
    description: "Up to 30s with audio, 10 reference images and 5 videos, video editing",
    group: "video",
    task: "t2v",
    tasks: ["t2v", "i2v", "ref2v"],
    routes: [{ provider: "argolink", endpoint: "kling-4.0", mapper: "argolink.video" }],
    promptRequired: true,
    refSyntax: "at",
    capabilities: {
      ...argolinkCaps,
      // "adaptive" is the only ratio ArgoLink takes with a start frame.
      ratios: ["16:9", "9:16", "1:1", "21:9", "adaptive"],
      frames: { start: true, middle: false, end: true, adaptiveOnly: true },
      resolutions: ["720p", "1080p"],
      durations: { min: 3, max: 30, default: 5 },
      // No reference audio: ArgoLink answers 400. Reference videos: 3–30 s each, 30 s together.
      references: { image: 10, video: 5, audio: 0, total: 15, clipSeconds: { video: { min: 3, max: 30, total: 30 } } },
      edit: { images: 10, seconds: { min: 3, max: 30 } },
    },
    // https://argolink.io/en/models/kling-4.0 — with-video rates are the lower tier.
    // That page gives two rules for a reference video: at least twice the output, and
    // at least 5/3 of it. This estimate uses the larger one.
    price: {
      type: "per_second",
      byResolution: { "720p": 0.1413, "1080p": 0.2115 },
      byResolutionWithVideo: { "720p": 0.0848, "1080p": 0.127 },
      referenceBilling: "double-min",
    },
  }),
  video({
    id: "wan-3",
    family: "Wan",
    name: "Wan 3.0",
    description: "Up to 30s with audio, frames, image, video and audio references, video editing",
    group: "video",
    task: "t2v",
    tasks: ["t2v", "i2v", "ref2v"],
    routes: [{ provider: "argolink", endpoint: "wan-3", mapper: "argolink.video" }],
    promptRequired: true,
    refSyntax: "at",
    capabilities: {
      ...argolinkCaps,
      seed: true,
      resolutions: ["480p", "720p", "1080p"],
      durations: { min: 2, max: 30, default: 5 },
      references: WAN_REFERENCES,
      edit: { images: 10, seconds: { min: 1, max: 15 } },
    },
    // https://argolink.io/en/models/wan-3 — one rate with or without a reference video.
    // Billed seconds are the output plus the reference videos, fractions dropped.
    price: {
      type: "per_second",
      byResolution: { "480p": 0.0325, "720p": 0.065, "1080p": 0.13 },
      referenceBilling: "add-floor",
    },
  }),
  video({
    id: "wan-3-prime",
    family: "Wan",
    name: "Wan 3.0 Prime",
    description: "The fast lane of Wan 3.0: text and references, always with audio",
    group: "video",
    task: "t2v",
    tasks: ["t2v", "ref2v"],
    routes: [{ provider: "argolink", endpoint: "wan-3-prime", mapper: "argolink.video" }],
    promptRequired: true,
    refSyntax: "at",
    capabilities: {
      ...argolinkCaps,
      // ArgoLink answers 400 to start_image, end_image and generate_audio: false.
      ratios: ["16:9", "1:1", "9:16"],
      audio: "required",
      frames: { start: false, middle: false, end: false },
      resolutions: ["480p", "720p", "1080p"],
      durations: { min: 4, max: 30, default: 5 },
      references: WAN_REFERENCES,
    },
    // https://argolink.io/en/models/wan-3-prime — billed like Wan 3.0.
    price: {
      type: "per_second",
      byResolution: { "480p": 0.051, "720p": 0.11, "1080p": 0.21 },
      referenceBilling: "add-floor",
    },
  }),
  video({
    id: "gemini-omni-1.2-flash",
    family: "Gemini",
    name: "Gemini Omni 1.2 Flash",
    description: "Google's video model: up to 15s and 4K with audio, 10 reference images and 3 videos, video editing",
    group: "video",
    task: "t2v",
    tasks: ["t2v", "i2v", "ref2v"],
    routes: [{ provider: "argolink", endpoint: "gemini-omni-1.2-flash", mapper: "argolink.video" }],
    promptRequired: true,
    refSyntax: "at",
    capabilities: {
      ...argolinkCaps,
      ratios: ["16:9", "9:16", "adaptive"],
      resolutions: ["720p", "1080p", "4k"],
      durations: { min: 3, max: 15, default: 5 },
      // No reference audio and no seed: ArgoLink answers 400 to both.
      references: { image: 10, video: 3, audio: 0, total: 13 },
      // An edit takes the video alone: reference images are not accepted with it.
      edit: { images: 0, seconds: { min: 3, max: 15 } },
    },
    // https://argolink.io/en/models/gemini-omni-1.2-flash — one rate with or without a
    // reference video. Billed seconds are the output plus the reference videos, fractions dropped.
    price: {
      type: "per_second",
      byResolution: { "720p": 0.0455, "1080p": 0.0676, "4k": 0.13585 },
      referenceBilling: "add-floor",
    },
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
      { provider: "argolink", endpoint: "nano-banana-2.1", mapper: "argolink.image.google", price: perImage({ "1k": 0.02, "2k": 0.02, "4k": 0.025 }) },
      {
        // Live OpenRouter endpoint: $0.00003 per output-image token.
        // Counts per resolution are the existing estimate (~1120 / 1680 / 2520).
        provider: "openrouter",
        endpoint: "google/gemini-nano-banana-2.1",
        mapper: "openrouter.image",
        price: perImage({ "1k": 0.034, "2k": 0.05, "4k": 0.076 }),
      },
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
    // https://argolink.io/en/models/gpt-image-2.6-sunburst — 1K and 2K only; there is no 4K tier.
    id: "gpt-image-2.6-sunburst",
    family: "GPT Image",
    name: "GPT Image 2.6 Sunburst",
    mark: "✺",
    description: "OpenAI's newest image model, with more consistent edits.",
    group: "image",
    task: "image",
    tasks: ["image", "image-edit"],
    routes: [
      { provider: "argolink", endpoint: "gpt-image-2.6-sunburst", mapper: "argolink.image.openai", price: perImage({ "1k": 0.015, "2k": 0.015 }) },
      {
        provider: "openrouter",
        endpoint: "openai/gpt-image-2.6-sunburst",
        mapper: "openrouter.image",
        price: perImage({ "1k": 0.04, "2k": 0.08 }),
      },
    ],
    promptRequired: true,
    refSyntax: "plain",
    capabilities: {
      ratios: ["auto", "1:1", "3:4", "4:3", "2:3", "3:2", "9:16", "16:9", "21:9", "5:2"],
      resolutions: ["1k", "2k"],
      qualities: ["auto", "low", "medium", "high"],
      references: { image: 16, video: 0, audio: 0, total: 16 },
      maxImages: 4,
      seed: false,
      promptExpansion: false,
    },
    price: perImage({ "1k": 0.015, "2k": 0.015 }),
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
      { provider: "argolink", endpoint: "gpt-image-2.5-sunburst", mapper: "argolink.image.openai", price: perImage({ "1k": 0.015, "2k": 0.015, "4k": 0.02 }) },
      {
        provider: "openrouter",
        endpoint: "openai/gpt-image-2.5-sunburst",
        mapper: "openrouter.image",
        price: perImage({ "1k": 0.04, "2k": 0.08, "4k": 0.16 }),
      },
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
