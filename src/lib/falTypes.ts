// Shared by the fal client and the browser. No secrets, no fetch.

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

/** What the browser is allowed to see. Raw request/response JSON stays on the row. */
export interface FalJobView {
  id: string;
  endpointId: string;
  status: FalJobStatus;
  /** Prompt from the input, when it had one. */
  prompt: string;
  error?: string;
  fields?: FalFieldError[];
  outputs: { key: string; contentType: string }[];
  stored?: boolean;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  keySource?: "team" | "member";
  creator?: { id: string; email: string; name: string | null; avatarUrl: string | null };
}
