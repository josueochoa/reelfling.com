// Image generations (the Image tab). ArgoLink's images API is synchronous and can take
// minutes, so jobs run in the background: POST /api/images queues one, the Worker's queue
// consumer runs it (worker.ts → /api/images/run), and the page polls. Results are copied
// into the user's R2 bucket as assets of the generation.

import { all, env, first, run } from "./db";
import { getImageModel, gptSize, type ImageQuality, type ImageResolution } from "./imageModels";
import { getCredentials } from "./keys";
import { normalizeMentions } from "./mentions";
import { argo } from "./providers/argolink";
import { deleteGenerationAssets, getAsset, providerUrl, putAsset } from "./storage";

export type ImageStatus = "queued" | "running" | "succeeded" | "failed";

export interface ImageGeneration {
  id: string;
  model: string;
  /** As written, with "@Image 1" mentions. */
  prompt: string;
  status: ImageStatus;
  /** As picked: a ratio or "auto". */
  ratio: string;
  /** The ratio actually sent, or undefined when the model picks (GPT Image, auto, no reference). */
  aspect?: string;
  resolution: ImageResolution;
  quality?: ImageQuality;
  count: number;
  /** Library keys of the reference images, in order. */
  references: string[];
  images: { key: string; contentType: string }[];
  error?: string;
  /** Estimated USD. */
  cost: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
}

const parse = (row?: { data: string }) => (row ? (JSON.parse(row.data) as ImageGeneration) : undefined);

export async function listImageGenerations(userId: string) {
  const rows = await all<{ data: string }>(
    "SELECT data FROM image_generations WHERE user_id = ? ORDER BY created_at DESC",
    userId,
  );
  return rows.map((r) => parse(r)!);
}

export async function getImageGeneration(userId: string, id: string) {
  return parse(
    await first<{ data: string }>("SELECT data FROM image_generations WHERE id = ? AND user_id = ?", id, userId),
  );
}

export async function insertImageGeneration(userId: string, gen: ImageGeneration) {
  await run(
    "INSERT INTO image_generations (id, user_id, created_at, data) VALUES (?, ?, ?, ?)",
    gen.id,
    userId,
    gen.createdAt,
    JSON.stringify(gen),
  );
}

export async function updateImageGeneration(userId: string, id: string, patch: Partial<ImageGeneration>) {
  const gen = await getImageGeneration(userId, id);
  if (!gen) return undefined;
  const next = { ...gen, ...patch, updatedAt: Date.now() };
  await run("UPDATE image_generations SET data = ? WHERE id = ? AND user_id = ?", JSON.stringify(next), id, userId);
  return next;
}

export async function removeImageGeneration(userId: string, id: string) {
  await deleteGenerationAssets(userId, id);
  await run("DELETE FROM image_generations WHERE id = ? AND user_id = ?", id, userId);
}

/**
 * Moves a queued job to running, exactly once. Queues deliver at least once, and a
 * second run would bill the user twice.
 */
async function claim(userId: string, id: string) {
  const now = Date.now();
  const res = await run(
    `UPDATE image_generations
     SET data = json_set(data, '$.status', 'running', '$.startedAt', ?, '$.updatedAt', ?)
     WHERE id = ? AND user_id = ? AND json_extract(data, '$.status') = 'queued'`,
    now,
    now,
    id,
    userId,
  );
  return res.meta.changes === 1;
}

/** Starts a job: on the queue in production; inline under `next dev`, which has no consumer. */
export async function enqueueImageJob(userId: string, id: string) {
  const queue = env().IMAGE_JOBS;
  if (process.env.NODE_ENV === "development" || !queue) {
    void runImageJob(userId, id).catch((e) => console.error(`[image ${id}]`, e));
    return;
  }
  await queue.send({ userId, id });
}

interface ArgoImages {
  data?: { url?: string; b64_json?: string }[];
}

/** The output image as a response to stream into R2. ArgoLink links are public; fall back to auth. */
async function download(item: { url?: string; b64_json?: string }, apiKey: string): Promise<Response> {
  if (item.b64_json) {
    const bytes = Uint8Array.from(atob(item.b64_json), (c) => c.charCodeAt(0));
    return new Response(bytes, { headers: { "content-type": "image/jpeg", "content-length": String(bytes.length) } });
  }
  if (!item.url) throw new Error("ArgoLink returned an image without data");
  let res = await fetch(item.url);
  if (res.status === 401 || res.status === 403)
    res = await fetch(item.url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`Couldn't download the generated image (${res.status})`);
  return res;
}

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

/** Runs a queued job to completion. Safe to call more than once. */
export async function runImageJob(userId: string, id: string) {
  if (!(await claim(userId, id))) return;
  const gen = (await getImageGeneration(userId, id))!;
  try {
    const model = getImageModel(gen.model);
    if (!model) throw new Error(`Unknown model ${gen.model}`);
    const creds = await getCredentials(userId, "argolink");
    if (!creds) throw new Error("Add your ArgoLink API key under API keys.");

    const references = await Promise.all(
      gen.references.map(async (key) => {
        const asset = await getAsset(userId, key);
        if (!asset) throw new Error("A reference image is no longer in your uploads.");
        return { image_url: await providerUrl(asset) };
      }),
    );
    const body: Record<string, unknown> = {
      model: model.id,
      // "@Image 2" → "image 2": the references are sent in that order.
      prompt: normalizeMentions(gen.prompt, (_, n) => `image ${n}`),
      n: gen.count,
      response_format: "url",
      ...(references.length && { images: references }),
    };
    if (model.brand === "google")
      Object.assign(body, { aspect_ratio: gen.aspect ?? "1:1", resolution: gen.resolution });
    else {
      const size = gen.aspect && gptSize(gen.aspect, gen.resolution);
      Object.assign(body, size && { size }, gen.quality && { quality: gen.quality });
    }

    const result = await argo<ArgoImages>(creds, references.length ? "/v1/images/edits" : "/v1/images/generations", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const items = result.data ?? [];
    if (!items.length) throw new Error("ArgoLink returned no images");

    const images: ImageGeneration["images"] = [];
    for (const [i, item] of items.entries()) {
      const source = await download(item, creds.apiKey);
      const contentType = source.headers.get("content-type")?.split(";")[0] || "image/jpeg";
      const asset = await putAsset(userId, {
        key: `images/${id}/${i}.${EXT[contentType] ?? "jpg"}`,
        source,
        contentType,
        generationId: id,
      });
      images.push({ key: asset.key, contentType });
    }
    await updateImageGeneration(userId, id, { status: "succeeded", images, completedAt: Date.now() });
  } catch (e) {
    console.error(`[image ${id}]`, e);
    await updateImageGeneration(userId, id, {
      status: "failed",
      error: (e as Error).message || "Generation failed",
      completedAt: Date.now(),
    });
  }
}

/** Jobs whose run died (Worker evicted, queue lost): fail them so they don't spin forever. */
export async function failStaleImageJobs() {
  const now = Date.now();
  const res = await run(
    `UPDATE image_generations
     SET data = json_set(data, '$.status', 'failed', '$.error', 'Timed out. Nothing was saved; try again.',
                         '$.completedAt', ?, '$.updatedAt', ?)
     WHERE (json_extract(data, '$.status') = 'running' AND json_extract(data, '$.startedAt') < ?)
        OR (json_extract(data, '$.status') = 'queued' AND created_at < ?)`,
    now,
    now,
    now - 16 * 60 * 1000, // the queue consumer's 15-minute limit, plus a minute
    now - 30 * 60 * 1000,
  );
  return res.meta.changes;
}
