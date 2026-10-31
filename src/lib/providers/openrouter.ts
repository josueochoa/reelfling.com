// OpenRouter: asynchronous video API (Seedance via BytePlus) and the synchronous images API.
// Docs: https://openrouter.ai/docs/api/api-reference/video-generation/submit-a-video-generation-request,
// https://openrouter.ai/docs/api/api-reference/images/generate-an-image

import type { ProviderCredentials } from "../keys";
import type { GenerateRequest, TaskStatus } from "../types";
import { ProviderError, type ProviderFactory } from "./types";

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const baseOf = (creds: ProviderCredentials) => (creds.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");

interface OpenRouterJob {
  id: string;
  status: "pending" | "in_progress" | "completed" | "failed" | "cancelled" | "expired";
  error?: string;
  unsigned_urls?: string[];
  usage?: { cost?: number | null };
}

const STATUS: Record<OpenRouterJob["status"], TaskStatus> = {
  pending: "queued",
  in_progress: "running",
  completed: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
  expired: "expired",
};

export async function openRouter<T>(creds: ProviderCredentials, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${baseOf(creds)}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${creds.apiKey}`,
      "Content-Type": "application/json",
      // App attribution on openrouter.ai.
      "HTTP-Referer": "https://reelfling.com",
      "X-Title": "ReelFling",
      ...init?.headers,
    },
    cache: "no-store",
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new ProviderError(`OpenRouter returned non-JSON (${res.status}): ${text.slice(0, 200)}`, res.status || 502);
  }
  if (!res.ok) {
    // { error: { code, message, metadata? } }
    const err = body?.error ?? {};
    const detail = err.metadata?.raw ?? err.metadata?.provider_name;
    const message = err.message || `OpenRouter request failed (${res.status})`;
    throw new ProviderError(
      typeof detail === "string" && detail !== message ? `${message}: ${detail}` : message,
      res.status,
      err.code === undefined ? undefined : String(err.code),
    );
  }
  return body as T;
}

const media = (type: "image_url" | "video_url" | "audio_url", url: string) =>
  ({ type, [type]: { url } }) as Record<string, unknown>;

function buildBody(req: GenerateRequest) {
  const frames = req.mode === "frames";
  const frameImages =
    frames && req.firstFrame
      ? [
          { ...media("image_url", req.firstFrame), frame_type: "first_frame" },
          ...(req.lastFrame ? [{ ...media("image_url", req.lastFrame), frame_type: "last_frame" }] : []),
        ]
      : [];
  const references = frames
    ? []
    : [
        ...(req.referenceImages ?? []).map((u) => media("image_url", u)),
        ...(req.referenceVideos ?? []).map((u) => media("video_url", u)),
        ...(req.referenceAudios ?? []).map((u) => media("audio_url", u)),
      ];

  return {
    model: req.model,
    ...(req.prompt.trim() && { prompt: req.prompt.trim() }),
    duration: req.duration,
    resolution: req.resolution === "4k" ? "4K" : req.resolution,
    aspect_ratio: req.ratio,
    ...(req.generateAudio !== undefined && { generate_audio: req.generateAudio }),
    ...(req.seed !== undefined && { seed: req.seed }),
    ...(frameImages.length && { frame_images: frameImages }),
    ...(references.length && { input_references: references }),
  };
}

export const openRouterProvider: ProviderFactory = (creds) => ({
  id: "openrouter",
  label: "OpenRouter",

  async verifyKey() {
    const { data } = await openRouter<{ data?: { limit_remaining?: number | null } }>(creds, "/key");
    const left = data?.limit_remaining;
    return { detail: typeof left === "number" ? `$${left.toFixed(2)} left on this key` : undefined };
  },

  async createTask(req) {
    const { id } = await openRouter<OpenRouterJob>(creds, "/videos", {
      method: "POST",
      body: JSON.stringify(buildBody(req)),
    });
    return { taskId: id };
  },

  async getTask(taskId) {
    const job = await openRouter<OpenRouterJob>(creds, `/videos/${encodeURIComponent(taskId)}`);
    return {
      status: STATUS[job.status] ?? "running",
      error: job.error,
      cost: job.usage?.cost ?? undefined,
    };
  },

  // No cancel endpoint; local deletion is all we can do.
  async deleteTask() {},

  fetchVideo: (taskId) =>
    fetch(`${baseOf(creds)}/videos/${encodeURIComponent(taskId)}/content?index=0`, {
      headers: { Authorization: `Bearer ${creds.apiKey}` },
    }),
});
