// Generic fal jobs. One row per queue request: the endpoint id, the JSON sent, the JSON
// fal returned, and the files copied into the user's bucket. The API key is never stored
// on the row (see redactSecrets).

import {
  shouldCancelFal,
  storeFailureUpdate,
  storeGaveUp,
  type FalFieldError,
  type FalJobStatus,
  type FalJobView,
} from "./falTypes";
import { all, first, run } from "./db";
import { mockProviders } from "./providers/mock";
import { getCredentials, scrubSecret } from "./keys";
import { reportedUsd } from "./reportedCost";
import { byWorkspace, persistJson, wsArgs, type KeySource } from "./scope";
import { creatorsIn } from "./storage";
import type { Creator } from "./uploads";
import {
  cancelFal,
  collectOutputs,
  fetchFalOutput,
  outputBytes,
  pollFal,
  redactSecrets,
  submitFal,
  type FalOutput,
} from "./providers/fal";
import { ProviderError } from "./providers/types";
import {
  assertStorageAvailable,
  deleteAssetsUnder,
  deleteGenerationAssets,
  getAsset,
  providerUrl,
  putAsset,
} from "./storage";
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
  keySource?: KeySource;
  route?: string;
  estimatedCost?: number;
  reportedCost?: number;
  keyWorkspaceId?: string;
  createdBy?: string | null;
  creator?: Creator;
}

type Row = { data: string; created_by: string | null };
const parse = (row?: Row) =>
  row ? ({ ...(JSON.parse(row.data) as FalJob), createdBy: row.created_by } as FalJob) : undefined;

export async function listFalJobs(workspaceId: string) {
  const [rows, creators] = await Promise.all([
    all<Row>(`SELECT data, created_by FROM fal_jobs WHERE ${byWorkspace()} ORDER BY created_at DESC`, ...wsArgs(workspaceId)),
    creatorsIn("fal_jobs", workspaceId),
  ]);
  return rows.map((row) => ({ ...parse(row)!, creator: (row.created_by && creators.get(row.created_by)) || undefined }));
}

export async function getFalJob(workspaceId: string, id: string) {
  return parse(
    await first<Row>(`SELECT data, created_by FROM fal_jobs WHERE id = ? AND ${byWorkspace()}`, id, ...wsArgs(workspaceId)),
  );
}

export async function insertFalJob(workspaceId: string, job: FalJob, createdBy: string) {
  await run(
    "INSERT INTO fal_jobs (id, user_id, workspace_id, created_by, created_at, data) VALUES (?, ?, ?, ?, ?, ?)",
    job.id,
    createdBy,
    workspaceId,
    createdBy,
    job.createdAt,
    persistJson(job),
  );
}

export async function updateFalJob(workspaceId: string, id: string, patch: Partial<FalJob>) {
  const job = await getFalJob(workspaceId, id);
  if (!job) return undefined;
  const next = { ...job, ...patch, updatedAt: Date.now() };
  await run(
    `UPDATE fal_jobs SET data = ? WHERE id = ? AND ${byWorkspace()}`,
    persistJson(next),
    id,
    ...wsArgs(workspaceId),
  );
  return next;
}

/** Indexed copies live under `fal/<id>/` and are tagged with this job id. Both go. */
export async function deleteFalFiles(workspaceId: string, id: string) {
  await deleteGenerationAssets(workspaceId, id);
  await deleteAssetsUnder(workspaceId, `fal/${id}/`);
}

export async function removeFalJob(workspaceId: string, id: string) {
  await deleteFalFiles(workspaceId, id);
  await run(`DELETE FROM fal_jobs WHERE id = ? AND ${byWorkspace()}`, id, ...wsArgs(workspaceId));
}

/** Still in flight, or finished but not yet copied into the bucket. */
export async function unfinishedFalJobs(limit: number, maxAgeMs: number) {
  return all<{ id: string; workspace_id: string }>(
    `SELECT id, COALESCE(workspace_id, user_id) AS workspace_id FROM fal_jobs
     WHERE created_at > ?
       AND (json_extract(data, '$.status') IN ('queued', 'running')
            OR (json_extract(data, '$.status') = 'succeeded' AND json_extract(data, '$.stored') IS NOT 1))
     ORDER BY created_at LIMIT ?`,
    Date.now() - maxAgeMs,
    limit,
  );
}

/** Best-effort cancel of a queued or running request. Finished jobs are only removed locally. */
export async function cancelFalJob(workspaceId: string, job: FalJob) {
  if (!shouldCancelFal(job.status)) return;
  const creds = await getCredentials(job.keyWorkspaceId || workspaceId, "fal").catch(() => undefined);
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
    ...(job.creator ? { creator: job.creator } : {}),
    ...(job.keySource ? { keySource: job.keySource } : {}),
  };
}

/** Replaces `upload:<key>` strings with signed R2 URLs fal can download. */
export async function resolveFalInput(workspaceId: string, input: unknown): Promise<unknown> {
  if (typeof input === "string") {
    if (!isUploadRef(input)) return input;
    const key = uploadKeyOf(input);
    const asset = isAssetKey(key) ? await getAsset(workspaceId, key) : undefined;
    if (!asset)
      throw Object.assign(new Error("A reference is no longer in your uploads. Remove it and add it again."), {
        status: 400,
      });
    return providerUrl(asset);
  }
  if (Array.isArray(input)) return Promise.all(input.map((item) => resolveFalInput(workspaceId, item)));
  if (input && typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) out[key] = await resolveFalInput(workspaceId, value);
    return out;
  }
  return input;
}

function assertNoSecret(value: unknown, secret: string) {
  if (secret && JSON.stringify(value).includes(secret))
    throw new ProviderError("Refusing to store a fal payload that contains the API key", 500);
}

/** Submits to fal and records the job. A 422 is thrown and nothing is stored. */
export async function createFalJob(
  workspaceId: string,
  endpointId: string,
  input: unknown,
  apiKey: string,
  createdBy: string,
  extra: Pick<FalJob, "keySource" | "keyWorkspaceId" | "estimatedCost" | "route"> = {},
) {
  const resolved = await resolveFalInput(workspaceId, input);
  const request = redactSecrets(resolved, apiKey);
  assertNoSecret(request, apiKey);
  if (mockProviders()) {
    const now = Date.now();
    const id = crypto.randomUUID();
    const job: FalJob = {
      id,
      endpointId: endpointId.trim().replace(/^\/+|\/+$/g, ""),
      status: "queued",
      requestId: `mock-${id}`,
      statusUrl: "https://queue.fal.run/mock/status",
      responseUrl: "https://queue.fal.run/mock/response",
      cancelUrl: "https://queue.fal.run/mock/cancel",
      request,
      outputs: [],
      createdAt: now,
      updatedAt: now,
      ...extra,
    };
    await insertFalJob(workspaceId, job, createdBy);
    return job;
  }
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
    ...extra,
  };
  await insertFalJob(workspaceId, job, createdBy);
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
async function storeOutputs(workspaceId: string, job: FalJob) {
  const files = collectOutputs(job.response);
  const outputs: FalJob["outputs"] = [];
  for (const [i, file] of files.entries()) {
    const source = await fetchFalOutput(file.url);
    let bytes: number;
    try {
      bytes = outputBytes(source.headers.get("content-length"));
      await assertStorageAvailable(workspaceId, bytes);
    } catch (e) {
      await source.body?.cancel().catch(() => {});
      throw e;
    }
    const contentType = contentTypeOf(file, source.headers.get("content-type"));
    const ext = EXT[contentType] ?? typeFromUrl(file.url)?.split("/")[1] ?? "bin";
    const asset = await putAsset(workspaceId, {
      key: `fal/${job.id}/${i}.${ext}`,
      source,
      contentType,
      generationId: job.id,
      createdBy: job.createdBy,
    });
    outputs.push({ key: asset.key, contentType });
  }
  await updateFalJob(workspaceId, job.id, { outputs, stored: true, error: undefined });
}

/** Pulls the latest queue state and, once it succeeds, copies outputs into R2. */
export async function syncFalJob(workspaceId: string, id: string): Promise<FalJob | undefined> {
  let job = await getFalJob(workspaceId, id);
  if (!job) return undefined;

  if ((job.status === "queued" || job.status === "running") && !job.requestId.startsWith("mock-")) {
    const creds = await getCredentials(job.keyWorkspaceId || workspaceId, "fal");
    if (!creds) throw new ProviderError("Add your fal API key under API keys.", 400);
    const snap = await pollFal(creds.apiKey, { statusUrl: job.statusUrl, responseUrl: job.responseUrl });
    assertNoSecret(snap.response, creds.apiKey);
    const done = snap.status === "succeeded" || snap.status === "failed";
    const reported = reportedUsd(snap.response);
    job = await updateFalJob(workspaceId, id, {
      status: snap.status,
      response: snap.response,
      error: snap.error ? scrubSecret(snap.error, creds.apiKey) : snap.error,
      fields: snap.fields,
      ...(reported !== undefined ? { reportedCost: reported } : {}),
      ...(done && { completedAt: Date.now() }),
    });
    if (!job) return undefined;
  }

  if (job.status === "succeeded" && !job.stored) {
    let last: unknown;
    for (let attempt = 1; !storeGaveUp(attempt - 1); attempt++) {
      try {
        await storeOutputs(workspaceId, job);
        return getFalJob(workspaceId, id);
      } catch (e) {
        last = e;
        // One in-process retry. The job stays unpolled either way, so a blip
        // does not start the 4s download loop.
        if (storeGaveUp(attempt)) break;
      }
    }
    const message = scrubSecret((last as Error)?.message || "The download failed.", undefined);
    console.error(`[fal ${id}]`, message);
    // Drop partial files (file 1 saved, file 2 failed) so they don't count toward quota.
    await deleteFalFiles(workspaceId, id).catch((e) => console.error(`[fal ${id} cleanup]`, (e as Error).message));
    return updateFalJob(workspaceId, id, storeFailureUpdate(message));
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
