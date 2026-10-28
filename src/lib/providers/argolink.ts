// ArgoLink gateway video API (resells Seedance).
// Docs: https://argolink.io/en/docs, https://argolink.io/en/models/seedance-2.5

import type { GenerateRequest } from "../types";
import { ProviderError, type TaskSnapshot, type VideoProvider } from "./types";

const BASE_URL = (process.env.ARGOLINK_BASE_URL || "https://argolink.io").replace(/\/$/, "");

interface ArgoTask {
  request_id: string;
  status: "pending" | "done" | "failed" | "expired";
  progress?: number;
  video?: { url?: string; duration?: number };
  error?: string | { message?: string; code?: string };
  usage?: { output_seconds?: number; billed_seconds?: number };
}

function key() {
  const k = process.env.ARGOLINK_API_KEY;
  if (!k) throw new ProviderError("ARGOLINK_API_KEY is not set. Add it to .env.local.", 500);
  return k;
}

async function argo<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${key()}`, "Content-Type": "application/json", ...init?.headers },
    cache: "no-store",
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new ProviderError(`ArgoLink returned non-JSON (${res.status}): ${text.slice(0, 200)}`, res.status || 502);
  }
  if (!res.ok) {
    // Gateway errors are { code, message }; model errors are { error: { message, code } }.
    const err = typeof body?.error === "object" ? body.error : body;
    throw new ProviderError(err?.message || `ArgoLink request failed (${res.status})`, res.status, err?.code);
  }
  return body as T;
}

/** ArgoLink only takes HTTPS media, so push data: URIs through its upload tickets. */
async function toMediaUrl(model: string, url: string): Promise<string> {
  const match = url.match(/^data:([^;,]+);base64,(.*)$/);
  if (!match) return url;
  const [, contentType, b64] = match;
  const bytes = Buffer.from(b64, "base64");
  const ticket = await argo<{ upload_url: string; media_url: string }>("/v1/media/uploads", {
    method: "POST",
    body: JSON.stringify({
      model,
      type: contentType.split("/")[0],
      content_type: contentType,
      size_bytes: bytes.length,
    }),
  });
  const put = await fetch(ticket.upload_url, { method: "PUT", headers: { "Content-Type": contentType }, body: bytes });
  if (!put.ok) throw new ProviderError(`Media upload failed (${put.status})`, 502);
  return ticket.media_url;
}

async function buildBody(req: GenerateRequest) {
  const media = (url: string) => toMediaUrl(req.model, url).then((u) => ({ url: u }));
  const frames = req.mode === "frames";

  return {
    model: req.model,
    prompt: req.prompt.trim(),
    duration: req.duration,
    resolution: req.resolution,
    aspect_ratio: req.ratio,
    ...(req.generateAudio !== undefined && { generate_audio: req.generateAudio }),
    ...(frames && req.firstFrame && { start_image: await media(req.firstFrame) }),
    ...(frames && req.firstFrame && req.lastFrame && { end_image: await media(req.lastFrame) }),
    ...(!frames &&
      req.referenceImages?.length && { reference_images: await Promise.all(req.referenceImages.map(media)) }),
    ...(!frames && req.referenceVideos?.length && { reference_videos: req.referenceVideos.map((url) => ({ url })) }),
    ...(!frames && req.referenceAudios?.length && { reference_audios: req.referenceAudios.map((url) => ({ url })) }),
  };
}

export const argoLink: VideoProvider = {
  id: "argolink",
  label: "ArgoLink",

  async createTask(req) {
    const { request_id } = await argo<{ request_id: string }>("/v1/videos/generations", {
      method: "POST",
      body: JSON.stringify(await buildBody(req)),
    });
    return { taskId: request_id };
  },

  async getTask(taskId) {
    const t = await argo<ArgoTask>(`/v1/videos/${encodeURIComponent(taskId)}`);
    const snap: TaskSnapshot = {
      status:
        t.status === "done" ? "succeeded" : t.status === "pending" ? (t.progress ? "running" : "queued") : t.status,
      progress: t.status === "done" ? 100 : t.progress,
      videoUrl: t.video?.url,
      billedSeconds: t.usage?.billed_seconds,
    };
    if (t.error) snap.error = typeof t.error === "string" ? t.error : (t.error.message ?? t.error.code);
    return snap;
  },

  // No cancel endpoint is documented; local deletion is all we can do.
  async deleteTask() {},

  fetchVideo: (taskId) =>
    fetch(`${BASE_URL}/v1/videos/${encodeURIComponent(taskId)}/content`, {
      headers: { Authorization: `Bearer ${key()}` },
    }),
};
