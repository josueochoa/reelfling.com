import type { ProviderCredentials } from "../keys";
import type { ProviderId } from "../models";
import type { GenerateRequest, TaskStatus } from "../types";

/** Provider task state, normalized to ModelArk's status vocabulary. */
export interface TaskSnapshot {
  status: TaskStatus;
  videoUrl?: string;
  lastFrameUrl?: string;
  error?: string;
  seed?: number;
  /** 0–100, when the provider reports it. */
  progress?: number;
  tokens?: number;
  billedSeconds?: number;
  /** USD billed, once known. */
  cost?: number;
}

/** A provider client bound to one user's credentials. */
export interface VideoProvider {
  id: ProviderId;
  label: string;
  /** Cheap authenticated call to check the key; `detail` is shown to the user (e.g. balance). */
  verifyKey(): Promise<{ detail?: string }>;
  createTask(req: GenerateRequest): Promise<{ taskId: string }>;
  getTask(taskId: string): Promise<TaskSnapshot>;
  /** Best-effort cancel/cleanup upstream. */
  deleteTask(taskId: string): Promise<void>;
  /** Fetch the finished MP4. */
  fetchVideo(taskId: string, snapshot: { videoUrl?: string }): Promise<Response>;
}

export type ProviderFactory = (creds: ProviderCredentials) => VideoProvider;

export class ProviderError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}
