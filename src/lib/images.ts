// Image generations (the Image tab). ArgoLink and OpenRouter's images APIs are synchronous
// and can take minutes, so jobs run in the background: POST /api/images queues one, the
// Worker's queue consumer runs it (worker.ts → /api/images/run), and the page polls.
// Results are copied into the user's R2 bucket as assets of the generation.

import { all, env, first, run } from "./db";
import { downloadGeneratedImage } from "./imageDownload";
import { getCredentials, scrubSecret } from "./keys";
import { normalizeMentions } from "./mentions";
import { argo } from "./providers/argolink";
import { generateOpenRouterImages, openRouterImageFile } from "./providers/openrouter";
import { MAPPERS } from "./registry/mappers";
import type { OpenRouterImageCall } from "./registry/bodies";
import {
  getImageModel,
  mentionSyntax,
  PROVIDER_INFO,
  routeFor,
  type ImageKeyProvider,
  type ImageQuality,
  type ImageResolution,
} from "./registry";
import { byWorkspace, persistJson, wsArgs, type KeySource } from "./scope";
import { creatorsIn, deleteGenerationAssets, getAsset, providerUrl, putAsset } from "./storage";
import type { Creator } from "./uploads";

export type ImageStatus = "queued" | "running" | "succeeded" | "failed";

export interface ImageGeneration {
  id: string;
  /** Which key ran it. Missing on jobs from before OpenRouter (= argolink). */
  provider?: ImageKeyProvider;
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
  /** Estimated USD. Kept for older rows; new rows also set estimatedCost. */
  cost: number;
  keySource?: KeySource;
  /** Provider route used. */
  route?: string;
  routeEndpoint?: string;
  estimatedCost?: number;
  /** Provider-reported USD, when it comes back. */
  reportedCost?: number;
  keyWorkspaceId?: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  createdBy?: string | null;
  creator?: Creator;
}

type Row = { data: string; created_by: string | null };
const parse = (row?: Row) =>
  row ? ({ ...(JSON.parse(row.data) as ImageGeneration), createdBy: row.created_by } as ImageGeneration) : undefined;

export async function listImageGenerations(workspaceId: string) {
  const [rows, creators] = await Promise.all([
    all<Row>(
      `SELECT data, created_by FROM image_generations WHERE ${byWorkspace()} ORDER BY created_at DESC`,
      ...wsArgs(workspaceId),
    ),
    creatorsIn("image_generations", workspaceId),
  ]);
  return rows.map((r) => ({ ...parse(r)!, creator: (r.created_by && creators.get(r.created_by)) || undefined }));
}

export async function getImageGeneration(workspaceId: string, id: string) {
  return parse(
    await first<Row>(
      `SELECT data, created_by FROM image_generations WHERE id = ? AND ${byWorkspace()}`,
      id,
      ...wsArgs(workspaceId),
    ),
  );
}

export async function insertImageGeneration(workspaceId: string, gen: ImageGeneration, createdBy: string) {
  await run(
    "INSERT INTO image_generations (id, user_id, workspace_id, created_by, created_at, data, route) VALUES (?, ?, ?, ?, ?, ?, ?)",
    gen.id,
    createdBy,
    workspaceId,
    createdBy,
    gen.createdAt,
    persistJson(gen),
    gen.route ?? null,
  );
}

export async function updateImageGeneration(workspaceId: string, id: string, patch: Partial<ImageGeneration>) {
  const gen = await getImageGeneration(workspaceId, id);
  if (!gen) return undefined;
  const next = { ...gen, ...patch, updatedAt: Date.now() };
  await run(
    `UPDATE image_generations SET data = ? WHERE id = ? AND ${byWorkspace()}`,
    persistJson(next),
    id,
    ...wsArgs(workspaceId),
  );
  return next;
}

export async function removeImageGeneration(workspaceId: string, id: string) {
  await deleteGenerationAssets(workspaceId, id);
  await run(`DELETE FROM image_generations WHERE id = ? AND ${byWorkspace()}`, id, ...wsArgs(workspaceId));
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
     WHERE id = ? AND ${byWorkspace()} AND json_extract(data, '$.status') = 'queued'`,
    now,
    now,
    id,
    ...wsArgs(workspaceId),
  );
  return res.meta.changes === 1;
}

/** Starts a job: on the queue in production; inline under `next dev`, which has no consumer. */
export async function enqueueImageJob(workspaceId: string, userId: string, id: string) {
  const queue = env().IMAGE_JOBS;
  if (process.env.NODE_ENV === "development" || !queue) {
    void runImageJob(workspaceId, id).catch((e) => console.error(`[image ${id}]`, (e as Error).message));
    return;
  }
  await queue.send({ userId, workspaceId, id });
}

interface ArgoImages {
  data?: { url?: string; b64_json?: string }[];
  usage?: { cost?: number };
}

const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** Runs a queued job to completion. Safe to call more than once. */
export async function runImageJob(workspaceId: string, id: string) {
  if (!(await claim(workspaceId, id))) return;
  const gen = (await getImageGeneration(workspaceId, id))!;
  let apiKey = "";
  try {
    const model = getImageModel(gen.model);
    if (!model) throw new Error(`Unknown model ${gen.model}`);
    const provider = gen.provider ?? "argolink";
    const route = routeFor(model, provider);
    if (!route) throw new Error(`${model.name} has no ${PROVIDER_INFO[provider].label} route`);
    const creds = await getCredentials(gen.keyWorkspaceId || workspaceId, provider);
    if (!creds) throw new Error(`Add your ${PROVIDER_INFO[provider].label} API key under API keys.`);
    apiKey = creds.apiKey;

    const references = await Promise.all(
      gen.references.map(async (key) => {
        const asset = await getAsset(workspaceId, key);
        if (!asset) throw new Error("A reference image is no longer in your uploads.");
        return { image_url: await providerUrl(asset) };
      }),
    );
    const map = MAPPERS[route.mapper];
    if (!map) throw new Error(`${model.name} has no input mapper`);
    const mapped = map(
      {
        kind: "image",
        request: {
          prompt: normalizeMentions(gen.prompt, mentionSyntax(model.refSyntax)),
          aspect: gen.aspect,
          resolution: gen.resolution,
          quality: gen.quality,
          count: gen.count,
          ...(references.length && { images: references }),
        },
      },
      { endpoint: route.endpoint },
    );

    let reported: number | undefined;
    const items =
      provider === "openrouter"
        ? await generateOpenRouterImages(creds.apiKey, mapped as OpenRouterImageCall).then((result) => {
            reported = result.costUsd;
            return result.items;
          })
        : await argo<ArgoImages>(creds, (mapped as { path: string }).path, {
            method: "POST",
            body: JSON.stringify((mapped as { body: unknown }).body),
          }).then((body) => {
            reported = body.usage?.cost;
            return body.data ?? [];
          });
    if (!items.length) throw new Error(`${PROVIDER_INFO[provider].label} returned no images`);

    const images: ImageGeneration["images"] = [];
    for (const [i, item] of items.entries()) {
      const source =
        provider === "openrouter" ? await openRouterImageFile(creds.apiKey, item) : await downloadGeneratedImage(item);
      const contentType = source.headers.get("content-type")?.split(";")[0] || "image/jpeg";
      const asset = await putAsset(workspaceId, {
        key: `images/${id}/${i}.${EXT[contentType] ?? "jpg"}`,
        source,
        contentType,
        generationId: id,
        createdBy: gen.createdBy,
      });
      images.push({ key: asset.key, contentType });
    }
    await updateImageGeneration(workspaceId, id, {
      status: "succeeded",
      images,
      ...(reported !== undefined ? { reportedCost: reported } : {}),
      completedAt: Date.now(),
    });
  } catch (e) {
    const message = scrubSecret((e as Error).message, apiKey) || "Generation failed";
    console.error(`[image ${id}]`, message);
    await updateImageGeneration(workspaceId, id, {
      status: "failed",
      error: message,
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
