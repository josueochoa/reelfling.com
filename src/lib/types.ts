import type { ProviderId, Ratio, Resolution } from "./models";
import type { Creator } from "./uploads";

export type GenerationMode = "frames" | "references";

/** Body of POST /api/generations. Media fields are https URLs or data: URIs. */
export interface GenerateRequest {
  model: string;
  prompt: string;
  mode: GenerationMode;
  ratio: Ratio;
  resolution: Resolution;
  duration: number;
  generateAudio?: boolean;
  seed?: number;
  watermark?: boolean;
  cameraFixed?: boolean;
  firstFrame?: string;
  lastFrame?: string;
  referenceImages?: string[];
  referenceVideos?: string[];
  referenceAudios?: string[];
}

/** Upstream ModelArk task status. */
export type TaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "expired";

export const TERMINAL_STATUSES: TaskStatus[] = ["succeeded", "failed", "cancelled", "expired"];

export interface Generation {
  id: string;
  /** Missing on records created before providers existed (= modelark). */
  provider?: ProviderId;
  taskId: string;
  status: TaskStatus;
  /** 0–100 while in flight, when the provider reports it. */
  progress?: number;
  model: string;
  prompt: string;
  mode: GenerationMode;
  ratio: Ratio;
  resolution: Resolution;
  duration: number;
  generateAudio: boolean;
  seed?: number;
  /** Counts only — input media isn't persisted. */
  inputs: { firstFrame: boolean; lastFrame: boolean; images: number; videos: number; audios: number };
  /** Temporary signed URL from ModelArk (expires ~24h). */
  remoteVideoUrl?: string;
  /** Set once the video has been copied into the user's storage (see storage.ts). */
  stored?: boolean;
  /** User who started it (from its own column). */
  createdBy?: string | null;
  /** Their profile, on lists (team workspaces show who made what). */
  creator?: Creator;
  lastFrameUrl?: string;
  error?: string;
  tokens?: number;
  billedSeconds?: number;
  /** USD the provider billed, when it reports it (OpenRouter). */
  cost?: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}
