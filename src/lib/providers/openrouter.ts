// OpenRouter video API (async) and images API (sync).
// Docs (checked Nov 2026):
//   https://openrouter.ai/docs/guides/overview/multimodal/video-generation
//   https://openrouter.ai/docs/guides/overview/multimodal/image-generation
//   POST /api/v1/videos, GET /api/v1/videos/{id}, GET /api/v1/videos/{id}/content
//   POST /api/v1/images, GET /api/v1/key
//
// The key is attached only after a strict https + hostname check for openrouter.ai.
// A download URL on any other host is fetched with no Authorization header. Redirects
// are not followed automatically: a 3xx Location is fetched again under the same rule,
// so the key cannot ride along to a CDN or another host.

import { reportedUsd } from "../reportedCost";
import type { OpenRouterImageCall } from "../registry/bodies";
import type { GenerateRequest, TaskStatus } from "../types";
import { ProviderError, type ProviderFactory, type TaskSnapshot } from "./types";

const ORIGIN = "https://openrouter.ai";
const API = `${ORIGIN}/api/v1`;

type JobStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled" | "expired";

interface OpenRouterJob {
  id?: string;
  status?: JobStatus;
  error?: string;
  /** Needs the API key. Often an OpenRouter content URL. */
  unsigned_urls?: string[];
  /** Signed URLs that work without the API key until they expire. */
  urls?: string[];
}

export interface OpenRouterImageItem {
  b64_json?: string;
  url?: string;
  media_type?: string;
}

const STATUS: Record<JobStatus, TaskStatus> = {
  pending: "queued",
  in_progress: "running",
  completed: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
  expired: "expired",
};

/** `openrouter.ai` and its subdomains, not `openrouter.ai.evil.com`. */
export function isOpenRouterHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/, "");
  if (!host || host.split(".").some((label) => !label)) return false;
  return host === "openrouter.ai" || host.endsWith(".openrouter.ai");
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "metadata.google.internal") return true;
  if (host.includes(":")) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const n = m.slice(1).map(Number);
  if (n.some((part) => part > 255)) return true;
  const [a, b] = n;
  if (a === 10 || a === 127 || a === 0 || a === 255) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function scrub(text: string, secret: string) {
  return secret && text.includes(secret) ? text.split(secret).join("[redacted]") : text;
}

function parseHttps(raw: string, apiKey: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProviderError("OpenRouter returned an invalid URL", 502);
  }
  if (url.protocol !== "https:") throw new ProviderError("Refusing a non-https URL", 502);
  if (url.username || url.password) throw new ProviderError("Refusing a URL with credentials", 502);
  if (apiKey && url.href.includes(apiKey)) throw new ProviderError("Refusing a URL that contains the API key", 502);
  if (isPrivateHost(url.hostname)) throw new ProviderError("Refusing a non-public URL", 502);
  return url;
}

function errorMessage(body: unknown, status: number, apiKey: string): string {
  if (body && typeof body === "object") {
    const rec = body as { error?: unknown; message?: unknown };
    const err = rec.error && typeof rec.error === "object" ? (rec.error as { message?: unknown; metadata?: { raw?: unknown } }) : undefined;
    const message = typeof err?.message === "string" ? err.message : typeof rec.message === "string" ? rec.message : "";
    const raw = err?.metadata && typeof err.metadata.raw === "string" ? err.metadata.raw : "";
    const text = message && raw && raw !== message ? `${message}: ${raw}` : message;
    if (text) return scrub(text, apiKey);
  }
  return `OpenRouter request failed (${status})`;
}

/** The only place an API call attaches the key. Redirects are refused, not followed. */
async function openRouterJson<T>(apiKey: string, path: string, init?: RequestInit): Promise<T> {
  const url = parseHttps(`${API}${path}`, apiKey);
  if (!isOpenRouterHost(url.hostname)) throw new ProviderError("Refusing to send the API key to a non-OpenRouter host", 502);
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${apiKey}`);
  headers.set("HTTP-Referer", "https://reelfling.com");
  headers.set("X-Title", "ReelFling");
  if (init?.body != null) headers.set("Content-Type", "application/json");
  const res = await fetch(url, {
    method: init?.method,
    body: init?.body,
    headers,
    redirect: "manual",
    cache: "no-store",
  });
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel();
    throw new ProviderError("OpenRouter redirected; refusing to follow", 502);
  }
  const text = await res.text();
  let body: unknown = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new ProviderError(`OpenRouter returned non-JSON (${res.status})`, res.status || 502);
    }
  }
  if (!res.ok) throw new ProviderError(errorMessage(body, res.status, apiKey), res.status || 502);
  return body as T;
}

/**
 * Download a finished file. The key is sent only when the host is OpenRouter's.
 * One redirect hop is fetched again under the same rule.
 */
export async function fetchOpenRouterMedia(apiKey: string, rawUrl: string, depth = 0): Promise<Response> {
  if (depth > 2) throw new ProviderError("Refusing to follow another download redirect", 502);
  const url = parseHttps(rawUrl, apiKey);
  const authed = isOpenRouterHost(url.hostname);
  const headers = new Headers();
  if (authed) headers.set("Authorization", `Bearer ${apiKey}`);
  const res = await fetch(url, { headers, redirect: "manual", cache: "no-store" });
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("location");
    await res.body?.cancel();
    if (!location) throw new ProviderError("Download redirect had no location", 502);
    return fetchOpenRouterMedia(apiKey, new URL(location, url).href, depth + 1);
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new ProviderError(`Couldn't download the file (${res.status})`, res.status || 502);
  }
  return res;
}

function videoUrlOf(job: OpenRouterJob, apiKey: string): string | undefined {
  const usable: URL[] = [];
  for (const raw of [...(job.unsigned_urls ?? []), ...(job.urls ?? [])]) {
    try {
      usable.push(parseHttps(raw, apiKey));
    } catch {
      // Skip a URL we would refuse to fetch. The content endpoint is the fallback.
    }
  }
  // OpenRouter content URLs keep working with the key. Signed CDN urls expire.
  return (usable.find((url) => isOpenRouterHost(url.hostname)) ?? usable[0])?.href;
}

/** Video request body for POST /api/v1/videos. `endpoint` is the OpenRouter model id. */
export function buildOpenRouterVideo(req: GenerateRequest, endpoint: string) {
  const frames = req.mode === "frames";
  const frameImages = frames
    ? [
        req.firstFrame && { type: "image_url", image_url: { url: req.firstFrame }, frame_type: "first_frame" },
        req.lastFrame && { type: "image_url", image_url: { url: req.lastFrame }, frame_type: "last_frame" },
      ].filter((frame) => frame !== undefined)
    : [];
  const references = frames
    ? []
    : [
        ...(req.referenceImages ?? []).map((url) => ({ type: "image_url", image_url: { url } })),
        ...(req.referenceVideos ?? []).map((url) => ({ type: "video_url", video_url: { url } })),
        ...(req.referenceAudios ?? []).map((url) => ({ type: "audio_url", audio_url: { url } })),
      ];
  return {
    model: endpoint,
    ...(req.prompt.trim() && { prompt: req.prompt.trim() }),
    duration: req.duration,
    resolution: req.resolution,
    aspect_ratio: req.ratio,
    ...(req.generateAudio !== undefined && { generate_audio: req.generateAudio }),
    ...(req.seed !== undefined && { seed: req.seed }),
    ...(frameImages.length && { frame_images: frameImages }),
    ...(references.length && { input_references: references }),
  };
}

export async function generateOpenRouterImages(
  apiKey: string,
  call: OpenRouterImageCall,
): Promise<{ items: OpenRouterImageItem[]; costUsd?: number }> {
  const settled = await Promise.allSettled(
    Array.from({ length: call.times }, () =>
      openRouterJson<{ data?: OpenRouterImageItem[] }>(apiKey, call.path, {
        method: "POST",
        body: JSON.stringify(call.body),
      }),
    ),
  );
  const fulfilled = settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  const items = fulfilled.flatMap((body) => body.data ?? []);
  const costs = fulfilled.map((body) => reportedUsd(body)).filter((n): n is number => n !== undefined);
  if (items.length) return { items, ...(costs.length ? { costUsd: costs.reduce((a, b) => a + b, 0) } : {}) };
  const rejected = settled.find((result) => result.status === "rejected") as PromiseRejectedResult | undefined;
  throw rejected?.reason ?? new ProviderError("OpenRouter returned no images", 502);
}

/** Bytes for one generated image. A URL is downloaded with the key only on OpenRouter's host. */
export async function openRouterImageFile(apiKey: string, item: OpenRouterImageItem): Promise<Response> {
  if (item.b64_json) {
    const bytes = Uint8Array.from(atob(item.b64_json), (c) => c.charCodeAt(0));
    const type = item.media_type || "image/png";
    return new Response(bytes, { headers: { "content-type": type, "content-length": String(bytes.length) } });
  }
  if (!item.url) throw new ProviderError("OpenRouter returned an image without data", 502);
  return fetchOpenRouterMedia(apiKey, item.url);
}

export const openRouterProvider: ProviderFactory = (creds) => ({
  id: "openrouter",
  label: "OpenRouter",

  async verifyKey() {
    const body = await openRouterJson<{ data?: { limit_remaining?: number | null } }>(creds.apiKey, "/key");
    const left = body.data?.limit_remaining;
    return { detail: typeof left === "number" ? `$${left.toFixed(2)} left on this key` : undefined };
  },

  async createTask(req) {
    const job = await openRouterJson<OpenRouterJob>(creds.apiKey, "/videos", {
      method: "POST",
      body: JSON.stringify(buildOpenRouterVideo(req, req.model)),
    });
    if (!job.id) throw new ProviderError("OpenRouter did not return a job id", 502);
    return { taskId: job.id };
  },

  async getTask(taskId) {
    // Ignore polling_url from the submit response. It is not a host we chose.
    const job = await openRouterJson<OpenRouterJob>(creds.apiKey, `/videos/${encodeURIComponent(taskId)}`);
    const status = (job.status && STATUS[job.status]) || "running";
    const snap: TaskSnapshot = { status };
    if (job.error) snap.error = scrub(job.error, creds.apiKey);
    const videoUrl = videoUrlOf(job, creds.apiKey);
    if (videoUrl) snap.videoUrl = videoUrl;
    const costUsd = reportedUsd(job);
    if (costUsd !== undefined) snap.costUsd = costUsd;
    return snap;
  },

  async deleteTask() {},

  fetchVideo(taskId, snapshot) {
    const url = snapshot.videoUrl ?? `${API}/videos/${encodeURIComponent(taskId)}/content?index=0`;
    return fetchOpenRouterMedia(creds.apiKey, url);
  },
});
