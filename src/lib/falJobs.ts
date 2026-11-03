// Generic fal jobs. One row per queue request: the endpoint id, the JSON sent, the JSON
// fal returned, and the files copied into the user's bucket. The API key is never stored
// on the row (see redactSecrets).

import {
  shouldCancelFal,
  storeFailureUpdate,
  type FalFieldError,
  type FalJobStatus,
  type FalJobView,
} from "./falTypes";
import { all, first, run } from "./db";
import { getCredentials } from "./keys";
import {
  cancelFal,
  collectOutputs,
  fetchFalOutput,
  pollFal,
  redactSecrets,
  submitFal,
  type FalOutput,
} from "./providers/fal";
import { ProviderError } from "./providers/types";
import { assertStorageAvailable, deleteGenerationAssets, getAsset, providerUrl, putAsset } from "./storage";
import { isAssetKey, isUploadRef, uploadKeyOf } from "./uploads";

export interface FalJob {
  id: string;
  endpointId: string;
  status: FalJobStatus;
  requestId: string;
  statusUrl: string;
  responseUrl: string;
  cancelUrl: string;
  /** Body posted to fal, after upload: refs became signed R2 URLs. */
  request: unknown;
  /** Latest fal payload. */
  response?: unknown;
  outputs: { key: string; contentType: string }[];
  error?: string;
  fields?: FalFieldError[];
  stored?: boolean;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

const parse = (row?: { data: string }) => (row ? (JSON.parse(row.data) as FalJob) : undefined);

export async function listFalJobs(userId: string) {
  const rows = await all<{ data: string }>(
    "SELECT data FROM fal_jobs WHERE user_id = ? ORDER BY created_at DESC",
    userId,
  );
  return rows.map((row) => parse(row)!);
}

export async function getFalJob(userId: string, id: string) {
  return parse(await first<{ data: string }>("SELECT data FROM fal_jobs WHERE id = ? AND user_id = ?", id, userId));
}

export async function insertFalJob(userId: string, job: FalJob) {
  await run(
    "INSERT INTO fal_jobs (id, user_id, created_at, data) VALUES (?, ?, ?, ?)",
    job.id,
    userId,
    job.createdAt,
    JSON.stringify(job),
  );
}

export async function updateFalJob(userId: string, id: string, patch: Partial<FalJob>) {
  const job = await getFalJob(userId, id);
  if (!job) return undefined;
  const next = { ...job, ...patch, updatedAt: Date.now() };
  await run("UPDATE fal_jobs SET data = ? WHERE id = ? AND user_id = ?", JSON.stringify(next), id, userId);
  return next;
}

export async function removeFalJob(userId: string, id: string) {
  await deleteGenerationAssets(userId, id);
  await run("DELETE FROM fal_jobs WHERE id = ? AND user_id = ?", id, userId);
}

/** Still in flight, or finished but not yet copied into the bucket. */
export async function unfinishedFalJobs(limit: number, maxAgeMs: number) {
  return all<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM fal_jobs
     WHERE created_at > ?
       AND (json_extract(data, '$.status') IN ('queued', 'running')
            OR (json_extract(data, '$.status') = 'succeeded' AND json_extract(data, '$.stored') IS NOT 1))
     ORDER BY created_at LIMIT ?`,
    Date.now() - maxAgeMs,
    limit,
  );
}

/** Best-effort cancel of a queued or running request. Finished jobs are only removed locally. */
export async function cancelFalJob(userId: string, job: FalJob) {
  if (!shouldCancelFal(job.status)) return;
  const creds = await getCredentials(userId, "fal").catch(() => undefined);
  if (!creds) return;
  await cancelFal(creds.apiKey, job.cancelUrl);
}

const promptOf = (request: unknown) => {
  if (!request || typeof request !== "object" || Array.isArray(request)) return "";
  const prompt = (request as { prompt?: unknown }).prompt;
  return typeof prompt === "string" ? prompt.trim() : "";
};

/** Drops URLs, the raw JSON and anything else the browser doesn't need. */
export function publicFalJob(job: FalJob): FalJobView {
  return {
    id: job.id,
    endpointId: job.endpointId,
    status: job.status,
    prompt: promptOf(job.request),
    error: job.error,
    fields: job.fields,
    outputs: job.outputs,
    stored: job.stored,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
  };
}

/** Replaces `upload:<key>` strings with signed R2 URLs fal can download. */
export async function resolveFalInput(userId: string, input: unknown): Promise<unknown> {
  if (typeof input === "string") {
    if (!isUploadRef(input)) return input;
    const key = uploadKeyOf(input);
    const asset = isAssetKey(key) ? await getAsset(userId, key) : undefined;
    if (!asset)
      throw Object.assign(new Error("A reference is no longer in your uploads. Remove it and add it again."), {
        status: 400,
      });
    return providerUrl(asset);
  }
  if (Array.isArray(input)) return Promise.all(input.map((item) => resolveFalInput(userId, item)));
  if (input && typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) out[key] = await resolveFalInput(userId, value);
    return out;
  }
  return input;
}

function assertNoSecret(value: unknown, secret: string) {
  if (secret && JSON.stringify(value).includes(secret))
    throw new ProviderError("Refusing to store a fal payload that contains the API key", 500);
}

/** Submits to fal and records the job. A 422 is thrown and nothing is stored. */
export async function createFalJob(userId: string, endpointId: string, input: unknown, apiKey: string) {
  const resolved = await resolveFalInput(userId, input);
  const request = redactSecrets(resolved, apiKey);
  assertNoSecret(request, apiKey);
  const submitted = await submitFal(apiKey, endpointId, resolved);
  assertNoSecret(submitted.raw, apiKey);
  const now = Date.now();
  const job: FalJob = {
    id: crypto.randomUUID(),
    endpointId: endpointId.trim().replace(/^\/+|\/+$/g, ""),
    status: "queued",
    requestId: submitted.requestId,
    statusUrl: submitted.statusUrl,
    responseUrl: submitted.responseUrl,
    cancelUrl: submitted.cancelUrl,
    request,
    response: submitted.raw,
    outputs: [],
    createdAt: now,
    updatedAt: now,
  };
  await insertFalJob(userId, job);
  return job;
}

const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
};

function typeFromUrl(url: string): string | undefined {
  const path = new URL(url).pathname.toLowerCase();
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".gif")) return "image/gif";
  if (path.endsWith(".mp4")) return "video/mp4";
  if (path.endsWith(".webm")) return "video/webm";
  if (path.endsWith(".mov")) return "video/quicktime";
  if (path.endsWith(".mp3")) return "audio/mpeg";
  if (path.endsWith(".wav")) return "audio/wav";
  return undefined;
}

function contentTypeOf(file: FalOutput, header: string | null) {
  if (file.contentType) return file.contentType.split(";")[0].trim();
  const fromHeader = header?.split(";")[0].trim();
  if (fromHeader && fromHeader !== "application/octet-stream") return fromHeader;
  return typeFromUrl(file.url) ?? fromHeader ?? "application/octet-stream";
}

/** Copies every output URL into the user's bucket. Output fetches carry no API key. */
async function storeOutputs(userId: string, job: FalJob) {
  const files = collectOutputs(job.response);
  const outputs: FalJob["outputs"] = [];
  for (const [i, file] of files.entries()) {
    const source = await fetchFalOutput(file.url);
    const bytes = Number(source.headers.get("content-length"));
    await assertStorageAvailable(userId, Number.isFinite(bytes) && bytes > 0 ? bytes : 0);
    const contentType = contentTypeOf(file, source.headers.get("content-type"));
    const ext = EXT[contentType] ?? typeFromUrl(file.url)?.split("/")[1] ?? "bin";
    const asset = await putAsset(userId, {
      key: `fal/${job.id}/${i}.${ext}`,
      source,
      contentType,
      generationId: job.id,
    });
    outputs.push({ key: asset.key, contentType });
  }
  await updateFalJob(userId, job.id, { outputs, stored: true, error: undefined });
}

/** Pulls the latest queue state and, once it succeeds, copies outputs into R2. */
export async function syncFalJob(userId: string, id: string): Promise<FalJob | undefined> {
  let job = await getFalJob(userId, id);
  if (!job) return undefined;

  if (job.status === "queued" || job.status === "running") {
    const creds = await getCredentials(userId, "fal");
    if (!creds) throw new ProviderError("Add your fal API key under API keys.", 400);
    const snap = await pollFal(creds.apiKey, { statusUrl: job.statusUrl, responseUrl: job.responseUrl });
    assertNoSecret(snap.response, creds.apiKey);
    const done = snap.status === "succeeded" || snap.status === "failed";
    job = await updateFalJob(userId, id, {
      status: snap.status,
      response: snap.response,
      error: snap.error,
      fields: snap.fields,
      ...(done && { completedAt: Date.now() }),
    });
    if (!job) return undefined;
  }

  if (job.status === "succeeded" && !job.stored) {
    try {
      await storeOutputs(userId, job);
    } catch (e) {
      // One failure is terminal. Retrying here is what made the open tab download
      // every output again every few seconds, and the cron every minute after that.
      const message = (e as Error).message || "The download failed.";
      console.error(`[fal ${id}]`, message);
      return updateFalJob(userId, id, storeFailureUpdate(message));
    }
    return getFalJob(userId, id);
  }
  return job;
}

/** Succeeded jobs whose files were never saved, past the window where a copy could still work. */
export async function failAbandonedFalCopies(maxAgeMs: number) {
  const now = Date.now();
  const res = await run(
    `UPDATE fal_jobs
     SET data = json_set(data, '$.status', 'failed', '$.error', ?, '$.updatedAt', ?, '$.completedAt', ?)
     WHERE json_extract(data, '$.status') = 'succeeded'
       AND json_extract(data, '$.stored') IS NOT 1
       AND created_at < ?`,
    "Couldn't save the result before the file expired.",
    now,
    now,
    now - maxAgeMs,
  );
  return res.meta.changes;
}
