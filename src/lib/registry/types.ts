// One catalog for every model the app can offer. Hand-written ModelArk and ArgoLink
// entries live in hand.ts; fal and OpenRouter entries are generated (see catalog/).
// OpenRouter is a route provider only — there is no OpenRouter client in this app.

export const ROUTE_PROVIDERS = ["modelark", "argolink", "fal", "openrouter"] as const;
export type RouteProvider = (typeof ROUTE_PROVIDERS)[number];

/** Providers a user can save a key for. OpenRouter is intentionally not one of them. */
export type ProviderId = "modelark" | "argolink" | "fal";

/** Video studio providers. fal is a generic queue client, not a studio catalog. */
export type StudioProviderId = Exclude<ProviderId, "fal">;

export function isStudioProvider(id: string): id is StudioProviderId {
  return id === "modelark" || id === "argolink";
}

export const PROVIDER_INFO: Record<ProviderId, { label: string; keyUrl: string; blurb: string }> = {
  argolink: {
    label: "ArgoLink",
    keyUrl: "https://argolink.io",
    blurb: "Prepaid gateway with Seedance 2.5, 2.0, Fast and Mini.",
  },
  modelark: {
    label: "BytePlus ModelArk",
    keyUrl: "https://console.byteplus.com/ark",
    blurb: "ByteDance's official API. Seed, watermark and last-frame chaining.",
  },
  fal: {
    label: "fal",
    keyUrl: "https://fal.ai/dashboard/keys",
    blurb: "Any fal endpoint. Paste an endpoint id and a JSON input.",
  },
};

export const MODELARK_REGIONS = {
  "https://ark.ap-southeast.bytepluses.com/api/v3": "International (BytePlus)",
  "https://ark.cn-beijing.volces.com/api/v3": "China (Volcengine)",
} as const;

export const VIDEO_TASKS = [
  "t2v",
  "i2v",
  "ref2v",
  "v2v-edit",
  "extend",
  "upscale",
  "lipsync",
  "avatar",
  "motion",
] as const;
export const IMAGE_TASKS = ["image", "image-edit"] as const;
export const SPEECH_TASKS = ["tts"] as const;
export const TOOL_TASKS = ["tool"] as const;

export type VideoTask = (typeof VIDEO_TASKS)[number];
export type ImageTask = (typeof IMAGE_TASKS)[number];
export type SpeechTask = (typeof SPEECH_TASKS)[number];
export type ToolTask = (typeof TOOL_TASKS)[number];
export type TaskKind = VideoTask | ImageTask | SpeechTask | ToolTask;

export const MAPPER_IDS = [
  "modelark.video",
  "argolink.video",
  "argolink.image.google",
  "argolink.image.openai",
  "fal.queue",
  "openrouter.video",
] as const;
export type MapperId = (typeof MAPPER_IDS)[number];

export interface Route {
  provider: RouteProvider;
  /** Provider model id or fal endpoint id. */
  endpoint: string;
  mapper: MapperId;
}

/** How the provider wants @-mentions rewritten. */
export type RefSyntax = "at" | "brackets" | "plain";

export interface RefLimits {
  image: number;
  video: number;
  audio: number;
  total: number;
}

export interface DurationCap {
  min: number;
  max: number;
  default: number;
  /** Set when the legal values are not every integer from min to max. */
  options?: number[];
}

/** false = no expander, native = the model expands prompts itself, optional = the user can toggle it. */
export type PromptExpansion = false | "native" | "optional";

export interface VideoCapabilities {
  durations?: DurationCap;
  resolutions: readonly string[];
  ratios: readonly string[];
  /** Ratios listed here are only legal at these resolutions. */
  ratioResolutions?: Readonly<Record<string, readonly string[]>>;
  audio: false | "optional" | "required";
  frames: { start: boolean; middle: boolean; end: boolean };
  references: RefLimits;
  seed: boolean;
  promptExpansion: PromptExpansion;
  /** Native camera controls. `fixed` is the locked-camera toggle. */
  camera: false | { fixed?: boolean };
  watermark: boolean;
  lastFrameOutput: boolean;
}

export type ImageQuality = "auto" | "low" | "medium" | "high";
export type ImageResolution = "1k" | "2k" | "4k";

export interface ImageCapabilities {
  resolutions: readonly string[];
  ratios: readonly string[];
  ratioResolutions?: Readonly<Record<string, readonly string[]>>;
  references: RefLimits;
  maxImages: number;
  qualities?: readonly ImageQuality[];
  /** Ratio stored when the user picks Auto and there is no reference image. */
  autoFallback?: string;
  seed: boolean;
  promptExpansion: PromptExpansion;
}

export interface SpeechCapabilities {
  seed: boolean;
  promptExpansion: PromptExpansion;
}

export interface ToolCapabilities {
  resolutions?: readonly string[];
}

/** USD. Display-only estimates of what the user's own provider will bill. */
export type PerSecondPrice = {
  type: "per_second";
  /** USD per output second. "*" is the rate when the resolution has no entry. */
  byResolution: Readonly<Record<string, number>>;
  byResolutionWithAudio?: Readonly<Record<string, number>>;
  /** Floor for one generation, when the provider publishes one. */
  minimum?: number;
};

export type PerImagePrice = {
  type: "per_image";
  byResolution?: Readonly<Record<string, number>>;
  usd?: number;
};

export type PerMegapixelPrice = {
  type: "per_megapixel";
  /** USD per megapixel, or per megapixel-second when `perSecond` is set. */
  usd: number;
  perSecond?: boolean;
};

export type TokenPrice = {
  type: "tokens";
  /** USD per token. Resolution entries override it. */
  usdPerToken: number;
  byResolution?: Readonly<Record<string, number>>;
  /**
   * Representative 16:9 output size used to estimate tokens before the provider
   * reports real usage. Tokens ≈ duration × width × height × fps / 1024.
   */
  pixels?: Readonly<Record<string, { width: number; height: number }>>;
  fps?: number;
  tokensPerImage?: Readonly<Record<string, number>> | number;
};

export type VideoPrice = PerSecondPrice | TokenPrice | PerMegapixelPrice;
export type ImagePrice = PerImagePrice | PerMegapixelPrice | TokenPrice;
export type PriceFormula = VideoPrice | ImagePrice;

interface ModelBase {
  id: string;
  family: string;
  /** Display name. */
  name: string;
  description: string;
  /** Primary task. `tasks` lists everything this entry can run. */
  task: TaskKind;
  routes: readonly Route[];
  promptRequired: boolean;
  refSyntax: RefSyntax;
  /** Short picker mark, when the family has one. */
  mark?: string;
}

export interface VideoModel extends ModelBase {
  group: "video";
  task: VideoTask;
  tasks: readonly VideoTask[];
  capabilities: VideoCapabilities;
  price?: VideoPrice;
}

export interface ImageModel extends ModelBase {
  group: "image";
  task: ImageTask;
  tasks: readonly ImageTask[];
  capabilities: ImageCapabilities;
  price?: ImagePrice;
}

export interface SpeechModel extends ModelBase {
  group: "speech";
  task: SpeechTask;
  tasks: readonly SpeechTask[];
  capabilities: SpeechCapabilities;
  price?: TokenPrice | PerSecondPrice;
}

export interface ToolModel extends ModelBase {
  group: "tool";
  task: ToolTask;
  tasks: readonly ToolTask[];
  capabilities: ToolCapabilities;
  price?: PriceFormula;
}

export type ModelEntry = VideoModel | ImageModel | SpeechModel | ToolModel;

export function isVideo(model: ModelEntry): model is VideoModel {
  return model.group === "video";
}

export function isImage(model: ModelEntry): model is ImageModel {
  return model.group === "image";
}

export interface EstimateInput {
  resolution?: string;
  duration?: number;
  audio?: boolean;
  count?: number;
  megapixels?: number;
}
