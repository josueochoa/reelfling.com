// BytePlus ModelArk video generation task API.
// Docs: https://docs.byteplus.com/en/docs/ModelArk (Video Generation API)

import type { ProviderCredentials } from "../keys";
import type { GenerateRequest, TaskStatus } from "../types";
import { ProviderError, type ProviderFactory } from "./types";

const DEFAULT_BASE_URL = "https://ark.ap-southeast.bytepluses.com/api/v3";

type ContentItem =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string }; role?: "first_frame" | "last_frame" | "reference_image" }
  | { type: "video_url"; video_url: { url: string }; role: "reference_video" }
  | { type: "audio_url"; audio_url: { url: string }; role: "reference_audio" };

interface ArkTask {
  id: string;
  model: string;
  status: TaskStatus;
  error?: { code: string; message: string } | null;
  content?: { video_url?: string; last_frame_url?: string };
  usage?: { completion_tokens?: number; total_tokens?: number };
  seed?: number;
}

async function ark<T>(creds: ProviderCredentials, path: string, init?: RequestInit): Promise<T> {
  const base = (creds.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${creds.apiKey}`, "Content-Type": "application/json", ...init?.headers },
    cache: "no-store",
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new ProviderError(`ModelArk returned non-JSON (${res.status}): ${text.slice(0, 200)}`, res.status || 502);
  }
  if (!res.ok) {
    const err = body?.error ?? {};
    throw new ProviderError(err.message || `ModelArk request failed (${res.status})`, res.status, err.code);
  }
  return body as T;
}

export function buildTaskBody(req: GenerateRequest) {
  const content: ContentItem[] = [];
  if (req.prompt.trim()) content.push({ type: "text", text: req.prompt.trim() });

  if (req.mode === "frames") {
    if (req.firstFrame) content.push({ type: "image_url", image_url: { url: req.firstFrame }, role: "first_frame" });
    if (req.firstFrame && req.lastFrame)
      content.push({ type: "image_url", image_url: { url: req.lastFrame }, role: "last_frame" });
  } else {
    for (const url of req.referenceImages ?? [])
      content.push({ type: "image_url", image_url: { url }, role: "reference_image" });
    for (const url of req.referenceVideos ?? [])
      content.push({ type: "video_url", video_url: { url }, role: "reference_video" });
    for (const url of req.referenceAudios ?? [])
      content.push({ type: "audio_url", audio_url: { url }, role: "reference_audio" });
  }

  return {
    model: req.model,
    content,
    ratio: req.ratio,
    resolution: req.resolution,
    duration: req.duration,
    watermark: req.watermark ?? false,
    ...(req.generateAudio !== undefined && { generate_audio: req.generateAudio }),
    ...(req.seed !== undefined && { seed: req.seed }),
    ...(req.cameraFixed && { camera_fixed: true }),
    return_last_frame: true,
  };
}

export const modelArk: ProviderFactory = (creds) => ({
  id: "modelark",
  label: "BytePlus ModelArk",

  async verifyKey() {
    await ark(creds, "/contents/generations/tasks?page_num=1&page_size=1");
    return {};
  },

  async createTask(req) {
    const { id } = await ark<{ id: string }>(creds, "/contents/generations/tasks", {
      method: "POST",
      body: JSON.stringify(buildTaskBody(req)),
    });
    return { taskId: id };
  },

  async getTask(taskId) {
    const task = await ark<ArkTask>(creds, `/contents/generations/tasks/${encodeURIComponent(taskId)}`);
    return {
      status: task.status,
      videoUrl: task.content?.video_url,
      lastFrameUrl: task.content?.last_frame_url,
      error: task.error?.message,
      seed: task.seed,
      tokens: task.usage?.completion_tokens,
    };
  },

  /** Cancels a queued task, or deletes the record of a finished one. Running tasks can't be cancelled. */
  async deleteTask(taskId) {
    await ark(creds, `/contents/generations/tasks/${encodeURIComponent(taskId)}`, { method: "DELETE" });
  },

  // Signed, unauthenticated URL.
  fetchVideo: (_taskId, { videoUrl }) => fetch(videoUrl!),
});
