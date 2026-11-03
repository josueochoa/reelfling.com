import type { ProviderCredentials } from "../keys";
import type { GenerateRequest } from "../types";
import { buildArgoVideoBody } from "../providers/argolink";
import {
  buildArgoGoogleImage,
  buildArgoGptImage,
  buildFalQueue,
  buildModelArkVideo,
  buildOpenRouterVideo,
  type ImageMapInput,
} from "./bodies";

export type MapperInput = { kind: "video"; request: GenerateRequest } | { kind: "image"; request: ImageMapInput };

export interface MapperContext {
  endpoint: string;
  creds?: ProviderCredentials;
}

export type MapperResult = unknown;

export type Mapper = (input: MapperInput, ctx: MapperContext) => Promise<MapperResult> | MapperResult;

function videoOf(input: MapperInput, mapper: string): GenerateRequest {
  if (input.kind !== "video") throw new Error(`${mapper} maps video requests`);
  return input.request;
}

function imageOf(input: MapperInput, mapper: string): ImageMapInput {
  if (input.kind !== "image") throw new Error(`${mapper} maps image requests`);
  return input.request;
}

/** Every mapper id the registry is allowed to name. A missing one fails the registry test. */
export const MAPPERS = {
  "modelark.video": (input, ctx) => buildModelArkVideo({ ...videoOf(input, "modelark.video"), model: ctx.endpoint }),
  "argolink.video": (input, ctx) => {
    if (!ctx.creds) throw new Error("argolink.video needs the user's API key");
    return buildArgoVideoBody(ctx.creds, { ...videoOf(input, "argolink.video"), model: ctx.endpoint });
  },
  "argolink.image.google": (input, ctx) => buildArgoGoogleImage(imageOf(input, "argolink.image.google"), ctx.endpoint),
  "argolink.image.openai": (input, ctx) => buildArgoGptImage(imageOf(input, "argolink.image.openai"), ctx.endpoint),
  "fal.queue": (input, ctx) => {
    if (input.kind !== "video") return { endpoint: ctx.endpoint, input: input.request };
    return buildFalQueue(input.request, ctx.endpoint);
  },
  "openrouter.video": (input, ctx) => buildOpenRouterVideo(videoOf(input, "openrouter.video"), ctx.endpoint),
} satisfies Record<string, Mapper>;
