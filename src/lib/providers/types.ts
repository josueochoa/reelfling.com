import type { ProviderCredentials } from "../keys";
import type { StudioProviderId } from "../registry";
import type { GenerateRequest, TaskStatus } from "../types";

/** Provider task state, normalized to ModelArk's status vocabulary. */
export interface TaskSnapshot {
  status: TaskStatus;
  videoUrl?: string;
  error?: string;
  seed?: number;
  /** 0–100, when the provider reports it. */
  progress?: number;
  tokens?: number;
  billedSeconds?: number;
}

/** A provider client bound to one user's credentials. */
export interface VideoProvider {
  id: StudioProviderId;
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

/** Shown when a status poll 404s. The provider body is not copied: it can echo the key. */
export const TASK_GONE_ERROR = "The provider no longer has this task. It may belong to a different API key.";

/** Shown when the stored key is gone. The thrown message is not copied. */
export const MISSING_KEY_ERROR = "Add your API key in Settings. This job can no longer be checked.";

/**
 * A poll failure that should end the job. 429, 5xx, and network errors return
 * undefined so the row stays queued or running and the next poll retries.
 */
export function terminalPollUpdate(e: unknown): { status: "failed"; error: string } | undefined {
  if (!(e instanceof ProviderError)) return undefined;
  if (e.status === 404) return { status: "failed", error: TASK_GONE_ERROR };
  if (e.code === "missing_key") return { status: "failed", error: MISSING_KEY_ERROR };
  return undefined;
}
