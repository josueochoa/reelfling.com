import type { StudioProviderId } from "./registry";
import type { LookChoice } from "./registry/looks";
import type { TeamAuthor } from "./teamPolicy";

/** "edit" changes an existing video (Seedance 2.5, Kling 4.0 and Wan 3.0 on ArgoLink). */
export type GenerationMode = "frames" | "references" | "edit";

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
  /** Look chips. Auto is omitted. The server compiles them into the provider prompt. */
  look?: LookChoice;
  /** Library key of a palette swatch already included in the reference images. */
  lookSwatch?: string;
  firstFrame?: string;
  lastFrame?: string;
  /** Images between the start and end frames, in order. */
  middleFrames?: string[];
  referenceImages?: string[];
  referenceVideos?: string[];
  referenceAudios?: string[];
  /** Edit mode: the video to change, as `upload:<key>`. The server checks it and sends it first. */
  editVideo?: string;
  /** Library keys of the reference blocks, in the order they were shown. */
  referenceOrder?: string[];
  /** Provider route chosen in the picker or restored by Reuse. */
  route?: string;
  /** Generation this clip continues. The server assigns the sequence and part. */
  continueFrom?: string;
  /** Set when this run was started from a gallery template. */
  templateId?: string;
  /** Text and library keys for that template, so Use this template again can refill the form. */
  templateSlots?: TemplateSlotFill[];
  /**
   * Ask a model with native expansion to rewrite the prompt.
   * Enhance is not called on this path. Omitted means leave the provider default.
   */
  promptExpansion?: boolean;
}

/** One filled template slot, stored on the generation so the form can open again. */
export interface TemplateSlotFill {
  id: string;
  /** Text slot, already trimmed. */
  text?: string;
  /** Library key for an image slot (`uploads/…`). */
  key?: string;
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
  /** Middle keyframes that were library files, in order. */
  middleFrames?: MediaBlock[];
  /** Reference blocks in display order. Absent on older, count-only records. */
  blocks?: MediaBlock[];
  /** Edit mode: the video that was changed. */
  editVideoKey?: string;
  editVideoName?: string;
}

/** Upstream ModelArk task status. */
export type TaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "expired";

export const TERMINAL_STATUSES: TaskStatus[] = ["succeeded", "failed", "cancelled", "expired"];

export interface Generation {
  id: string;
  /** Missing on records created before providers existed (= modelark). */
  provider?: StudioProviderId | "fal";
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
  /** Look chips that were on. Reuse puts them back. */
  look?: LookChoice;
  /** Palette swatch library key, when one was attached. */
  lookSwatch?: string;
  /** Provider this generation ran on. */
  route?: string;
  /** Catalog endpoint id that was called. */
  routeEndpoint?: string;
  /** Catalog estimate, USD. */
  estimatedCost?: number;
  /** Gallery template this generation was started from. */
  templateId?: string;
  /** Slot text and library keys saved with that template. */
  templateSlots?: TemplateSlotFill[];
  /** Shared by every part of an extended clip. */
  sequenceId?: string;
  /** 1 is the original. Later parts count up. */
  part?: number;
  /** Generation this part was continued from. */
  continuedFrom?: string;
  /** fal queue URLs. Absent on every other provider. */
  falStatusUrl?: string;
  falResponseUrl?: string;
  falCancelUrl?: string;
  /** Counts, plus the R2 keys of frames and reference blocks when they were saved. */
  inputs: GenerationInputs;
  /** Temporary signed URL from the provider (expires ~24h). */
  remoteVideoUrl?: string;
  /** Who made it, when it's a teammate's. Read-only to this viewer. Absent on the viewer's own. */
  owner?: TeamAuthor;
  /** Set once the video has been copied into the user's storage (see storage.ts). */
  stored?: boolean;
  error?: string;
  tokens?: number;
  billedSeconds?: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}
