// Image generations (the Image tab). The images APIs (ArgoLink, OpenRouter) are synchronous
// and can take minutes, so jobs run in the background: POST /api/images queues one, the Worker's queue
// consumer runs it (worker.ts → /api/images/run), and the page polls. Results are copied
// into the user's R2 bucket as assets of the generation.

import { all, env, first, run } from "./db";
import {
  getImageModel,
  gptSize,
  type ImageModelSpec,
  type ImageProviderId,
  type ImageQuality,
  type ImageResolution,
} from "./imageModels";
import { getCredentials, type ProviderCredentials } from "./keys";
import { normalizeMentions } from "./mentions";
import { PROVIDER_INFO } from "./models";
import { argo } from "./providers/argolink";
import { openRouter } from "./providers/openrouter";
import { creatorsIn, deleteGenerationAssets, getAsset, providerUrl, putAsset } from "./storage";
import type { Creator } from "./uploads";

export type ImageStatus = "queued" | "running" | "succeeded" | "failed";

export interface ImageGeneration {
  id: string;
  /** Missing on jobs from before OpenRouter (= argolink). */
  provider?: ImageProviderId;
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
  /** USD the provider billed, when it reports it (OpenRouter). */
  billedCost?: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  /** User who started it (from its own column). */
  createdBy?: string | null;
  /** Their profile, on lists. */
  creator?: Creator;
}

type Row = { data: string; created_by: string | null };
const parse = (row?: Row) =>
  row ? ({ ...(JSON.parse(row.data) as ImageGeneration), createdBy: row.created_by } as ImageGeneration) : undefined;
/** Who made it lives in its own column, not in the JSON. */
const toJson = (gen: ImageGeneration) =>
  JSON.stringify(gen, (k, v) => (k === "createdBy" || k === "creator" ? undefined : v));

export async function listImageGenerations(workspaceId: string) {
  const [rows, creators] = await Promise.all([
    all<Row>(
      "SELECT data, created_by FROM image_generations WHERE workspace_id = ? ORDER BY created_at DESC",
      workspaceId,
    ),
    creatorsIn("image_generations", workspaceId),
  ]);
  return rows.map((r) => ({ ...parse(r)!, creator: (r.created_by && creators.get(r.created_by)) || undefined }));
}

export async function getImageGeneration(workspaceId: string, id: string) {
  return parse(
    await first<Row>(
      "SELECT data, created_by FROM image_generations WHERE id = ? AND workspace_id = ?",
      id,
      workspaceId,
    ),
  );
}

export async function insertImageGeneration(workspaceId: string, gen: ImageGeneration, createdBy: string) {
  await run(
    "INSERT INTO image_generations (id, workspace_id, created_by, created_at, data) VALUES (?, ?, ?, ?, ?)",
    gen.id,
    workspaceId,
    createdBy,
    gen.createdAt,
    toJson(gen),
  );
}

export async function updateImageGeneration(workspaceId: string, id: string, patch: Partial<ImageGeneration>) {
  const gen = await getImageGeneration(workspaceId, id);
  if (!gen) return undefined;
  const next = { ...gen, ...patch, updatedAt: Date.now() };
  await run("UPDATE image_generations SET data = ? WHERE id = ? AND workspace_id = ?", toJson(next), id, workspaceId);
  return next;
}

export async function removeImageGeneration(workspaceId: string, id: string) {
  await deleteGenerationAssets(workspaceId, id);
  await run("DELETE FROM image_generations WHERE id = ? AND workspace_id = ?", id, workspaceId);
}

/**
 * Moves a queued job to running, exactly once. Queues deliver at least once, and a
 * second run would bill the user twice.
 */
async function claim(workspaceId: string, id: string) {
  const now = Date.now();
  const res = await run(
    `UPDATE image_generations
     SET data = json_set(data, '$.status', 'running', '$.startedAt', ?, '$.updatedAt', ?)
     WHERE id = ? AND workspace_id = ? AND json_extract(data, '$.status') = 'queued'`,
    now,
    now,
    id,
    workspaceId,
  );
  return res.meta.changes === 1;
}

/** Starts a job: on the queue in production; inline under `next dev`, which has no consumer. */
export async function enqueueImageJob(workspaceId: string, id: string) {
  const queue = env().IMAGE_JOBS;
  if (process.env.NODE_ENV === "development" || !queue) {
    void runImageJob(workspaceId, id).catch((e) => console.error(`[image ${id}]`, e));
    return;
  }
  await queue.send({ workspaceId, id });
}

interface ImageItem {
  url?: string;
  b64_json?: string;
  media_type?: string;
}

/** The output image as a response to stream into R2. ArgoLink links are public; fall back to auth. */
async function download(item: ImageItem, apiKey: string): Promise<Response> {
  if (item.b64_json) {
    const bytes = Uint8Array.from(atob(item.b64_json), (c) => c.charCodeAt(0));
    return new Response(bytes, {
      headers: { "content-type": item.media_type || "image/jpeg", "content-length": String(bytes.length) },
    });
  }
  if (!item.url) throw new Error("The provider returned an image without data");
  let res = await fetch(item.url);
  if (res.status === 401 || res.status === 403)
    res = await fetch(item.url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`Couldn't download the generated image (${res.status})`);
  return res;
}

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

type Generated = { items: ImageItem[]; billedCost?: number };

async function viaArgoLink(
  creds: ProviderCredentials,
  model: ImageModelSpec,
  gen: ImageGeneration,
  prompt: string,
  references: string[],
): Promise<Generated> {
  const body: Record<string, unknown> = {
    model: model.id,
    prompt,
    n: gen.count,
    response_format: "url",
    ...(references.length && { images: references.map((image_url) => ({ image_url })) }),
  };
  if (model.brand === "google") Object.assign(body, { aspect_ratio: gen.aspect ?? "1:1", resolution: gen.resolution });
  else {
    const size = gen.aspect && gptSize(gen.aspect, gen.resolution);
    Object.assign(body, size && { size }, gen.quality && { quality: gen.quality });
  }
  const result = await argo<{ data?: ImageItem[] }>(
    creds,
    references.length ? "/v1/images/edits" : "/v1/images/generations",
    { method: "POST", body: JSON.stringify(body) },
  );
  return { items: result.data ?? [] };
}

async function viaOpenRouter(
  creds: ProviderCredentials,
  model: ImageModelSpec,
  gen: ImageGeneration,
  prompt: string,
  references: string[],
): Promise<Generated> {
  const body = {
    model: model.openRouterId,
    prompt,
    aspect_ratio: gen.aspect ?? "auto",
    resolution: gen.resolution.toUpperCase(),
    ...(gen.quality && { quality: gen.quality }),
    ...(references.length && {
      input_references: references.map((url) => ({ type: "image_url", image_url: { url } })),
    }),
  };
  type Result = { data?: ImageItem[]; usage?: { cost?: number } };
  const call = (n: number) =>
    openRouter<Result>(creds, "/images", { method: "POST", body: JSON.stringify({ ...body, n }) });
  // Nano Banana makes one image per request on OpenRouter. Keep the ones that worked: they're paid for.
  const settled =
    model.brand === "google"
      ? await Promise.allSettled(Array.from({ length: gen.count }, () => call(1)))
      : [await call(gen.count)].map((value) => ({ status: "fulfilled" as const, value }));
  const results = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  if (!results.length) throw (settled[0] as PromiseRejectedResult).reason;
  const costs = results.map((r) => r.usage?.cost).filter((c): c is number => typeof c === "number");
  return {
    items: results.flatMap((r) => r.data ?? []),
    billedCost: costs.length === results.length ? costs.reduce((a, b) => a + b, 0) : undefined,
  };
}

/** Runs a queued job to completion. Safe to call more than once. */
export async function runImageJob(workspaceId: string, id: string) {
  if (!(await claim(workspaceId, id))) return;
  const gen = (await getImageGeneration(workspaceId, id))!;
  try {
    const model = getImageModel(gen.model);
    if (!model) throw new Error(`Unknown model ${gen.model}`);
    const provider = gen.provider ?? "argolink";
    const creds = await getCredentials(workspaceId, provider);
    if (!creds) throw new Error(`Add a ${PROVIDER_INFO[provider].label} API key under API keys.`);

    const references = await Promise.all(
      gen.references.map(async (key) => {
        const asset = await getAsset(workspaceId, key);
        if (!asset) throw new Error("A reference image is no longer in your uploads.");
        return providerUrl(asset);
      }),
    );
    // "@Image 2" → "image 2": the references are sent in that order.
    const prompt = normalizeMentions(gen.prompt, (_, n) => `image ${n}`);
    const { items, billedCost } = await (provider === "openrouter" ? viaOpenRouter : viaArgoLink)(
      creds,
      model,
      gen,
      prompt,
      references,
    );
    if (!items.length) throw new Error(`${PROVIDER_INFO[provider].label} returned no images`);

    const images: ImageGeneration["images"] = [];
    for (const [i, item] of items.entries()) {
      const source = await download(item, creds.apiKey);
      const contentType = source.headers.get("content-type")?.split(";")[0] || "image/jpeg";
      const asset = await putAsset(workspaceId, {
        createdBy: gen.createdBy,
        key: `images/${id}/${i}.${EXT[contentType] ?? "jpg"}`,
        source,
        contentType,
        generationId: id,
      });
      images.push({ key: asset.key, contentType });
    }
    await updateImageGeneration(workspaceId, id, { status: "succeeded", images, billedCost, completedAt: Date.now() });
  } catch (e) {
    console.error(`[image ${id}]`, e);
    await updateImageGeneration(workspaceId, id, {
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
