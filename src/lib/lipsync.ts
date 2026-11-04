// Lip sync as a fal tool job. The video is the asset on screen. Audio is a second library file.
// Schemas were read from GET https://api.fal.ai/v1/models?endpoint_id=…&expand=openapi-3.0
// on Nov 4, 2026, with no API key. Prices are from each model's llms.txt the same day
// (`GET /v1/models/pricing` is 401 without a key).
//
// Kept (required input is video_url + audio_url):
//   fal-ai/sync-lipsync/v3                         sync_mode: cut_off | loop | bounce | silence | remap
//   fal-ai/kling-video/lipsync/audio-to-video      video 2–10s, audio 2–60s and ≤5 MB. No mismatch field.
//   veed/lipsync/v2                                video_url + audio_url only
//   fal-ai/latentsync                              loop_mode (loop | pingpong) when audio is longer; guidance_scale 1–2
//
// Not sent, because the schema default is what we want and the form doesn't collect them:
//   enable_safety_checker (default true), sync-3 `options` (it overrides sync_mode), LatentSync `seed`.
// Typed speech (text-to-speech) is a later item and is not a field here. sync.so's own API is not a provider.

import { ProviderError } from "./providers/types";
import { isLipsyncTool, lipsyncQuote, omitInactiveLoop } from "./lipsyncQuote";
import { catalogModel } from "./registry/generated";
import { parseToolParams, type ToolForm } from "./registry/tool-forms";
import type { ToolFieldView, ToolQuote } from "./toolTypes";
import { isAssetKey } from "./uploads";

const SYNC_MODE: ToolFieldView = {
  name: "sync_mode",
  label: "When lengths differ",
  type: "enum",
  default: "cut_off",
  options: ["cut_off", "loop", "bounce", "silence", "remap"],
};

const LOOP_MODE: ToolFieldView = {
  name: "loop_mode",
  label: "When audio is longer",
  type: "enum",
  default: "loop",
  options: ["loop", "pingpong"],
};

const GUIDANCE: ToolFieldView = {
  name: "guidance_scale",
  label: "Guidance",
  type: "number",
  min: 1,
  max: 2,
  step: 0.1,
  default: 1,
};

interface LipsyncForm extends ToolForm {
  id: string;
  audioKey: "audio_url";
  quote: ToolQuote;
}

const FORMS: readonly LipsyncForm[] = [
  {
    id: "fal:fal-ai/sync-lipsync/v3",
    accepts: "video",
    inputKey: "video_url",
    audioKey: "audio_url",
    menu: "Lip sync",
    fields: [SYNC_MODE],
    quote: lipsyncQuote("fal:fal-ai/sync-lipsync/v3")!,
  },
  {
    id: "fal:fal-ai/kling-video/lipsync/audio-to-video",
    accepts: "video",
    inputKey: "video_url",
    audioKey: "audio_url",
    menu: "Lip sync",
    fields: [],
    quote: lipsyncQuote("fal:fal-ai/kling-video/lipsync/audio-to-video")!,
  },
  {
    id: "fal:veed/lipsync/v2",
    accepts: "video",
    inputKey: "video_url",
    audioKey: "audio_url",
    menu: "Lip sync",
    fields: [],
    quote: lipsyncQuote("fal:veed/lipsync/v2")!,
  },
  {
    id: "fal:fal-ai/latentsync",
    accepts: "video",
    inputKey: "video_url",
    audioKey: "audio_url",
    menu: "Lip sync",
    fields: [LOOP_MODE, GUIDANCE],
    quote: lipsyncQuote("fal:fal-ai/latentsync")!,
  },
];

function checkedForm(form: LipsyncForm): LipsyncForm | undefined {
  const model = catalogModel(form.id);
  const route = model?.routes.find((item) => item.provider === "fal" && item.mapper === "fal.queue");
  if (!model || model.group !== "tool" || model.capabilities.accepts !== "video") return undefined;
  if (!route || route.endpoint !== form.id.slice("fal:".length)) return undefined;
  if (!isLipsyncTool(form.id) || !form.quote) return undefined;
  return form;
}

export function lipsyncForms(): LipsyncForm[] {
  return FORMS.flatMap((form) => {
    const checked = checkedForm(form);
    return checked ? [checked] : [];
  });
}

export function lipsyncForm(id: string): LipsyncForm | undefined {
  return lipsyncForms().find((form) => form.id === id);
}

export interface LipsyncTool {
  id: string;
  name: string;
  description: string;
  accepts: "video";
  fields: ToolFieldView[];
  menu: "Lip sync";
  quote: ToolQuote;
  needsAudio: true;
  endpoint: string;
  mapper: "fal.queue";
  inputKey: "video_url";
  audioKey: "audio_url";
}

/** Tools whose catalog entry still matches the schema we checked. */
export function lipsyncTools(): LipsyncTool[] {
  const tools: LipsyncTool[] = [];
  for (const form of FORMS) {
    const checked = checkedForm(form);
    const model = checked && catalogModel(checked.id);
    const route = model?.routes.find((item) => item.provider === "fal");
    if (!checked || !model || !route) continue;
    tools.push({
      id: model.id,
      name: model.name,
      description: model.description,
      accepts: "video",
      fields: form.fields.map((field) => ({ ...field })),
      menu: "Lip sync",
      quote: form.quote,
      needsAudio: true,
      endpoint: route.endpoint,
      mapper: "fal.queue",
      inputKey: "video_url",
      audioKey: "audio_url",
    });
  }
  return tools;
}

/**
 * Fal JSON for one video and one audio file. URLs stay `upload:` refs until the job resolves them.
 * `loop_mode` is omitted when the audio is not longer than the video.
 */
export function buildLipsyncBody(
  toolId: string,
  videoKey: string,
  audioKey: string,
  params: unknown,
  durations?: { video?: number; audio?: number },
): Record<string, unknown> {
  const form = lipsyncForm(toolId);
  if (!form) throw new ProviderError("Unknown tool", 400);
  if (!isAssetKey(videoKey) || !isAssetKey(audioKey))
    throw new ProviderError("Choose a video and an audio file from your library.", 400);
  const parsed = omitInactiveLoop(parseToolParams(form, params), durations?.video, durations?.audio);
  return { ...parsed, [form.inputKey]: `upload:${videoKey}`, [form.audioKey]: `upload:${audioKey}` };
}
