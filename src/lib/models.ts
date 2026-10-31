// Seedance model catalog. Shared by the UI (to render controls) and the API
// (to validate requests). Each entry belongs to one provider; only the active
// provider's models are offered. Add or edit entries as new versions ship.

export type ProviderId = "modelark" | "argolink" | "openrouter";

/** Client-safe provider metadata. */
export const PROVIDER_INFO: Record<ProviderId, { label: string; keyUrl: string; blurb: string }> = {
  argolink: {
    label: "ArgoLink",
    keyUrl: "https://argolink.io",
    blurb: "Prepaid gateway with Seedance 2.5, 2.0, Fast and Mini.",
  },
  openrouter: {
    label: "OpenRouter",
    keyUrl: "https://openrouter.ai/settings/keys",
    blurb: "One key for Seedance 2.5, 2.0, Fast, Mini and 1.5 Pro, plus the image models.",
  },
  modelark: {
    label: "BytePlus ModelArk",
    keyUrl: "https://console.byteplus.com/ark",
    blurb: "ByteDance's official API. Seed, watermark and last-frame chaining.",
  },
};

export const MODELARK_REGIONS = {
  "https://ark.ap-southeast.bytepluses.com/api/v3": "International (BytePlus)",
  "https://ark.cn-beijing.volces.com/api/v3": "China (Volcengine)",
} as const;
export type Ratio = "16:9" | "4:3" | "1:1" | "3:4" | "9:16" | "21:9" | "adaptive";
export type Resolution = "480p" | "720p" | "1080p" | "4k";

export interface ModelSpec {
  id: string;
  provider: ProviderId;
  label: string;
  description: string;
  ratios: Ratio[];
  resolutions: Resolution[];
  durations: { min: number; max: number; default: number };
  /** Native audio track generation (`generate_audio`). */
  audio: boolean;
  /** Supports first-frame image-to-video. */
  firstFrame: boolean;
  /** Supports first + last frame interpolation. */
  lastFrame: boolean;
  /** Max reference inputs for "references" mode; 0 disables that input. */
  references: { images: number; videos: number; audios: number; total: number };
  /** Optional request params the provider accepts. */
  features: { seed: boolean; watermark: boolean; cameraFixed: boolean; lastFrameOutput: boolean };
  /** How prompts refer to reference inputs, e.g. "@Image 1". */
  refSyntax: (kind: "Image" | "Video" | "Audio", n: number) => string;
  promptRequired: boolean;
  /** USD per output second, for the cost estimate. Omit if unknown. */
  pricePerSecond?: Partial<Record<Resolution, number>>;
}

const ALL_RATIOS: Ratio[] = ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"];

const modelark = {
  provider: "modelark",
  features: { seed: true, watermark: true, cameraFixed: true, lastFrameOutput: true },
  refSyntax: (kind, n) => `[${kind} ${n}]`,
  promptRequired: false,
} satisfies Partial<ModelSpec>;

// https://argolink.io/en/models/<id> — prices are the no-video-input rate.
const argolink = {
  provider: "argolink",
  ratios: ALL_RATIOS,
  audio: true,
  firstFrame: true,
  lastFrame: true,
  features: { seed: false, watermark: false, cameraFixed: false, lastFrameOutput: false },
  refSyntax: (kind, n) => `@${kind} ${n}`,
  promptRequired: true,
} satisfies Partial<ModelSpec>;

// https://openrouter.ai/api/v1/videos/models — BytePlus Seedance behind OpenRouter. Prices are
// its per-token rates at 24 fps and 16:9 (tokens = width × height × fps × seconds / 1024).
const openrouter = {
  provider: "openrouter",
  ratios: ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"],
  audio: true,
  firstFrame: true,
  lastFrame: true,
  features: { seed: true, watermark: false, cameraFixed: false, lastFrameOutput: false },
  refSyntax: (kind, n) => `[${kind} ${n}]`,
  promptRequired: false,
} satisfies Partial<ModelSpec>;

export const MODELS: ModelSpec[] = [
  {
    ...modelark,
    id: "dreamina-seedance-2-0-260128",
    label: "Seedance 2.0",
    description: "Multimodal references, native audio, up to 15s",
    ratios: ALL_RATIOS,
    resolutions: ["480p", "720p", "1080p"],
    durations: { min: 4, max: 15, default: 5 },
    audio: true,
    firstFrame: true,
    lastFrame: true,
    references: { images: 9, videos: 3, audios: 3, total: 15 },
  },
  {
    ...modelark,
    id: "seedance-1-0-pro-250528",
    label: "Seedance 1.0 Pro",
    description: "Text & image to video, 1080p",
    ratios: ALL_RATIOS,
    resolutions: ["480p", "720p", "1080p"],
    durations: { min: 2, max: 12, default: 5 },
    audio: false,
    firstFrame: true,
    lastFrame: false,
    references: { images: 0, videos: 0, audios: 0, total: 0 },
  },
  {
    ...argolink,
    id: "seedance-2.5",
    label: "Seedance 2.5",
    description: "Newest model, up to 30s, 30 reference images",
    resolutions: ["480p", "720p", "1080p"],
    durations: { min: 4, max: 30, default: 5 },
    references: { images: 30, videos: 10, audios: 10, total: 50 },
    pricePerSecond: { "480p": 0.0874, "720p": 0.196, "1080p": 0.483 },
  },
  {
    ...argolink,
    id: "seedance-2.0",
    label: "Seedance 2.0",
    description: "Multimodal references, native audio, up to 4K",
    resolutions: ["480p", "720p", "1080p", "4k"],
    durations: { min: 4, max: 15, default: 5 },
    references: { images: 9, videos: 3, audios: 3, total: 15 },
    pricePerSecond: { "480p": 0.0598, "720p": 0.129, "1080p": 0.318, "4k": 0.661 },
  },
  {
    ...argolink,
    id: "seedance-2.0-fast",
    label: "Seedance 2.0 Fast",
    description: "Faster, cheaper 2.0 — up to 720p",
    resolutions: ["480p", "720p"],
    durations: { min: 4, max: 15, default: 5 },
    references: { images: 9, videos: 3, audios: 3, total: 15 },
    pricePerSecond: { "480p": 0.0478, "720p": 0.103 },
  },
  {
    ...argolink,
    id: "seedance-2.0-mini",
    label: "Seedance 2.0 Mini",
    description: "Cheapest drafts — up to 720p",
    resolutions: ["480p", "720p"],
    durations: { min: 4, max: 15, default: 5 },
    references: { images: 9, videos: 3, audios: 3, total: 15 },
    pricePerSecond: { "480p": 0.0299, "720p": 0.0643 },
  },
  {
    ...openrouter,
    id: "bytedance/seedance-2.5",
    label: "Seedance 2.5",
    description: "Newest model, up to 30s, 30 reference images",
    resolutions: ["480p", "720p"],
    durations: { min: 4, max: 30, default: 5 },
    references: { images: 30, videos: 10, audios: 10, total: 50 },
    pricePerSecond: { "480p": 0.1028, "720p": 0.2311 },
  },
  {
    ...openrouter,
    id: "bytedance/seedance-2.0",
    label: "Seedance 2.0",
    description: "Multimodal references, native audio, up to 4K",
    resolutions: ["480p", "720p", "1080p", "4k"],
    durations: { min: 4, max: 15, default: 5 },
    references: { images: 9, videos: 3, audios: 3, total: 15 },
    pricePerSecond: { "480p": 0.0673, "720p": 0.1512, "1080p": 0.3742, "4k": 0.7776 },
  },
  {
    ...openrouter,
    id: "bytedance/seedance-2.0-fast",
    label: "Seedance 2.0 Fast",
    description: "Faster, cheaper 2.0 — up to 720p",
    resolutions: ["480p", "720p"],
    durations: { min: 4, max: 15, default: 5 },
    references: { images: 9, videos: 3, audios: 3, total: 15 },
    pricePerSecond: { "480p": 0.0404, "720p": 0.0907 },
  },
  {
    ...openrouter,
    id: "bytedance/seedance-2.0-mini",
    label: "Seedance 2.0 Mini",
    description: "Cheapest drafts — up to 720p",
    resolutions: ["480p", "720p"],
    durations: { min: 4, max: 15, default: 5 },
    references: { images: 9, videos: 3, audios: 3, total: 15 },
    pricePerSecond: { "480p": 0.0336, "720p": 0.0756 },
  },
  {
    ...openrouter,
    id: "bytedance/seedance-1-5-pro",
    label: "Seedance 1.5 Pro",
    description: "Text & image to video with audio, 1080p",
    resolutions: ["480p", "720p", "1080p"],
    durations: { min: 4, max: 12, default: 5 },
    references: { images: 0, videos: 0, audios: 0, total: 0 },
    pricePerSecond: { "480p": 0.0231, "720p": 0.0518, "1080p": 0.1166 },
  },
];

export function getModel(id: string): ModelSpec | undefined {
  return MODELS.find((m) => m.id === id);
}

export function modelsFor(provider: ProviderId) {
  return MODELS.filter((m) => m.provider === provider);
}

export function estimateCost(model: ModelSpec, resolution: Resolution, duration: number) {
  const rate = model.pricePerSecond?.[resolution];
  return rate === undefined ? undefined : rate * duration;
}
