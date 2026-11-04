// Parameter forms for catalog tools. A new tool is one of these plus a catalog entry.
// Server-only: client components get the slim field list from /api/models.

import { ProviderError } from "../providers/types";
import type { ToolAccepts, ToolFieldView } from "../toolTypes";

export interface ToolForm {
  /** Catalog model id (`fal:owner/name`). */
  id: string;
  /** Must match the catalog capability. */
  accepts: ToolAccepts;
  /** Fal body field that receives the signed URL of the input asset. */
  inputKey: string;
  fields: ToolFieldView[];
}

/**
 * BiRefNet v2, checked against fal's live catalog (GET /v1/models?endpoint_id=fal-ai/birefnet/v2,
 * Nov 2026). `image_url` is the only required input. `sync_mode` is left off: a data URI
 * would not be a file the sweep can copy. `output_mask` and `mask_only` stay off so the
 * job saves the cut-out image.
 */
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

/** Fal JSON for one asset. The input URL is a `upload:<key>` ref until the job resolves it. */
export function buildToolBody(form: ToolForm, params: unknown, assetRef: string): Record<string, unknown> {
  return { ...parseToolParams(form, params), [form.inputKey]: assetRef };
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
