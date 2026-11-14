// ArgoLink gateway video API (Seedance, Kling 4.0, Wan 3.0).
// Docs: https://argolink.io/en/docs, https://argolink.io/en/models/seedance-2.5,
// https://argolink.io/en/models/kling-4.0, https://argolink.io/en/models/wan-3

import { argoLinkBalance, type ProviderBalance } from "../balance";
import type { ProviderCredentials } from "../keys";
import type { GenerateRequest } from "../types";
import { uploadBody } from "../uploadBody";
import { TASK_TYPE_MISMATCH_HINT } from "../videoEdit";
import { ProviderError, type ProviderFactory, type TaskSnapshot } from "./types";

const DEFAULT_BASE_URL = "https://argolink.io";
const baseOf = (creds: ProviderCredentials) => (creds.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");

interface ArgoTask {
  request_id: string;
  status: "pending" | "done" | "failed" | "expired";
  progress?: number;
  video?: { url?: string; duration?: number };
  error?: string | { message?: string; code?: string };
  usage?: { output_seconds?: number; billed_seconds?: number };
}

/** ArgoLink's message and code as sent, plus a hint for an edit read as something else. */
export function argoErrorText(error: { message?: string; code?: string } | undefined, fallback: string) {
  const message = error?.message?.trim() || fallback;
  const code = error?.code?.trim();
  const text = code && !message.includes(code) ? `${message} (${code})` : message;
  return /TaskTypeMismatch/i.test(`${code ?? ""} ${message}`) ? `${text} ${TASK_TYPE_MISMATCH_HINT}` : text;
}

export async function argo<T>(creds: ProviderCredentials, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${baseOf(creds)}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${creds.apiKey}`, "Content-Type": "application/json", ...init?.headers },
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
    throw new ProviderError(argoErrorText(err, `ArgoLink request failed (${res.status})`), res.status, err?.code);
  }
  return body as T;
}

/** An upload ticket from ArgoLink, filled with these bytes. Returns the media URL to send. */
async function uploadMedia(
  creds: ProviderCredentials,
  model: string,
  contentType: string,
  file: { body: BodyInit; bytes: number },
): Promise<string> {
  const ticket = await argo<{ upload_url: string; media_url: string }>(creds, "/v1/media/uploads", {
    method: "POST",
    body: JSON.stringify({
      model,
      type: contentType.split("/")[0],
      content_type: contentType,
      size_bytes: file.bytes,
    }),
  });
  const put = await fetch(ticket.upload_url, { method: "PUT", headers: { "Content-Type": contentType }, body: file.body });
  if (!put.ok) throw new ProviderError(`Media upload failed (${put.status})`, 502);
  return ticket.media_url;
}

/** ArgoLink only takes HTTPS media, so push data: URIs through its upload tickets. */
async function toMediaUrl(creds: ProviderCredentials, model: string, url: string): Promise<string> {
  const match = url.match(/^data:([^;,]+);base64,(.*)$/);
  if (!match) return url;
  const [, contentType, b64] = match;
  const bytes = Buffer.from(b64, "base64");
  return uploadMedia(creds, model, contentType, { body: bytes, bytes: bytes.length });
}

/** The video to edit, copied into ArgoLink's media storage from our signed link. */
async function hostedVideo(creds: ProviderCredentials, model: string, url: string): Promise<string> {
  if (url.startsWith("data:")) return toMediaUrl(creds, model, url);
  const source = await fetch(url);
  if (!source.ok) throw new ProviderError(`Couldn't read the video to edit (${source.status})`, 502);
  const header = source.headers.get("content-type")?.split(";")[0].trim();
  const contentType = header?.startsWith("video/")
    ? header
    : new URL(url).pathname.toLowerCase().endsWith(".mov")
      ? "video/quicktime"
      : "video/mp4";
  return uploadMedia(creds, model, contentType, await uploadBody(source));
}

/**
 * Edit: the video first in reference_videos. Length and shape come from it, so
 * duration, aspect_ratio, frames and audio are left out.
 */
export async function buildArgoEditBody(creds: ProviderCredentials, req: GenerateRequest) {
  if (!req.editVideo) throw new ProviderError("Add the video to edit", 400);
  const media = (url: string) => toMediaUrl(creds, req.model, url).then((u) => ({ url: u }));
  return {
    model: req.model,
    omni_reference_task_type: "edit",
    prompt: req.prompt.trim(),
    resolution: req.resolution,
    reference_videos: [{ url: await hostedVideo(creds, req.model, req.editVideo) }],
    ...(req.referenceImages?.length && { reference_images: await Promise.all(req.referenceImages.map(media)) }),
  };
}

export async function buildArgoVideoBody(creds: ProviderCredentials, req: GenerateRequest) {
  const media = (url: string) => toMediaUrl(creds, req.model, url).then((u) => ({ url: u }));
  const frames = req.mode === "frames";

  return {
    model: req.model,
    prompt: req.prompt.trim(),
    duration: req.duration,
    resolution: req.resolution,
    aspect_ratio: req.ratio,
    ...(req.generateAudio !== undefined && { generate_audio: req.generateAudio }),
    // Only models that take a seed keep one this far (the route drops it otherwise).
    ...(req.seed !== undefined && { seed: req.seed }),
    ...(frames && req.firstFrame && { start_image: await media(req.firstFrame) }),
    ...(frames && req.firstFrame && req.lastFrame && { end_image: await media(req.lastFrame) }),
    ...(!frames &&
      req.referenceImages?.length && { reference_images: await Promise.all(req.referenceImages.map(media)) }),
    ...(!frames && req.referenceVideos?.length && { reference_videos: req.referenceVideos.map((url) => ({ url })) }),
    ...(!frames && req.referenceAudios?.length && { reference_audios: req.referenceAudios.map((url) => ({ url })) }),
  };
}

/** The account's prepaid balance. */
export async function argoBalance(creds: ProviderCredentials): Promise<ProviderBalance> {
  return argoLinkBalance(await argo<{ available?: number; currency?: string }>(creds, "/v1/account/balance"));
}

export const argoLink: ProviderFactory = (creds) => ({
  id: "argolink",
  label: "ArgoLink",

  async verifyKey() {
    const b = await argo<{ available?: number; currency?: string }>(creds, "/v1/account/balance");
    return { detail: b.available !== undefined ? `$${b.available.toFixed(2)} available` : undefined };
  },

  async createTask(req) {
    const { request_id } = await argo<{ request_id: string }>(creds, "/v1/videos/generations", {
      method: "POST",
      body: JSON.stringify(
        req.mode === "edit" ? await buildArgoEditBody(creds, req) : await buildArgoVideoBody(creds, req),
      ),
    });
    return { taskId: request_id };
  },

  async getTask(taskId) {
    const t = await argo<ArgoTask>(creds, `/v1/videos/${encodeURIComponent(taskId)}`);
    const snap: TaskSnapshot = {
      status:
        t.status === "done" ? "succeeded" : t.status === "pending" ? (t.progress ? "running" : "queued") : t.status,
      progress: t.status === "done" ? 100 : t.progress,
      videoUrl: t.video?.url,
      billedSeconds: t.usage?.billed_seconds,
    };
    if (t.error)
      snap.error =
        typeof t.error === "string" ? argoErrorText({ message: t.error }, t.error) : argoErrorText(t.error, "ArgoLink failed");
    return snap;
  },

  // No cancel endpoint is documented; local deletion is all we can do.
  async deleteTask() {},

  fetchVideo: (taskId) =>
    fetch(`${baseOf(creds)}/v1/videos/${encodeURIComponent(taskId)}/content`, {
      headers: { Authorization: `Bearer ${creds.apiKey}` },
    }),
});
