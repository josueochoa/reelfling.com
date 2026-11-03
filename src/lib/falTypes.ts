// Shared by the fal client and the browser. No secrets, no fetch.

export type FalJobStatus = "queued" | "running" | "succeeded" | "failed";

/** fal only cancels work that hasn't finished. */
export function shouldCancelFal(status: FalJobStatus) {
  return status === "queued" || status === "running";
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
}
