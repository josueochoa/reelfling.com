// One catalog for every model the app can offer. Hand-written ModelArk and ArgoLink
// entries live in hand.ts; fal and OpenRouter entries are generated (see catalog/).
// The generated JSON is loaded on the server (./generated). The client only sees this
// module plus a slim picker payload from /api/models.

export const ROUTE_PROVIDERS = ["modelark", "argolink", "fal", "openrouter"] as const;
export type RouteProvider = (typeof ROUTE_PROVIDERS)[number];

/** Providers a user can save a key for. */
export type ProviderId = "modelark" | "argolink" | "fal" | "openrouter";

/** Video studio providers. fal is a generic queue client, not a studio catalog. */
export type StudioProviderId = Exclude<ProviderId, "fal">;

/** Providers that can run the Image tab. */
export const IMAGE_KEY_PROVIDERS = ["argolink", "openrouter"] as const;
export type ImageKeyProvider = (typeof IMAGE_KEY_PROVIDERS)[number];

export function isStudioProvider(id: string): id is StudioProviderId {
  return id === "modelark" || id === "argolink" || id === "openrouter";
}

/** Active provider when it can make images, otherwise the first saved image key. */
export function imageProviderFor(
  active: string | null | undefined,
  keys: readonly string[],
): ImageKeyProvider | undefined {
  if ((active === "argolink" || active === "openrouter") && keys.includes(active)) return active;
  return IMAGE_KEY_PROVIDERS.find((provider) => keys.includes(provider));
}

export const PROVIDER_INFO: Record<ProviderId, { label: string; keyUrl: string; blurb: string }> = {
  argolink: {
    label: "ArgoLink",
    keyUrl: "https://argolink.io",
    blurb: "Prepaid gateway with Seedance, Kling 4.0 and Wan 3.0.",
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
  openrouter: {
    label: "OpenRouter",
    keyUrl: "https://openrouter.ai/settings/keys",
    blurb: "Seedance 2.5, Kling 3.0 Pro, Veo 3.1 Fast, and the Image tab.",
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
  "openrouter.image",
] as const;
export type MapperId = (typeof MAPPER_IDS)[number];

export interface Route {
  provider: RouteProvider;
  /** Provider model id or fal endpoint id. */
  endpoint: string;
  mapper: MapperId;
  /** This provider's price, when it differs from the model price. */
  price?: PriceFormula;
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

/** Provider fields a preset's native mapping may fill. Values live in camera-presets.json. */
export const NATIVE_CAMERA_PARAMS = ["camera_fixed"] as const;
export type NativeCameraParam = (typeof NATIVE_CAMERA_PARAMS)[number];

export interface CameraCapabilities {
  /** The model accepts the locked-camera parameter. */
  fixed?: boolean;
  /**
   * Presets without a native value are a prompt instruction.
   * `false` hides that path. Omit it and text, image, and reference tasks still get it.
   */
  prompt?: boolean;
  /** Which verified parameters this model will take from a preset. */
  params?: readonly NativeCameraParam[];
}

export interface VideoCapabilities {
  durations?: DurationCap;
  resolutions: readonly string[];
  ratios: readonly string[];
  /** Ratios listed here are only legal at these resolutions. */
  ratioResolutions?: Readonly<Record<string, readonly string[]>>;
  audio: false | "optional" | "required";
  frames: {
    start: boolean;
    /** The model publishes a middle or keyframe list. */
    middle: boolean;
    end: boolean;
    /** Max images in that list. Absent when `middle` is false. */
    keyframeLimit?: number;
    /** Start and end count toward `keyframeLimit` (one keyframes array). */
    sharedKeyframes?: boolean;
    /** With a start frame the provider only takes the "adaptive" ratio (Kling 4.0 on ArgoLink). */
    adaptiveOnly?: boolean;
  };
  references: RefLimits;
  seed: boolean;
  promptExpansion: PromptExpansion;
  /** Native camera parameter, prompt instructions, or neither. */
  camera: false | CameraCapabilities;
  watermark: boolean;
  lastFrameOutput: boolean;
  /**
   * Edits an existing video (see lib/videoEdit). `images`: reference images allowed
   * alongside it. `seconds`: how long the video to edit may be.
   */
  edit?: { images: number; seconds: { min: number; max: number } };
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
  /** Asset kind this tool reads. Recorded from the provider input schema. */
  accepts?: "image" | "video";
  resolutions?: readonly string[];
}

/** USD. Display-only estimates of what the user's own provider will bill. */
export type PerSecondPrice = {
  type: "per_second";
  /** USD per output second. "*" is the rate when the resolution has no entry. */
  byResolution: Readonly<Record<string, number>>;
  byResolutionWithAudio?: Readonly<Record<string, number>>;
  /**
   * USD per billed second when the request includes any reference video.
   * Every billed second uses this rate, including the output.
   */
  byResolutionWithVideo?: Readonly<Record<string, number>>;
  /**
   * How reference-video seconds change the bill.
   * `argolink`: output + floor(reference seconds), at least ceil(output × 5/3).
   * `add`: output + reference seconds, at this rate (the with-video rate when set).
   * `add-floor`: output + floor(reference seconds), at this rate.
   * `double-min`: output + reference seconds, and at least twice the output, at the with-video rate.
   * Reference images use `referenceImages` when the catalog prices them. Audio does not.
   */
  referenceBilling?: "argolink" | "add" | "add-floor" | "double-min";
  /** Extra USD for reference images past `free`. `perOutput` folds that into each output image. */
  referenceImages?: ReferenceImageFee;
  /** Floor for one generation, when the provider publishes one. */
  minimum?: number;
};

export type ReferenceImageFee = {
  usd: number;
  /** This many reference images are included. */
  free: number;
  /** When set, the extra is added to each output image instead of once per request. */
  perOutput?: boolean;
};

export type PerImagePrice = {
  type: "per_image";
  byResolution?: Readonly<Record<string, number>>;
  byQuality?: Readonly<Record<string, number>>;
  /** `${resolution}/${quality}` when both change the rate. */
  byResolutionQuality?: Readonly<Record<string, number>>;
  usd?: number;
  referenceImages?: ReferenceImageFee;
};

export type PerMegapixelPrice = {
  type: "per_megapixel";
  /** USD per megapixel, or per extra megapixel when `first` is set. */
  usd: number;
  /** USD for the first megapixel. Later megapixels cost `usd`, rounded up. */
  first?: number;
  perSecond?: boolean;
};

export type TokenPrice = {
  type: "tokens";
  /** USD per token. Resolution entries override it. */
  usdPerToken: number;
  byResolution?: Readonly<Record<string, number>>;
  /** USD per token when the request includes any reference video. */
  usdPerTokenWithVideo?: number;
  byResolutionWithVideo?: Readonly<Record<string, number>>;
  /**
   * Representative 16:9 output size used to estimate tokens before the provider
   * reports real usage. Tokens ≈ (output seconds + reference-video seconds) × width × height × fps / 1024.
   * Reference images and audio are not added.
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
  /**
   * fal queue field names for this model's published input. Absent on routes whose
   * body is still the Seedance shape (`image_url`, `image_urls`, `video_urls`).
   */
  inputs?: FalInputMap;
}

/** Which fal fields a model's queue schema accepts. Built from the live OpenAPI document. */
export interface FalInputMap {
  start?: "image_url" | "start_image_url";
  end?: "end_image_url";
  /** Ordered images between start and end. Only when the schema publishes this array. */
  middle?: "middle_image_urls";
  /** One keyframe list instead of start/end fields. */
  keyframes?: "keyframes";
  /** Positions companion for a string-array `keyframes` field (Luma). */
  keyframeIndexes?: "keyframe_indexes";
  /** `objects` is `{ image_url, frame_index }[]`. `urls` is a string array. */
  keyframeShape?: "objects" | "urls";
  /** Published max length of `middle` or `keyframes`. */
  frameLimit?: number;
  images?: "image_urls" | "reference_image_urls";
  videos?: "video_urls" | "reference_video_urls";
  audios?: "audio_urls" | "reference_audio_urls";
  /** @Image and @Video become element objects. Used when the schema has no url arrays. */
  elements?: "elements";
  duration?: "number" | "string" | "suffix";
  audio?: "generate_audio" | "audio";
  aspect?: "aspect_ratio" | "image_size";
  /** Legal aspect_ratio values. Adaptive is rewritten when it is not in this list. */
  aspects?: readonly string[];
  resolution?: "resolution";
  quality?: "quality";
  count?: "num_images";
  seed?: boolean;
  /** image_size values keyed by the composer's resolution (1k, 2k). */
  imageSizeByResolution?: Readonly<Record<string, string>>;
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
  /**
   * Total reference-video seconds. Omit when the request has no reference video.
   * `0` still selects the with-video rate (a clip under a second, or a finished
   * job whose billed seconds already include the reference).
   * Reference images and audio are not part of this input.
   */
  referenceVideoSeconds?: number;
  /** Reference images attached to the request. Priced only when the formula says so. */
  referenceImages?: number;
  /** Image quality, when the formula has a per-quality rate. */
  quality?: string;
  /**
   * `duration` is the provider's billed seconds (output plus reference video,
   * minimum already applied). Use the with-video rate and do not add reference
   * seconds or the output minimum again.
   */
  durationIsBilled?: boolean;
}
