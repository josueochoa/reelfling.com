// The connector's tools. Each one acts as the signed-in user through the app's own routes
// (see app.ts), so it sees exactly what that person sees in ReelFling.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { availabilityFor, routeProviders } from "@/lib/registry/availability";
import { catalogImageModels, catalogPickerModels } from "@/lib/registry/generated";
import { imageModels, isVideo, MODELS } from "@/lib/registry";
import type { ImageModel, VideoModel } from "@/lib/registry/types";
import type { Generation } from "@/lib/types";
import type { ImageGeneration } from "@/lib/images";
import type { AssetItem } from "@/lib/uploads";
import { UPLOAD_RULES, uploadKindOf } from "@/lib/uploads";
import { AppError, appOrigin, type AppClient, type ConnectorEnv } from "./app";
import {
  claimQuote,
  DAILY_CAP_USD,
  QUOTE_TTL_MS,
  readQuote,
  recordJob,
  releaseClaim,
  saveQuote,
  spentToday,
  type QuoteKind,
} from "./spend";

export const SCOPE_READ = "read";
export const SCOPE_GENERATE = "generate";

export interface Caller {
  userId: string;
  clientId: string;
  scope: readonly string[];
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const text = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});
const failure = (message: string): ToolResult => ({ content: [{ type: "text", text: message }], isError: true });

/** Route errors are written for people, so they go to Claude as they are. */
async function guarded(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof AppError) return failure(e.message);
    console.error("connector tool", e);
    return failure("Something went wrong in ReelFling. Try again.");
  }
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const SPENDS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

function videoModels(): VideoModel[] {
  const hand = MODELS.filter(isVideo);
  return [...hand, ...catalogPickerModels().filter((model) => !hand.some((item) => item.id === model.id))];
}

function allImageModels(): ImageModel[] {
  const hand = imageModels();
  return [...hand, ...catalogImageModels().filter((model) => !hand.some((item) => item.id === model.id))];
}

const clip = (value: string, max = 160) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

/** A short-lived signed link to one of the user's files, from the app's own redirect. */
async function fileLink(app: AppClient, key: string): Promise<string | undefined> {
  const res = await app.response(`/api/assets/file?key=${encodeURIComponent(key)}&download`);
  return res.status >= 300 && res.status < 400 ? (res.headers.get("location") ?? undefined) : undefined;
}

const upload = (key: string) => `upload:${key}`;

export function connectorServer(app: AppClient, env: ConnectorEnv, caller: Caller): McpServer {
  const server = new McpServer(
    { name: "reelfling", title: "ReelFling", version: "1.0.0" },
    {
      instructions:
        "ReelFling makes AI videos and images with the user's own provider keys, and keeps them in the user's ReelFling library. " +
        "Every paid run is two steps: quote_video or quote_image prices the exact request, you show the user the cost, " +
        "then start_generation runs it with the quote id. Jobs take from seconds to several minutes; check them with get_job. " +
        "Files Claude can see in the chat are not visible here: add media with upload_from_url, or ask the user to upload in ReelFling, " +
        "then use the asset keys from search_assets.",
    },
  );

  const canGenerate = caller.scope.includes(SCOPE_GENERATE);
  const readOnlyConnection = () =>
    failure("This connection is read-only. Remove ReelFling in Claude's connector settings and connect it again with generating allowed.");

  server.registerTool(
    "account",
    {
      title: "Account",
      description: "Who is signed in, storage used, which provider keys are set, and this connection's spending today.",
      annotations: READ_ONLY,
    },
    () =>
      guarded(async () => {
        const me = await app.json<{
          user: { email: string; name: string | null };
          keys: { provider: string }[];
          storage: { bytes: number; quotaBytes: number };
          teammates: number;
        }>("/api/me");
        const gb = (bytes: number) => Math.round((bytes / 1e9) * 100) / 100;
        return text({
          email: me.user.email,
          name: me.user.name,
          storage_gb: { used: gb(me.storage.bytes), quota: gb(me.storage.quotaBytes) },
          provider_keys: me.keys.map((key) => key.provider),
          teammates: me.teammates,
          connection: {
            can_generate: canGenerate,
            spent_last_24h_usd: Math.round((await spentToday(env, caller.userId, caller.clientId)) * 100) / 100,
            daily_limit_usd: DAILY_CAP_USD,
          },
          app: appOrigin(env),
        });
      }),
  );

  server.registerTool(
    "list_models",
    {
      title: "List models",
      description:
        "Video and image models, with what each accepts and whether the user's keys can run it. " +
        "Use a model's id in quote_video or quote_image.",
      inputSchema: { kind: z.enum(["video", "image"]).describe("Which models to list") },
      annotations: READ_ONLY,
    },
    ({ kind }) =>
      guarded(async () => {
        const me = await app.json<{ keys: { provider: string }[] }>("/api/me");
        const keyed = new Set(me.keys.map((key) => key.provider));
        const availability = (routes: readonly { provider: string }[]) => {
          const gate = availabilityFor(routeProviders(routes), keyed);
          return gate.available ? { available: true } : { available: false, needs_key: gate.needs };
        };
        if (kind === "video")
          return text(
            videoModels().map((model) => ({
              id: model.id,
              name: model.name,
              description: clip(model.description),
              ...availability(model.routes),
              routes: model.routes.map((route) => route.provider),
              ratios: model.capabilities.ratios,
              resolutions: model.capabilities.resolutions,
              duration_s: model.capabilities.durations,
              audio: model.capabilities.audio,
              frames: model.capabilities.frames,
              references: model.capabilities.references,
              mentions: model.refSyntax === "at" ? "@image1, @video1, @audio1" : "plain words",
            })),
          );
        return text(
          allImageModels().map((model) => ({
            id: model.id,
            name: model.name,
            description: clip(model.description),
            ...availability(model.routes),
            routes: model.routes.map((route) => route.provider),
            ratios: model.capabilities.ratios,
            resolutions: model.capabilities.resolutions,
            qualities: model.capabilities.qualities,
            max_images: model.capabilities.maxImages,
            reference_images: model.capabilities.references.image,
          })),
        );
      }),
  );

  server.registerTool(
    "search_assets",
    {
      title: "Search assets",
      description:
        "Files in the user's ReelFling library: uploads and generated videos and images. Returns asset keys to use as frames " +
        "or references, and short-lived download links for the user's own files.",
      inputSchema: {
        query: z.string().max(200).optional().describe("Matches the file name or the prompt that made it"),
        kind: z.enum(["image", "video", "audio"]).optional(),
        include_team: z.boolean().optional().describe("Also list teammates' files (view only)"),
        limit: z.number().int().min(1).max(50).optional().describe("Default 20"),
      },
      annotations: READ_ONLY,
    },
    ({ query, kind, include_team, limit }) =>
      guarded(async () => {
        const own = await app.json<AssetItem[]>("/api/assets");
        const team = include_team ? await app.json<AssetItem[]>("/api/assets?team=1") : [];
        const needle = query?.trim().toLowerCase();
        const matches = [...own, ...team]
          .filter((item) => !kind || item.kind === kind)
          .filter(
            (item) =>
              !needle ||
              item.name.toLowerCase().includes(needle) ||
              item.generation?.prompt.toLowerCase().includes(needle),
          )
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, limit ?? 20);
        const rows = await Promise.all(
          matches.map(async (item) => ({
            key: item.key,
            name: item.name,
            kind: item.kind,
            source: item.source,
            created: new Date(item.createdAt).toISOString(),
            ...(item.width && item.height ? { size: `${item.width}×${item.height}` } : {}),
            ...(item.duration ? { duration_s: item.duration } : {}),
            ...(item.generation ? { model: item.generation.model, prompt: clip(item.generation.prompt, 200) } : {}),
            ...(item.owner
              ? { owner: item.owner.name ?? item.owner.email, usable_as_reference: false }
              : { link: await fileLink(app, item.key) }),
          })),
        );
        return text(rows.length ? rows : "No matching files.");
      }),
  );

  server.registerTool(
    "upload_from_url",
    {
      title: "Upload from URL",
      description:
        "Saves a public media link into the user's library: JPEG or PNG up to 20 MB, MP4 or MOV up to 100 MB, " +
        "MP3 or WAV up to 15 MB. Videos and audio should be 2 to 30 seconds. Returns the asset key.",
      inputSchema: {
        url: z.string().url().describe("A direct https link to the file, not a web page"),
        name: z.string().max(120).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ url, name }) =>
      guarded(async () => {
        if (!canGenerate) return readOnlyConnection();
        const link = new URL(url);
        if (link.protocol !== "https:") return failure("Use an https link.");
        const res = await fetch(link, {
          headers: { accept: "image/*,video/*,audio/*", "user-agent": "ReelFling/1.0 (+https://reelfling.com)" },
        });
        if (!res.ok || !res.body) return failure(`The link returned ${res.status}.`);
        const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
        const kind = uploadKindOf(contentType);
        if (!kind) {
          await res.body.cancel();
          return failure(`That link is ${contentType || "an unknown type"}, not a JPEG, PNG, MP4, MOV, MP3 or WAV file.`);
        }
        const rules = UPLOAD_RULES[kind];
        const declared = Number(res.headers.get("content-length") ?? 0);
        if (declared > rules.maxBytes) {
          await res.body.cancel();
          return failure(`That file is too large. Use ${rules.label}.`);
        }
        const bytes = await readCapped(res.body, rules.maxBytes);
        if (!bytes) return failure(`That file is too large. Use ${rules.label}.`);
        const slot = await app.json<{ key: string; uploadUrl: string }>("/api/uploads", {
          method: "POST",
          body: JSON.stringify({ kind, contentType, size: bytes.byteLength }),
        });
        const put = await fetch(slot.uploadUrl, { method: "PUT", headers: { "content-type": contentType }, body: bytes });
        if (!put.ok) return failure("Saving the file failed. Try again.");
        const fileName = name?.trim() || decodeURIComponent(link.pathname.split("/").pop() || "") || `Upload.${slot.key.split(".").pop()}`;
        await app.json("/api/uploads/complete", { method: "POST", body: JSON.stringify({ key: slot.key, name: fileName }) });
        return text({ key: slot.key, kind, name: fileName });
      }),
  );

  async function quoteResult(kind: QuoteKind, request: Record<string, unknown>) {
    const path = kind === "video" ? "/api/generations?dryRun" : "/api/images?dryRun";
    const priced = await app.json<{ model: string; route: string; estimatedCost: number }>(path, {
      method: "POST",
      body: JSON.stringify(request),
    });
    const cost = Math.round(priced.estimatedCost * 1000) / 1000;
    const quote = await saveQuote(env, {
      userId: caller.userId,
      clientId: caller.clientId,
      kind,
      request,
      cost,
      expiresAt: Date.now() + QUOTE_TTL_MS,
    });
    return text({
      quote_id: quote.id,
      estimated_cost_usd: cost,
      model: priced.model,
      provider: priced.route,
      expires_in_minutes: QUOTE_TTL_MS / 60_000,
      next: "Show the user the cost. If they agree, call start_generation with this quote_id.",
    });
  }

  const keys = (values: string[] | undefined) => values?.map(upload);

  server.registerTool(
    "quote_video",
    {
      title: "Price a video",
      description:
        "Checks a video request and prices it, without starting it. Returns a quote id for start_generation. " +
        "Use a start frame (and optionally an end frame), or reference images, videos and audio, not both. " +
        "With references, mention them in the prompt by order, for example @image1 or @video1, when the model uses @ mentions.",
      inputSchema: {
        model: z.string().describe("A video model id from list_models"),
        prompt: z.string().min(1).max(4000),
        ratio: z.string().optional().describe("For example 16:9 or 9:16. Default: the model's first ratio"),
        resolution: z.string().optional().describe("For example 720p. Default 720p when offered"),
        duration: z.number().int().optional().describe("Seconds. Default: the model's default"),
        audio: z.boolean().optional().describe("Generate sound, on models that can"),
        start_frame: z.string().optional().describe("Asset key of an image"),
        end_frame: z.string().optional().describe("Asset key of an image. Needs start_frame"),
        reference_images: z.array(z.string()).max(30).optional().describe("Asset keys"),
        reference_videos: z.array(z.string()).max(10).optional().describe("Asset keys"),
        reference_audios: z.array(z.string()).max(10).optional().describe("Asset keys"),
        provider: z.string().optional().describe("A route from list_models. Default: the user's preferred route"),
      },
      annotations: READ_ONLY,
    },
    (input) =>
      guarded(async () => {
        const model = videoModels().find((item) => item.id === input.model);
        if (!model) return failure(`There is no video model "${input.model}". Use list_models.`);
        const caps = model.capabilities;
        const frames = !!input.start_frame;
        return quoteResult("video", {
          model: model.id,
          prompt: input.prompt,
          mode: frames ? "frames" : "references",
          ratio: input.ratio ?? caps.ratios[0] ?? "16:9",
          resolution: input.resolution ?? (caps.resolutions.includes("720p") ? "720p" : caps.resolutions[0]),
          duration: input.duration ?? caps.durations?.default ?? 5,
          ...(input.audio !== undefined && { generateAudio: input.audio }),
          ...(frames && { firstFrame: upload(input.start_frame!) }),
          ...(frames && input.end_frame && { lastFrame: upload(input.end_frame) }),
          ...(!frames && {
            referenceImages: keys(input.reference_images),
            referenceVideos: keys(input.reference_videos),
            referenceAudios: keys(input.reference_audios),
          }),
          ...(input.provider && { route: input.provider }),
        });
      }),
  );

  server.registerTool(
    "quote_image",
    {
      title: "Price an image",
      description:
        "Checks an image request and prices it, without starting it. Returns a quote id for start_generation. " +
        "Reference images edit or guide the result.",
      inputSchema: {
        model: z.string().describe("An image model id from list_models"),
        prompt: z.string().min(1).max(4000),
        ratio: z.string().optional().describe("For example 1:1, 16:9, or auto. Default auto when offered"),
        resolution: z.enum(["1k", "2k", "4k"]).optional().describe("Default: 2k when offered"),
        quality: z.enum(["auto", "low", "medium", "high"]).optional(),
        count: z.number().int().min(1).max(10).optional().describe("Images to make. Default 1"),
        references: z.array(z.string()).max(30).optional().describe("Asset keys of images"),
        provider: z.string().optional().describe("A route from list_models"),
      },
      annotations: READ_ONLY,
    },
    (input) =>
      guarded(async () => {
        const model = allImageModels().find((item) => item.id === input.model);
        if (!model) return failure(`There is no image model "${input.model}". Use list_models.`);
        const caps = model.capabilities;
        return quoteResult("image", {
          model: model.id,
          prompt: input.prompt,
          ratio: input.ratio ?? (caps.ratios.includes("auto") ? "auto" : caps.ratios[0]),
          resolution: input.resolution ?? (caps.resolutions.includes("2k") ? "2k" : caps.resolutions[0]),
          ...(input.quality && { quality: input.quality }),
          count: input.count ?? 1,
          references: input.references ?? [],
          ...(input.provider && { route: input.provider }),
        });
      }),
  );

  server.registerTool(
    "start_generation",
    {
      title: "Start a generation",
      description:
        "Starts the video or image priced by quote_video or quote_image. This spends money on the user's provider key, " +
        "so only call it after the user agreed to the quoted cost. Returns the job to check with get_job.",
      inputSchema: { quote_id: z.string().min(1).max(64) },
      annotations: SPENDS,
    },
    ({ quote_id }) =>
      guarded(async () => {
        if (!canGenerate) return readOnlyConnection();
        const quote = await readQuote(env, quote_id, caller);
        if ("error" in quote) return failure(quote.error);
        const claim = await claimQuote(env, quote);
        if ("error" in claim) return failure(claim.error);
        try {
          const path = quote.kind === "video" ? "/api/generations" : "/api/images";
          const job = await app.json<{ id: string; status: string }>(path, {
            method: "POST",
            body: JSON.stringify(quote.request),
          });
          await recordJob(env, claim.id, job.id);
          return text({
            kind: quote.kind,
            job_id: job.id,
            status: job.status,
            estimated_cost_usd: quote.cost,
            next: `Check it with get_job (kind "${quote.kind}"). Videos usually take 1 to 5 minutes.`,
          });
        } catch (e) {
          await releaseClaim(env, claim.id);
          throw e;
        }
      }),
  );

  server.registerTool(
    "get_job",
    {
      title: "Check a job",
      description: "Status of a video or image job, with download links when it's done. Links last one hour.",
      inputSchema: { kind: z.enum(["video", "image"]), job_id: z.string().min(1) },
      annotations: READ_ONLY,
    },
    ({ kind, job_id }) =>
      guarded(async () => {
        const id = encodeURIComponent(job_id);
        if (kind === "video") {
          const gen = await app.json<Generation & { stored?: boolean; error?: string }>(`/api/generations/${id}`);
          const done = gen.status === "succeeded";
          return text({
            kind,
            job_id: gen.id,
            status: gen.status,
            ...(gen.progress !== undefined && !done && { progress: gen.progress }),
            ...(gen.error && { error: gen.error }),
            ...(done && gen.stored
              ? { key: `videos/${gen.id}.mp4`, link: await fileLink(app, `videos/${gen.id}.mp4`) }
              : done
                ? { note: "Finished. Saving to the library takes a moment; check again shortly." }
                : {}),
          });
        }
        const gen = await app.json<ImageGeneration>(`/api/images/${id}`);
        return text({
          kind,
          job_id: gen.id,
          status: gen.status,
          ...(gen.error && { error: gen.error }),
          ...(gen.images.length && {
            images: await Promise.all(gen.images.map(async (image) => ({ key: image.key, link: await fileLink(app, image.key) }))),
          }),
        });
      }),
  );

  return server;
}

/** Reads a body up to `max` bytes; undefined when it is larger. */
async function readCapped(body: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
