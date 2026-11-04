// Native extend, run as a fal tool job so the output keeps parent_id and tool.
// Schemas were read from GET https://api.fal.ai/v1/models?endpoint_id=…&expand=openapi-3.0
// on Nov 4, 2026, with no API key.
//
// Kept (required input is prompt + video_url):
//   xai/grok-imagine-video/extend-video          source MP4, 2–15 s
//   minimax/h3-max/extend-video                  source 1.625–60 s, up to 50 MB
//   blackforestlabs/flux-3/extend-video          source MP4, under 15 s and 50 MB
//   google/gemini-omni-flash/v1.1/extend         source at most 30 s
//
// Dropped:
//   google/gemini-omni/extend-video              catalog 404
//   google/gemini-omni-1.1-flash/extend-video    catalog 404
//   google/gemini-omni-flash/v1.1/extend-video   listed, OpenAPI expansion failed
//   google/gemini-omni-flash/extend-video        listed, OpenAPI expansion failed
//   google/gemini-omni-flash/v1/extend-video     listed, OpenAPI expansion failed
//   fal-ai/gemini-omni-flash/extend-video        listed, OpenAPI expansion failed

import { ProviderError } from "./providers/types";
import { ALL_MODELS, catalogModel } from "./registry/generated";
import { buildToolBody, type ToolForm } from "./registry/tool-forms";
import { isVideo, type VideoModel } from "./registry/types";
import type { ExtendOffer } from "./toolTypes";

interface ExtendSpec {
  id: string;
  /** Generation routes with this prefix offer the tool. The extend endpoint itself does not. */
  match: string;
  /** From the schema's source-length note. A longer asset is rejected before submit. */
  maxSeconds: number;
}

const SPECS: readonly ExtendSpec[] = [
  { id: "fal:xai/grok-imagine-video/extend-video", match: "xai/grok-imagine-video/", maxSeconds: 15 },
  { id: "fal:minimax/h3-max/extend-video", match: "minimax/h3", maxSeconds: 60 },
  { id: "fal:blackforestlabs/flux-3/extend-video", match: "blackforestlabs/flux-3/", maxSeconds: 15 },
  { id: "fal:google/gemini-omni-flash/v1.1/extend", match: "google/gemini-omni-flash/", maxSeconds: 30 },
];

const PROMPT: ToolForm["fields"][number] = {
  name: "prompt",
  label: "What happens next",
  type: "string",
};

function formForSpec(spec: ExtendSpec): ToolForm | undefined {
  const model = catalogModel(spec.id);
  const route = model?.routes.find((item) => item.provider === "fal" && item.mapper === "fal.queue");
  if (!model || model.group !== "tool" || model.capabilities.accepts !== "video" || !route) return undefined;
  if (route.endpoint !== spec.id.slice("fal:".length)) return undefined;
  return {
    id: spec.id,
    accepts: "video",
    inputKey: "video_url",
    fields: [PROMPT],
    limits: { maxSeconds: spec.maxSeconds },
  };
}

export function extendForms(): ToolForm[] {
  return SPECS.flatMap((spec) => {
    const form = formForSpec(spec);
    return form ? [form] : [];
  });
}

export function extendForm(id: string): ToolForm | undefined {
  return extendForms().find((form) => form.id === id);
}

export interface ExtendTool {
  id: string;
  name: string;
  description: string;
  endpoint: string;
  mapper: "fal.queue";
  inputKey: "video_url";
  accepts: "video";
  maxSeconds: number;
}

/** Tools whose catalog entry still matches the schema we checked. */
export function runnableExtends(): ExtendTool[] {
  const tools: ExtendTool[] = [];
  for (const spec of SPECS) {
    const form = formForSpec(spec);
    const model = form && catalogModel(form.id);
    const route = model?.routes.find((item) => item.provider === "fal");
    if (!form || !model || !route) continue;
    tools.push({
      id: model.id,
      name: model.name,
      description: model.description,
      endpoint: route.endpoint,
      mapper: "fal.queue",
      inputKey: "video_url",
      accepts: "video",
      maxSeconds: spec.maxSeconds,
    });
  }
  return tools;
}

function offersExtend(model: VideoModel, spec: ExtendSpec, endpoint: string): boolean {
  return model.routes.some((route) => route.endpoint !== endpoint && route.endpoint.startsWith(spec.match));
}

/** What the studio can show. Endpoint ids stay on the server. */
export function extendOffers(): ExtendOffer[] {
  const videos = ALL_MODELS.filter(isVideo);
  return runnableExtends().map((tool) => {
    const spec = SPECS.find((item) => item.id === tool.id)!;
    return {
      id: tool.id,
      name: tool.name,
      description: tool.description,
      modelIds: videos.filter((model) => offersExtend(model, spec, tool.endpoint)).map((model) => model.id),
    };
  });
}

/** Fal JSON for one source clip. `video_url` stays an `upload:` ref until the job resolves it. */
export function buildExtendBody(toolId: string, assetKey: string, params: unknown): Record<string, unknown> {
  const form = extendForm(toolId);
  if (!form) throw new ProviderError("Unknown tool", 400);
  const body = buildToolBody(form, params, `upload:${assetKey}`);
  const prompt = body.prompt;
  if (typeof prompt !== "string" || !prompt.trim()) throw new ProviderError("Describe what happens next.", 400);
  body.prompt = prompt.trim();
  return body;
}
