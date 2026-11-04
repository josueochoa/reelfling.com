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
import { getCredentials } from "./keys";
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
import { buildExtendBody, extendForm, runnableExtends } from "./extend";
import { buildLipsyncBody, lipsyncTools } from "./lipsync";
import { lipsyncLimitError } from "./lipsyncQuote";
import { formFor, outputLineage, toolLimitError } from "./registry/tool-forms";
import { continueSequence, ensureStoredVideo, getGeneration } from "./store";
import { prepareToolInput } from "./toolCatalog";
import { upscaleResolution } from "./upscaleQuote";
import { isAssetKey, isUploadRef, uploadKeyOf } from "./uploads";

/** Stored on a fal job when it was started from the Tools menu. */
export interface FalToolJob {
  id: string;
  name: string;
  inputAssetIds: string[];
  params: Record<string, string | number | boolean>;
  route: { provider: "fal"; endpoint: string; mapper: string };
}

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
  /** Set for a catalog tool. Absent on raw endpoint runs. */
  tool?: FalToolJob;
  /** Latest queue position, while fal still has the request. */
  queuePosition?: number;
  /** Set when the job continues a generation. The new asset is this part. */
  sequence?: { sequenceId: string; part: number; sourceGenerationId: string };
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

/** Indexed copies live under `fal/<id>/` and are tagged with this job id. Both go. */
export async function deleteFalFiles(userId: string, id: string) {
  await deleteGenerationAssets(userId, id);
  await deleteAssetsUnder(userId, `fal/${id}/`);
}

export async function removeFalJob(userId: string, id: string) {
  await deleteFalFiles(userId, id);
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
    ...(job.tool && {
      tool: { id: job.tool.id, name: job.tool.name, inputAssetIds: job.tool.inputAssetIds },
    }),
    ...(job.sequence && {
      sequenceId: job.sequence.sequenceId,
      part: job.sequence.part,
      sourceGenerationId: job.sequence.sourceGenerationId,
    }),
    ...(job.queuePosition !== undefined && { queuePosition: job.queuePosition }),
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
export async function createFalJob(
  userId: string,
  endpointId: string,
  input: unknown,
  apiKey: string,
  tool?: FalToolJob,
  sequence?: FalJob["sequence"],
) {
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
    ...(tool && { tool }),
    ...(sequence && { sequence }),
    outputs: [],
    createdAt: now,
    updatedAt: now,
  };
  await insertFalJob(userId, job);
  return job;
}

/** A finished generation whose file was never copied. Extend needs the bytes in the bucket. */
async function storedGenerationVideo(userId: string, key: string) {
  const id = /^videos\/([A-Za-z0-9_-]+)\.mp4$/.exec(key)?.[1];
  if (!id) return undefined;
  const gen = await getGeneration(userId, id);
  if (!gen || gen.status !== "succeeded") return undefined;
  try {
    return await ensureStoredVideo(userId, gen);
  } catch {
    return undefined;
  }
}

/** An extend output continues the same sequence as the job that made it. */
async function extendSourceId(userId: string, generationId: string | null) {
  if (!generationId) return undefined;
  const prior = await getFalJob(userId, generationId);
  return prior?.sequence?.sourceGenerationId ?? generationId;
}

function mediaKind(contentType: string): "image" | "video" | "audio" | undefined {
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("audio/")) return "audio";
  return undefined;
}

/** Duration on the file, or on the generation when a stored video never copied it. */
async function knownDuration(
  userId: string,
  asset: { meta?: { duration?: number } | null; generationId: string | null },
): Promise<number | undefined> {
  const stored = asset.meta?.duration;
  if (typeof stored === "number" && Number.isFinite(stored)) return stored;
  if (!asset.generationId) return undefined;
  const gen = await getGeneration(userId, asset.generationId);
  return typeof gen?.duration === "number" && Number.isFinite(gen.duration) ? gen.duration : undefined;
}

/**
 * Runs a catalog tool on one library asset. The endpoint comes from the catalog,
 * not the client. The new file is written later, with parent_id and tool set.
 */
export async function createToolJob(
  userId: string,
  input: { toolId: string; assetIds: unknown; params: unknown; audioId?: unknown },
  apiKey: string,
) {
  const assetIds = Array.isArray(input.assetIds) ? input.assetIds.filter((id): id is string => typeof id === "string") : [];
  if (assetIds.length !== 1 || !isAssetKey(assetIds[0]))
    throw new ProviderError("Choose one asset from your library.", 400);
  const lipsyncTool = lipsyncTools().find((tool) => tool.id === input.toolId);
  const extendTool = !lipsyncTool ? runnableExtends().find((tool) => tool.id === input.toolId) : undefined;
  const audioId = typeof input.audioId === "string" ? input.audioId : "";
  let audio: Awaited<ReturnType<typeof getAsset>> | undefined;
  if (lipsyncTool) {
    if (!isAssetKey(audioId)) throw new ProviderError("Choose an audio file.", 400);
    audio = await getAsset(userId, audioId);
    if (!audio) throw new ProviderError("That audio is no longer in your library.", 400);
    if (mediaKind(audio.contentType) !== "audio") throw new ProviderError("Lip sync needs an audio file.", 400);
  }
  const audioDuration = audio ? await knownDuration(userId, audio) : undefined;
  const asset =
    (await getAsset(userId, assetIds[0])) ?? (extendTool || lipsyncTool ? await storedGenerationVideo(userId, assetIds[0]) : undefined);
  if (!asset) throw new ProviderError("That asset is no longer in your library.", 400);
  const videoDuration = await knownDuration(userId, asset);
  const prepared = lipsyncTool
    ? {
        tool: lipsyncTool,
        body: buildLipsyncBody(lipsyncTool.id, assetIds[0], audioId, input.params, {
          video: videoDuration,
          audio: audioDuration,
        }),
      }
    : extendTool
      ? { tool: extendTool, body: buildExtendBody(extendTool.id, assetIds[0], input.params) }
      : prepareToolInput(input.toolId, assetIds[0], input.params);
  if (!prepared) throw new ProviderError("Unknown tool", 400);
  if (mediaKind(asset.contentType) !== prepared.tool.accepts)
    throw new ProviderError(prepared.tool.accepts === "image" ? "This tool needs an image." : "This tool needs a video.", 400);
  if (lipsyncTool && audio) {
    const limit = lipsyncLimitError(
      lipsyncTool.id,
      { contentType: asset.contentType, duration: videoDuration },
      { contentType: audio.contentType, duration: audioDuration, bytes: audio.bytes },
      lipsyncTool.name,
    );
    if (limit) throw new ProviderError(limit, 400);
  }
  const form = formFor(prepared.tool.id) ?? extendForm(prepared.tool.id);
  if (form && !lipsyncTool) {
    const limit = toolLimitError(
      form,
      { contentType: asset.contentType, duration: asset.meta?.duration },
      prepared.tool.name,
    );
    if (limit) throw new ProviderError(limit, 400);
  }
  const params = { ...prepared.body };
  delete params[prepared.tool.inputKey];
  if (lipsyncTool?.audioKey) delete params[lipsyncTool.audioKey];
  const sourceId = extendTool ? await extendSourceId(userId, asset.generationId) : undefined;
  const stamp = sourceId ? await continueSequence(userId, sourceId) : undefined;
  return createFalJob(
    userId,
    prepared.tool.endpoint,
    prepared.body,
    apiKey,
    {
      id: prepared.tool.id,
      name: prepared.tool.name,
      inputAssetIds: audio ? [asset.key, audio.key] : [asset.key],
      params: params as Record<string, string | number | boolean>,
      route: { provider: "fal", endpoint: prepared.tool.endpoint, mapper: prepared.tool.mapper },
    },
    stamp && {
      sequenceId: stamp.sequenceId,
      part: stamp.part,
      sourceGenerationId: stamp.sourceGenerationId,
    },
  );
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
    let bytes: number;
    try {
      bytes = outputBytes(source.headers.get("content-length"));
      await assertStorageAvailable(userId, bytes);
    } catch (e) {
      await source.body?.cancel().catch(() => {});
      throw e;
    }
    const contentType = contentTypeOf(file, source.headers.get("content-type"));
    const ext = EXT[contentType] ?? typeFromUrl(file.url)?.split("/")[1] ?? "bin";
    const lineage = outputLineage(job);
    const parent = lineage.parentId ? await getAsset(userId, lineage.parentId) : undefined;
    const size = upscaleResolution(
      job.tool?.params ?? {},
      { width: parent?.meta?.width, height: parent?.meta?.height },
      file.width !== undefined || file.height !== undefined ? { width: file.width, height: file.height } : undefined,
    );
    const asset = await putAsset(userId, {
      key: `fal/${job.id}/${i}.${ext}`,
      source,
      contentType,
      generationId: job.id,
      parentId: lineage.parentId,
      tool: lineage.tool,
      name: lineage.tool ? job.tool?.name : undefined,
      meta: size.resolution ? { width: size.width, height: size.height, resolution: size.resolution } : undefined,
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
      queuePosition: snap.queuePosition,
      ...(done && { completedAt: Date.now(), queuePosition: undefined }),
    });
    if (!job) return undefined;
  }

  if (job.status === "succeeded" && !job.stored) {
    let last: unknown;
    for (let attempt = 1; !storeGaveUp(attempt - 1); attempt++) {
      try {
        await storeOutputs(userId, job);
        return getFalJob(userId, id);
      } catch (e) {
        last = e;
        // One in-process retry. The job stays unpolled either way, so a blip
        // does not start the 4s download loop.
        if (storeGaveUp(attempt)) break;
      }
    }
    const message = (last as Error)?.message || "The download failed.";
    console.error(`[fal ${id}]`, message);
    // Drop partial files (file 1 saved, file 2 failed) so they don't count toward quota.
    await deleteFalFiles(userId, id).catch((e) => console.error(`[fal ${id} cleanup]`, (e as Error).message));
    return updateFalJob(userId, id, storeFailureUpdate(message));
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
