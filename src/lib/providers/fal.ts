// fal queue API. Any endpoint id runs through this one client — no per-model code.
// Docs (checked against fal.ai, Nov 2026):
//   https://fal.ai/docs/documentation/model-apis/inference/queue
//   https://fal.ai/docs/api-reference/inference-api/queue/submit
//   https://fal.ai/docs/platform-apis/v1/models
//
// POST https://queue.fal.run/{endpoint_id} returns request_id plus status_url,
// response_url and cancel_url. Those URLs are followed as-is (building them from the
// endpoint path 405s). They come from a response, so the key is attached only after a
// strict https + hostname check for fal.ai / fal.run. Header: `Authorization: Key <key>`.
// A bad key against GET https://api.fal.ai/v1/models is 401
// `{ error: { type: "authorization_error", message } }`.

import { devMockProviders } from "../devMock";
import type { FalFieldError, FalJobStatus } from "../falTypes";
import { ProviderError } from "./types";

const QUEUE_ORIGIN = "https://queue.fal.run";
/** One cheap authenticated call. Auth is optional on this route; a bad key is still 401. */
const VERIFY_URL = "https://api.fal.ai/v1/models?limit=1";

const ENDPOINT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)+$/;

export interface FalSubmission {
  requestId: string;
  statusUrl: string;
  responseUrl: string;
  cancelUrl: string;
  /** Submit body, with the key scrubbed if it ever appeared. */
  raw: unknown;
}

export interface FalOutput {
  url: string;
  contentType?: string;
  fileName?: string;
  width?: number;
  height?: number;
}

export interface FalSnapshot {
  status: FalJobStatus;
  /** Latest fal payload (status while in flight, result or error body once finished). */
  response: unknown;
  error?: string;
  fields?: FalFieldError[];
  outputs: FalOutput[];
  /** From the status payload, when fal sent one. */
  queuePosition?: number;
}

export class FalValidationError extends ProviderError {
  fields: FalFieldError[];
  body: unknown;
  constructor(fields: FalFieldError[], body: unknown) {
    super(fields.map((f) => `${f.field}: ${f.message}`).join("; ") || "fal rejected this input", 422, "validation_error");
    this.fields = fields;
    this.body = body;
  }
}

/** `queue.fal.run` and `api.fal.ai`, not `fal.ai.evil.com` or `queue.fal.run.evil.com`. */
export function isFalApiHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/, "");
  if (!host || host.split(".").some((label) => !label)) return false;
  return host === "fal.ai" || host.endsWith(".fal.ai") || host === "fal.run" || host.endsWith(".fal.run");
}

/** Throws before any fetch when the URL is not an https fal API host. */
export function assertFalApiUrl(raw: string, apiKey?: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProviderError("fal returned an invalid URL", 502);
  }
  if (url.protocol !== "https:") throw new ProviderError("Refusing a non-https fal URL", 502);
  if (url.username || url.password) throw new ProviderError("Refusing a fal URL with credentials", 502);
  if (!isFalApiHost(url.hostname)) throw new ProviderError("Refusing to send the API key to a non-fal host", 502);
  if (apiKey && url.href.includes(apiKey)) throw new ProviderError("Refusing a fal URL that contains the API key", 502);
  return url;
}

export function endpointUrl(endpointId: string): string {
  const id = endpointId.trim().replace(/^\/+|\/+$/g, "");
  if (!ENDPOINT_ID.test(id)) throw new ProviderError("Endpoint id must look like owner/name or owner/name/path", 400);
  return `${QUEUE_ORIGIN}/${id}`;
}

export function redactSecrets(value: unknown, secret: string): unknown {
  if (!secret) return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return v.includes(secret) ? v.split(secret).join("[redacted]") : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return walk(value);
}

const scrub = (message: string, secret: string) => (secret ? message.split(secret).join("[redacted]") : message);

/** `["body", "prompt"]` → `prompt`. Nested locs stay dotted (`images.0.url`). */
export function fieldErrorsOf(body: unknown, secret = ""): FalFieldError[] {
  const detail = body && typeof body === "object" ? (body as { detail?: unknown }).detail : undefined;
  if (!Array.isArray(detail)) {
    const message = typeof detail === "string" ? detail : "fal rejected this input";
    return [{ field: "input", message: scrub(message, secret) }];
  }
  return detail.map((item) => {
    const rec = item && typeof item === "object" ? (item as { loc?: unknown; msg?: unknown }) : {};
    const loc = Array.isArray(rec.loc) ? rec.loc.map(String).filter((part) => part !== "body") : [];
    const message = typeof rec.msg === "string" ? rec.msg : "Invalid value";
    return { field: loc.join(".") || "input", message: scrub(message, secret) };
  });
}

function errorMessage(body: unknown, status: number, secret: string): string {
  if (body && typeof body === "object") {
    const rec = body as Record<string, unknown>;
    if (typeof rec.detail === "string" && rec.detail) return scrub(rec.detail, secret);
    if (typeof rec.error === "string" && rec.error) return scrub(rec.error, secret);
    const err = rec.error;
    if (err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string")
      return scrub((err as { message: string }).message, secret);
    if (typeof rec.message === "string" && rec.message) return scrub(rec.message, secret);
  }
  return `fal request failed (${status})`;
}

interface FalHttp {
  status: number;
  body: unknown;
}

/**
 * The only place the key is attached to a request. Redirects are not followed: a 3xx
 * Location could leave fal, and fetch would resend Authorization on the same host.
 */
async function falCall(apiKey: string, url: string, init?: RequestInit): Promise<FalHttp> {
  const target = assertFalApiUrl(url, apiKey);
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Key ${apiKey}`);
  if (init?.body != null) headers.set("Content-Type", "application/json");
  const res = await fetch(target, {
    method: init?.method,
    body: init?.body,
    headers,
    redirect: "manual",
    cache: "no-store",
  });
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel();
    throw new ProviderError("fal redirected; refusing to follow", 502);
  }
  const text = await res.text();
  let body: unknown = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      // The bytes can echo the key. Status only.
      throw new ProviderError(`fal returned non-JSON (${res.status})`, res.status || 502);
    }
  }
  return { status: res.status, body: redactSecrets(body, apiKey) };
}

function asRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

function httpFailure(status: number, body: unknown, apiKey: string): FalValidationError | ProviderError {
  if (status === 422) return new FalValidationError(fieldErrorsOf(body, apiKey), body);
  const code = status >= 400 && status < 500 ? status : 502;
  return new ProviderError(errorMessage(body, status, apiKey), code);
}

/** Confirms the key with a single catalog request. */
export async function verifyFalKey(apiKey: string): Promise<{ detail?: string }> {
  if (devMockProviders()) return {};
  const { status, body } = await falCall(apiKey, VERIFY_URL);
  if (status < 200 || status >= 300) throw httpFailure(status, body, apiKey);
  return {};
}

export async function submitFal(apiKey: string, endpointId: string, input: unknown): Promise<FalSubmission> {
  if (devMockProviders()) {
    const requestId = `devmock-${crypto.randomUUID()}`;
    const statusUrl = `https://queue.fal.run/devmock/status/${requestId}`;
    const responseUrl = `https://queue.fal.run/devmock/response/${requestId}`;
    const cancelUrl = `https://queue.fal.run/devmock/cancel/${requestId}`;
    // The stand-in body has no key and no copy of the caller's input.
    return {
      requestId,
      statusUrl,
      responseUrl,
      cancelUrl,
      raw: { request_id: requestId, status: "IN_QUEUE" },
    };
  }
  const { status, body } = await falCall(apiKey, endpointUrl(endpointId), {
    method: "POST",
    body: JSON.stringify(input ?? {}),
  });
  if (status < 200 || status >= 300) throw httpFailure(status, body, apiKey);
  const rec = asRecord(body);
  const requestId = str(rec.request_id);
  const statusUrl = str(rec.status_url);
  const responseUrl = str(rec.response_url);
  const cancelUrl = str(rec.cancel_url);
  if (!requestId || !statusUrl || !responseUrl || !cancelUrl)
    throw new ProviderError("fal submit response was missing request URLs", 502);
  // Reject a poisoned URL before anything stores or follows it.
  assertFalApiUrl(statusUrl, apiKey);
  assertFalApiUrl(responseUrl, apiKey);
  assertFalApiUrl(cancelUrl, apiKey);
  return { requestId, statusUrl, responseUrl, cancelUrl, raw: body };
}

function failureOf(body: unknown, apiKey: string): { error: string; fields?: FalFieldError[] } | undefined {
  const rec = asRecord(body);
  if (typeof rec.error === "string" && rec.error) return { error: scrub(rec.error, apiKey) };
  if (typeof rec.detail === "string" && rec.detail && (rec.error_type || rec.status === "ERROR"))
    return { error: scrub(rec.detail, apiKey) };
  if (Array.isArray(rec.detail)) {
    const fields = fieldErrorsOf(body, apiKey);
    if (fields.length) return { error: fields.map((f) => `${f.field}: ${f.message}`).join("; "), fields };
  }
  return undefined;
}

/** IN_QUEUE → queued, IN_PROGRESS → running, COMPLETED → succeeded or failed. */
export async function pollFal(
  apiKey: string,
  urls: { statusUrl: string; responseUrl: string },
): Promise<FalSnapshot> {
  if (devMockProviders() && (urls.statusUrl.includes("/devmock/") || urls.responseUrl.includes("/devmock/"))) {
    return { status: "queued", response: { status: "IN_QUEUE" }, outputs: [] };
  }
  const statusRes = await falCall(apiKey, urls.statusUrl);
  if (statusRes.status < 200 || statusRes.status >= 300) throw httpFailure(statusRes.status, statusRes.body, apiKey);
  const statusBody = asRecord(statusRes.body);
  const queueStatus = str(statusBody.status);
  const position = statusBody.queue_position;
  const queuePosition = typeof position === "number" && Number.isFinite(position) ? position : undefined;
  if (queueStatus === "IN_QUEUE") return { status: "queued", response: statusRes.body, outputs: [], queuePosition };
  if (queueStatus === "IN_PROGRESS") return { status: "running", response: statusRes.body, outputs: [], queuePosition };
  if (queueStatus !== "COMPLETED") {
    return {
      status: "failed",
      error: queueStatus ? `Unexpected fal status ${queueStatus}` : "fal returned no status",
      response: statusRes.body,
      outputs: [],
    };
  }

  // A failed or cancelled request is also COMPLETED. The result body says which.
  const result = await falCall(apiKey, urls.responseUrl);
  if (result.status === 422) {
    const err = new FalValidationError(fieldErrorsOf(result.body, apiKey), result.body);
    return { status: "failed", error: err.message, fields: err.fields, response: result.body, outputs: [] };
  }
  if (result.status < 200 || result.status >= 300) {
    const fromStatus = failureOf(statusRes.body, apiKey);
    return {
      status: "failed",
      error: fromStatus?.error ?? errorMessage(result.body, result.status, apiKey),
      fields: fromStatus?.fields,
      response: result.body,
      outputs: [],
    };
  }
  const failed = failureOf(result.body, apiKey) ?? failureOf(statusRes.body, apiKey);
  if (failed) return { status: "failed", ...failed, response: result.body, outputs: [] };
  return { status: "succeeded", response: result.body, outputs: collectOutputs(result.body) };
}

/** PUT the cancel URL fal returned. 400/404 mean it already finished or never existed. */
export async function cancelFal(apiKey: string, cancelUrl: string): Promise<void> {
  if (devMockProviders() && cancelUrl.includes("/devmock/")) return;
  const { status, body } = await falCall(apiKey, cancelUrl, { method: "PUT" });
  if (status === 200 || status === 202 || status === 400 || status === 404) return;
  throw httpFailure(status, body, apiKey);
}

const MEDIA_STRINGS = new Set(["audio_url", "video_url", "image_url", "file_url"]);

function httpsUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

/**
 * File objects (`url` plus content_type / file_name / file_size / width / height) and
 * string fields fal uses for media. Queue URLs on fal.run / fal.ai are not files.
 */
export function collectOutputs(value: unknown): FalOutput[] {
  const out: FalOutput[] = [];
  const seen = new Set<string>();
  const add = (raw: string, contentType?: string, fileName?: string, width?: number, height?: number) => {
    const url = httpsUrl(raw);
    if (!url || isFalApiHost(url.hostname) || seen.has(raw)) return;
    seen.add(raw);
    out.push({
      url: raw,
      contentType,
      fileName,
      ...(typeof width === "number" && Number.isFinite(width) ? { width } : {}),
      ...(typeof height === "number" && Number.isFinite(height) ? { height } : {}),
    });
  };
  const walk = (node: unknown, key?: string) => {
    if (typeof node === "string") {
      if (key && MEDIA_STRINGS.has(key)) add(node);
      return;
    }
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, key);
      return;
    }
    const rec = node as Record<string, unknown>;
    if (typeof rec.url === "string") {
      const file =
        typeof rec.content_type === "string" ||
        typeof rec.file_name === "string" ||
        typeof rec.file_size === "number" ||
        typeof rec.width === "number" ||
        typeof rec.height === "number";
      if (file)
        add(
          rec.url,
          typeof rec.content_type === "string" ? rec.content_type : undefined,
          typeof rec.file_name === "string" ? rec.file_name : undefined,
          typeof rec.width === "number" ? rec.width : undefined,
          typeof rec.height === "number" ? rec.height : undefined,
        );
    }
    for (const [k, v] of Object.entries(rec)) if (k !== "url") walk(v, k);
  };
  walk(value);
  return out;
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

/**
 * Downloads a finished file. No Authorization header: output URLs are public and often
 * not on an API host (v3.fal.media). Redirects are not followed.
 */
export async function fetchFalOutput(url: string): Promise<Response> {
  const parsed = httpsUrl(url);
  if (!parsed) throw new ProviderError("Refusing a non-https fal output URL", 502);
  if (isPrivateHost(parsed.hostname)) throw new ProviderError("Refusing a non-public fal output URL", 502);
  const res = await fetch(parsed, { redirect: "manual", cache: "no-store" });
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel();
    throw new ProviderError("Refusing to follow an output redirect", 502);
  }
  if (!res.ok) throw new ProviderError(`Couldn't download fal output (${res.status})`, 502);
  return res;
}

/** Rejects a missing or zero Content-Length. An unsized body would skip the storage cap. */
export function outputBytes(header: string | null): number {
  const bytes = Number(header);
  if (!Number.isFinite(bytes) || bytes <= 0) throw new ProviderError("fal output had no size, so it wasn't saved.", 502);
  return bytes;
}
