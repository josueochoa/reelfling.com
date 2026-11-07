// Shared by the fal client and the browser. No secrets, no fetch.

import type { TeamAuthor } from "./teamPolicy";

export type FalJobStatus = "queued" | "running" | "succeeded" | "failed";

/** fal only cancels work that hasn't finished. */
export function shouldCancelFal(status: FalJobStatus) {
  return status === "queued" || status === "running";
}

/**
 * The open tab polls only while fal is still working. A succeeded job whose files
 * failed to copy is marked failed instead, so this never stays true forever.
 */
export function shouldPollFal(status: FalJobStatus) {
  return status === "queued" || status === "running";
}

/** In-process copy tries. This is not a poll: the tab does not call back between them. */
export const STORE_ATTEMPTS = 2;

export function storeGaveUp(attempt: number) {
  return attempt >= STORE_ATTEMPTS;
}

/** After the in-process tries are spent, the job is failed and nothing polls it. */
export function storeFailureUpdate(message: string): { status: "failed"; error: string } {
  const reason = message.trim() || "The download failed.";
  return { status: "failed", error: `Couldn't save the result. ${reason}` };
}

/** One field from a fal 422 (`detail[].loc` / `detail[].msg`). */
export interface FalFieldError {
  field: string;
  message: string;
}

/** A catalog tool run, without the request JSON or the endpoint. */
export interface FalToolView {
  id: string;
  name: string;
  inputAssetIds: string[];
}

/** What the browser is allowed to see. Raw request/response JSON stays on the row. */
export interface FalJobView {
  id: string;
  endpointId: string;
  status: FalJobStatus;
  /** Prompt from the input, when it had one. */
  prompt: string;
  /** Set when the job was started from the Tools menu. */
  tool?: FalToolView;
  /** Queue position while fal still has the request, when it reported one. */
  queuePosition?: number;
  error?: string;
  fields?: FalFieldError[];
  outputs: { key: string; contentType: string }[];
  /** Set when this job continues a generation. Part numbers group the feed. */
  sequenceId?: string;
  part?: number;
  sourceGenerationId?: string;
  stored?: boolean;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  /** Who made it, when it's a teammate's. Read-only to this viewer. Absent on the viewer's own. */
  owner?: TeamAuthor;
}
