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
}

export interface VideoProvider {
  id: ProviderId;
  label: string;
  createTask(req: GenerateRequest): Promise<{ taskId: string }>;
  getTask(taskId: string): Promise<TaskSnapshot>;
  /** Best-effort cancel/cleanup upstream. */
  deleteTask(taskId: string): Promise<void>;
  /** Fetch the finished MP4. */
  fetchVideo(taskId: string, snapshot: { videoUrl?: string }): Promise<Response>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}
