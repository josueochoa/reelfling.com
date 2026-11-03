// Parameter forms for catalog tools. A new tool is one of these plus a catalog entry.
// Server-only: client components get the slim field list from /api/models.

import { ProviderError } from "../providers/types";
import type { ToolAccepts, ToolFieldView, ToolQuote } from "../toolTypes";

export interface ToolLimits {
  /** Inclusive. A longer asset is rejected before submit. */
  maxSeconds?: number;
  /** Allowed MIME types. Anything else is rejected. */
  contentTypes?: readonly string[];
  /** Named in the error, for example "PNG". */
  contentTypeLabel?: string;
  /** Inclusive cap on the fal `upscale_factor` this endpoint accepts. */
  maxFactor?: number;
}

export interface ToolForm {
  /** Catalog model id (`fal:owner/name`). */
  id: string;
  /** Must match the catalog capability. */
  accepts: ToolAccepts;
  /** Fal body field that receives the signed URL of the input asset. */
  inputKey: string;
  fields: ToolFieldView[];
  /** Tools that share a menu name collapse into one Tools item. */
  menu?: string;
  /**
   * Rewrites the `target` field into fal body fields. `target` itself is not sent.
   * Keys are the enum options (`2x`, `4x`, `1080p`, `4K`).
   */
  targets?: Readonly<Record<string, Readonly<Record<string, string | number>>>>;
  limits?: ToolLimits;
  /** Published price. Absent when there is no formula we can compute. */
  quote?: ToolQuote;
}

/**
 * BiRefNet v2, checked against fal's live catalog (GET /v1/models?endpoint_id=fal-ai/birefnet/v2,
 * Nov 2026). `image_url` is the only required input. `sync_mode` is left off: a data URI
 * would not be a file the sweep can copy. `output_mask` and `mask_only` stay off so the
 * job saves the cut-out image.
 */
const TOPAZ_VIDEO_MODELS = [
  "Proteus",
  "Proteus Natural",
  "Iris",
  "Iris Low Quality",
  "Dione DV",
  "Dione TV",
  "Dione Robust",
  "Dione Dehalo",
  "Dione Robust Dehalo",
  "Artemis High Quality",
  "Artemis Medium Quality",
  "Artemis Low Quality",
  "Artemis Strong Halo",
  "Artemis Medium Halo",
  "Artemis Aliasing & Moire",
  "Gaia HQ",
  "Gaia CG",
  "Gaia 2",
  "Rhea",
  "Theia Fine Tune Detail",
  "Theia Fine Tune Fidelity",
];

const TOPAZ_IMAGE_MODELS = [
  "Standard V2",
  "High Fidelity V3",
  "High Fidelity V2",
  "Low Resolution V2",
  "CGI",
  "Text Refine",
  "Faces",
];

const SCALE_2_4 = { "2x": { upscale_factor: 2 }, "4x": { upscale_factor: 4 } } as const;

/** SeedVR `upscale_mode`. 4K is the API's `2160p`. */
const SEEDVR_TARGETS = {
  "2x": { upscale_mode: "factor", upscale_factor: 2 },
  "4x": { upscale_mode: "factor", upscale_factor: 4 },
  "1080p": { upscale_mode: "target", target_resolution: "1080p" },
  "4K": { upscale_mode: "target", target_resolution: "2160p" },
} as const;

const TARGET_FIELD = {
  name: "target",
  label: "Target",
  type: "enum" as const,
  default: "2x",
};

/**
 * Upscale forms checked against fal's live catalog on Nov 3, 2026
 * (`GET /v1/models?endpoint_id=…&expand=openapi-3.0`, no key) and each model's
 * public llms.txt. `sync_mode` stays off so the result is a file the sweep can copy.
 * Rates are the published ones. Topaz video has none: its page calls the
 * per-10-second amounts rounded examples, and they don't match its own 1-minute
 * figures. `GET /v1/models/pricing` returns 401 without a key.
 */
const UPSCALE_FORMS: readonly ToolForm[] = [
  {
    id: "fal:fal-ai/seedvr/upscale/video",
    accepts: "video",
    inputKey: "video_url",
    menu: "Upscale",
    quote: { type: "output_megapixels", usd: 0.001, frames: true },
    limits: { maxFactor: 10 },
    targets: SEEDVR_TARGETS,
    fields: [{ ...TARGET_FIELD, options: ["2x", "4x", "1080p", "4K"] }],
  },
  {
    id: "fal:topaz/upscale/video/precision",
    accepts: "video",
    inputKey: "video_url",
    menu: "Upscale",
    limits: { maxSeconds: 300, maxFactor: 4 },
    targets: SCALE_2_4,
    fields: [
      { name: "model", label: "Precision model", type: "enum", default: "Proteus", options: TOPAZ_VIDEO_MODELS },
      { ...TARGET_FIELD, options: ["2x", "4x"] },
    ],
  },
  {
    id: "fal:fal-ai/flashvsr/upscale/video",
    accepts: "video",
    inputKey: "video_url",
    menu: "Upscale",
    quote: { type: "output_megapixels", usd: 0.0005, frames: true },
    limits: { maxFactor: 4 },
    targets: SCALE_2_4,
    fields: [{ ...TARGET_FIELD, options: ["2x", "4x"] }],
  },
  {
    id: "fal:fal-ai/seedvr/upscale/image",
    accepts: "image",
    inputKey: "image_url",
    menu: "Upscale",
    quote: { type: "output_megapixels", usd: 0.001 },
    limits: { maxFactor: 10 },
    targets: SEEDVR_TARGETS,
    fields: [{ ...TARGET_FIELD, options: ["2x", "4x", "1080p", "4K"] }],
  },
  {
    id: "fal:topaz/upscale/image/precision",
    accepts: "image",
    inputKey: "image_url",
    menu: "Upscale",
    quote: { type: "output_megapixel_block", usd: 0.08, block: 24 },
    limits: { maxFactor: 4 },
    targets: SCALE_2_4,
    fields: [
      { name: "model", label: "Precision model", type: "enum", default: "Standard V2", options: TOPAZ_IMAGE_MODELS },
      { ...TARGET_FIELD, options: ["2x", "4x"] },
    ],
  },
  {
    id: "fal:fal-ai/recraft/upscale/crisp",
    accepts: "image",
    inputKey: "image_url",
    menu: "Upscale",
    quote: { type: "per_image", usd: 0.004 },
    limits: { contentTypes: ["image/png"], contentTypeLabel: "PNG" },
    fields: [],
  },
];

export const TOOL_FORMS: readonly ToolForm[] = [
  {
    id: "fal:fal-ai/birefnet/v2",
    accepts: "image",
    inputKey: "image_url",
    fields: [
      {
        name: "model",
        label: "Model",
        type: "enum",
        default: "General Use (Light)",
        options: [
          "General Use (Light)",
          "General Use (Light 2K)",
          "General Use (Heavy)",
          "Matting",
          "Portrait",
          "General Use (Dynamic)",
        ],
      },
      {
        name: "output_format",
        label: "Format",
        type: "enum",
        default: "png",
        options: ["png", "webp", "gif"],
      },
      {
        name: "refine_foreground",
        label: "Refine foreground",
        type: "boolean",
        default: true,
      },
    ],
  },
  ...UPSCALE_FORMS,
];

export function formFor(id: string): ToolForm | undefined {
  return TOOL_FORMS.find((form) => form.id === id);
}

/** Resolved settings, defaults filled in. Unknown keys and illegal values are rejected. */
export function parseToolParams(form: ToolForm, raw: unknown): Record<string, string | number | boolean> {
  if (raw == null) raw = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new ProviderError("Tool settings must be an object", 400);
  const input = raw as Record<string, unknown>;
  const known = new Set(form.fields.map((field) => field.name));
  for (const key of Object.keys(input)) {
    if (!known.has(key) || key === form.inputKey)
      throw new ProviderError(`Unknown tool setting "${key}"`, 400);
  }
  const out: Record<string, string | number | boolean> = {};
  for (const field of form.fields) {
    if (field.name === form.inputKey) throw new ProviderError("Tool form collides with its input", 500);
    const value = input[field.name];
    if (value === undefined) {
      if (field.default !== undefined) out[field.name] = field.default;
      continue;
    }
    if (field.type === "boolean") {
      if (typeof value !== "boolean") throw new ProviderError(`${field.label} must be on or off`, 400);
      out[field.name] = value;
      continue;
    }
    if (field.type === "enum") {
      if (typeof value !== "string" || !field.options.includes(value))
        throw new ProviderError(`${field.label} isn't one of the listed choices`, 400);
      out[field.name] = value;
      continue;
    }
    if (field.type === "number") {
      if (typeof value !== "number" || !Number.isFinite(value))
        throw new ProviderError(`${field.label} must be a number`, 400);
      if (field.min !== undefined && value < field.min)
        throw new ProviderError(`${field.label} is below ${field.min}`, 400);
      if (field.max !== undefined && value > field.max)
        throw new ProviderError(`${field.label} is above ${field.max}`, 400);
      out[field.name] = value;
      continue;
    }
    if (typeof value !== "string") throw new ProviderError(`${field.label} must be text`, 400);
    out[field.name] = value;
  }
  return out;
}

function applyTargets(
  form: ToolForm,
  params: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
  if (!form.targets) return params;
  const target = params.target;
  const mapped = typeof target === "string" ? form.targets[target] : undefined;
  if (!mapped) throw new ProviderError("Target isn't one of the listed choices", 400);
  const next = { ...params };
  delete next.target;
  return { ...next, ...mapped };
}

/** Fal JSON for one asset. The input URL is a `upload:<key>` ref until the job resolves it. */
export function buildToolBody(form: ToolForm, params: unknown, assetRef: string): Record<string, unknown> {
  const parsed = applyTargets(form, parseToolParams(form, params));
  const factor = parsed.upscale_factor;
  if (typeof factor === "number" && form.limits?.maxFactor !== undefined && factor > form.limits.maxFactor)
    throw new ProviderError(`Upscale factor ${factor} is above the ${form.limits.maxFactor}× limit`, 400);
  return { ...parsed, [form.inputKey]: assetRef };
}

/** Why this asset can't be sent, naming the limit. Undefined when it can. */
export function toolLimitError(
  form: ToolForm,
  asset: { contentType: string; duration?: number },
  name: string,
): string | undefined {
  const limits = form.limits;
  if (!limits) return undefined;
  if (limits.contentTypes && !limits.contentTypes.includes(asset.contentType)) {
    const label = limits.contentTypeLabel ?? limits.contentTypes.join(" or ");
    return `This file is ${asset.contentType}. ${name}'s limit is ${label}.`;
  }
  if (
    limits.maxSeconds !== undefined &&
    asset.duration !== undefined &&
    Number.isFinite(asset.duration) &&
    asset.duration > limits.maxSeconds
  ) {
    const cap = limits.maxSeconds % 60 === 0 ? `${limits.maxSeconds / 60} minutes` : `${limits.maxSeconds}s`;
    const shown = Number.isInteger(asset.duration) ? String(asset.duration) : asset.duration.toFixed(1);
    return `This video is ${shown}s. ${name}'s limit is ${cap}.`;
  }
  return undefined;
}

/** Columns written on the new asset. Absent when the job was not a tool run. */
export function outputLineage(job: { tool?: { id: string; inputAssetIds: string[] } }): {
  parentId: string | null;
  tool: string | null;
} {
  const parentId = job.tool?.inputAssetIds[0];
  const tool = job.tool?.id;
  if (!parentId || !tool) return { parentId: null, tool: null };
  return { parentId, tool };
}
