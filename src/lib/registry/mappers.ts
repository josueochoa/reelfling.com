import { buildArgoGoogleImage, buildArgoGptImage, type ImageMapInput } from "./bodies";
import type { MapperId } from "./types";

export type MapperInput = { kind: "image"; request: ImageMapInput };

export interface MapperContext {
  endpoint: string;
}

export type Mapper = (input: MapperInput, ctx: MapperContext) => unknown;

/**
 * Mappers a provider client actually calls. Routes for video, fal, and OpenRouter
 * still name `modelark.video`, `argolink.video`, `fal.queue`, and `openrouter.video`;
 * those functions arrive with the client that sends the body.
 */
export const MAPPERS: Partial<Record<MapperId, Mapper>> = {
  "argolink.image.google": (input, ctx) => buildArgoGoogleImage(input.request, ctx.endpoint),
  "argolink.image.openai": (input, ctx) => buildArgoGptImage(input.request, ctx.endpoint),
};
