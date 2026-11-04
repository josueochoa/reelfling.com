// Image generations (the Image tab). ArgoLink and OpenRouter's images APIs are synchronous
// and can take minutes, so jobs run in the background: POST /api/images queues one, the
// Worker's queue consumer runs it (worker.ts → /api/images/run), and the page polls.
// Results are copied into the user's R2 bucket as assets of the generation.

import { all, env, first, run } from "./db";
import { downloadGeneratedImage } from "./imageDownload";
import { getCredentials } from "./keys";
import { normalizeMentions } from "./mentions";
import { argo } from "./providers/argolink";
import { falImageInput, fetchFalOutput, pollFal, submitFal } from "./providers/fal";
import { generateOpenRouterImages, openRouterImageFile } from "./providers/openrouter";
import { MAPPERS } from "./registry/mappers";
import type { OpenRouterImageCall } from "./registry/bodies";
import {
  getImageModel,
  mentionSyntax,
  PROVIDER_INFO,
  routeFor,
  type ImageQuality,
  type ImageResolution,
} from "./registry";
import { catalogModel } from "./registry/generated";
import { isImage } from "./registry/types";
import { deleteGenerationAssets, getAsset, providerUrl, putAsset } from "./storage";

export type ImageStatus = "queued" | "running" | "succeeded" | "failed";

export interface ImageGeneration {
  id: string;
  /** Which key ran it. Missing on jobs from before OpenRouter (= argolink). */
  provider?: "argolink" | "openrouter" | "fal";
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
  /** Provider route used. */
  route?: string;
  routeEndpoint?: string;
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
    "INSERT INTO image_generations (id, user_id, created_at, data, route) VALUES (?, ?, ?, ?, ?)",
    gen.id,
    userId,
    gen.createdAt,
    JSON.stringify(gen),
    gen.route ?? null,
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

const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** Runs a queued job to completion. Safe to call more than once. */
export async function runImageJob(userId: string, id: string) {
  if (!(await claim(userId, id))) return;
  const gen = (await getImageGeneration(userId, id))!;
  let apiKey = "";
  try {
    const found = catalogModel(gen.model) ?? getImageModel(gen.model);
    const model = found && isImage(found) ? found : undefined;
    if (!model) throw new Error(`Unknown model ${gen.model}`);
    const provider = gen.provider ?? "argolink";
    const route = routeFor(model, provider);
    if (!route) throw new Error(`${model.name} has no ${PROVIDER_INFO[provider].label} route`);
    const creds = await getCredentials(userId, provider);
    if (!creds) throw new Error(`Add your ${PROVIDER_INFO[provider].label} API key under API keys.`);
    apiKey = creds.apiKey;

    const references = await Promise.all(
      gen.references.map(async (key) => {
        const asset = await getAsset(userId, key);
        if (!asset) throw new Error("A reference image is no longer in your uploads.");
        return { image_url: await providerUrl(asset) };
      }),
    );
    const prompt = normalizeMentions(gen.prompt, mentionSyntax(model.refSyntax));
    const items =
      provider === "fal"
        ? await falImageFiles(
            creds.apiKey,
            route.endpoint,
            falImageInput(
              {
                prompt,
                ratio: gen.aspect,
                resolution: gen.resolution,
                quality: gen.quality,
                count: gen.count,
                images: references.map((item) => item.image_url),
              },
              model.inputs ?? {},
            ),
          )
        : await mappedImages(provider, creds, model.name, route, {
            prompt,
            aspect: gen.aspect,
            resolution: gen.resolution,
            quality: gen.quality,
            count: gen.count,
            ...(references.length && { images: references }),
          });
    if (!items.length) throw new Error(`${PROVIDER_INFO[provider].label} returned no images`);

    const images: ImageGeneration["images"] = [];
    for (const [i, item] of items.entries()) {
      const source =
        provider === "fal" && item.url
          ? await fetchFalOutput(item.url)
          : provider === "openrouter"
            ? await openRouterImageFile(creds.apiKey, item)
            : await downloadGeneratedImage(item);
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
    const message = (apiKey ? (e as Error).message.split(apiKey).join("[redacted]") : (e as Error).message) || "Generation failed";
    console.error(`[image ${id}]`, message);
    await updateImageGeneration(userId, id, {
      status: "failed",
      error: message,
      completedAt: Date.now(),
    });
  }
}

const FAL_IMAGE_LIMIT_MS = 14 * 60 * 1000;

/** Submits one fal image job and polls until the queue finishes. The key stays on fal hosts. */
async function falImageFiles(apiKey: string, endpoint: string, input: unknown) {
  const submitted = await submitFal(apiKey, endpoint, input);
  const deadline = Date.now() + FAL_IMAGE_LIMIT_MS;
  for (;;) {
    const snap = await pollFal(apiKey, submitted);
    if (snap.status === "succeeded") return snap.outputs.map((output) => ({ url: output.url }));
    if (snap.status === "failed") throw new Error(snap.error || "fal image generation failed");
    if (Date.now() > deadline) throw new Error("fal image generation timed out");
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

async function mappedImages(
  provider: string,
  creds: { apiKey: string; baseUrl?: string },
  name: string,
  route: { mapper: keyof typeof MAPPERS | string; endpoint: string },
  request: {
    prompt: string;
    aspect?: string;
    resolution: ImageGeneration["resolution"];
    quality?: ImageGeneration["quality"];
    count: number;
    images?: { image_url: string }[];
  },
) {
  const map = MAPPERS[route.mapper as keyof typeof MAPPERS];
  if (!map) throw new Error(`${name} has no input mapper`);
  const mapped = map({ kind: "image", request }, { endpoint: route.endpoint });
  if (provider === "openrouter") return generateOpenRouterImages(creds.apiKey, mapped as OpenRouterImageCall);
  const body = await argo<ArgoImages>(creds, (mapped as { path: string }).path, {
    method: "POST",
    body: JSON.stringify((mapped as { body: unknown }).body),
  });
  return body.data ?? [];
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
