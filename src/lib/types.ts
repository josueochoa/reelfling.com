import type { StudioProviderId } from "./registry";

export type GenerationMode = "frames" | "references";

/** Body of POST /api/generations. Media fields are https URLs, data: URIs, or `upload:<key>`. */
export interface GenerateRequest {
  model: string;
  prompt: string;
  mode: GenerationMode;
  ratio: string;
  resolution: string;
  duration: number;
  generateAudio?: boolean;
  seed?: number;
  watermark?: boolean;
  cameraFixed?: boolean;
  /** One preset on records saved before chips. Reuse still reads it. */
  cameraMove?: string;
  /** Up to three preset ids, in chip order. The server compiles them. */
  cameraMoves?: string[];
  firstFrame?: string;
  lastFrame?: string;
  referenceImages?: string[];
  referenceVideos?: string[];
  referenceAudios?: string[];
  /** Library keys of the reference blocks, in the order they were shown. */
  referenceOrder?: string[];
  /** Provider route chosen in the picker or restored by Reuse. */
  route?: string;
}

/** One reference block, stored so Reuse can rebuild the box. */
export interface MediaBlock {
  kind: "image" | "video" | "audio";
  /** R2 object key (`uploads/…`, `videos/…`, `images/…`, or a legacy `refs/…`). */
  key: string;
  /** Name captured at save time, so Reuse can name the file if it was deleted. */
  name?: string;
}

/**
 * What the generation was given. The booleans and counts are always there.
 * Keys are present on generations saved after inputs started being persisted.
 */
export interface GenerationInputs {
  firstFrame: boolean;
  lastFrame: boolean;
  images: number;
  videos: number;
  audios: number;
  firstFrameKey?: string;
  firstFrameName?: string;
  lastFrameKey?: string;
  lastFrameName?: string;
  /** Reference blocks in display order. Absent on older, count-only records. */
  blocks?: MediaBlock[];
}

/** Upstream ModelArk task status. */
export type TaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "expired";

export const TERMINAL_STATUSES: TaskStatus[] = ["succeeded", "failed", "cancelled", "expired"];

export interface Generation {
  id: string;
  /** Missing on records created before providers existed (= modelark). */
  provider?: StudioProviderId;
  taskId: string;
  status: TaskStatus;
  /** 0–100 while in flight, when the provider reports it. */
  progress?: number;
  model: string;
  prompt: string;
  mode: GenerationMode;
  ratio: string;
  resolution: string;
  duration: number;
  generateAudio: boolean;
  seed?: number;
  /** One preset on records saved before chips. */
  cameraMove?: string;
  /** Preset ids in chip order. Absent on older records. */
  cameraMoves?: string[];
  /** Provider this generation ran on. */
  route?: string;
  /** Catalog endpoint id that was called. */
  routeEndpoint?: string;
  /** Catalog estimate, USD. */
  estimatedCost?: number;
  /** Counts, plus the R2 keys of frames and reference blocks when they were saved. */
  inputs: GenerationInputs;
  /** Temporary signed URL from ModelArk (expires ~24h). */
  remoteVideoUrl?: string;
  /** Set once the video has been copied into the user's storage (see storage.ts). */
  stored?: boolean;
  lastFrameUrl?: string;
  error?: string;
  tokens?: number;
  billedSeconds?: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}
