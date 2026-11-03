// BytePlus ModelArk video generation task API.
// Docs: https://docs.byteplus.com/en/docs/ModelArk (Video Generation API)

import type { ProviderCredentials } from "../keys";
import { buildModelArkVideo } from "../registry/bodies";
import { reportedUsd } from "../reportedCost";
import type { TaskStatus } from "../types";
import { ProviderError, type ProviderFactory } from "./types";

const DEFAULT_BASE_URL = "https://ark.ap-southeast.bytepluses.com/api/v3";

interface ArkTask {
  id: string;
  model: string;
  status: TaskStatus;
  error?: { code: string; message: string } | null;
  content?: { video_url?: string; last_frame_url?: string };
  usage?: { completion_tokens?: number; total_tokens?: number };
  seed?: number;
}

async function ark<T>(creds: ProviderCredentials, path: string, init?: RequestInit): Promise<T> {
  const base = (creds.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${creds.apiKey}`, "Content-Type": "application/json", ...init?.headers },
    cache: "no-store",
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new ProviderError(`ModelArk returned non-JSON (${res.status}): ${text.slice(0, 200)}`, res.status || 502);
  }
  if (!res.ok) {
    const err = body?.error ?? {};
    throw new ProviderError(err.message || `ModelArk request failed (${res.status})`, res.status, err.code);
  }
  return body as T;
}

export const buildTaskBody = buildModelArkVideo;

export const modelArk: ProviderFactory = (creds) => ({
  id: "modelark",
  label: "BytePlus ModelArk",

  async verifyKey() {
    await ark(creds, "/contents/generations/tasks?page_num=1&page_size=1");
    return {};
  },

  async createTask(req) {
    const { id } = await ark<{ id: string }>(creds, "/contents/generations/tasks", {
      method: "POST",
      body: JSON.stringify(buildTaskBody(req)),
    });
    return { taskId: id };
  },

  async getTask(taskId) {
    const task = await ark<ArkTask>(creds, `/contents/generations/tasks/${encodeURIComponent(taskId)}`);
    return {
      status: task.status,
      videoUrl: task.content?.video_url,
      lastFrameUrl: task.content?.last_frame_url,
      error: task.error?.message,
      seed: task.seed,
      tokens: task.usage?.completion_tokens,
      costUsd: reportedUsd(task),
    };
  },

  /** Cancels a queued task, or deletes the record of a finished one. Running tasks can't be cancelled. */
  async deleteTask(taskId) {
    await ark(creds, `/contents/generations/tasks/${encodeURIComponent(taskId)}`, { method: "DELETE" });
  },

  // Signed, unauthenticated URL.
  fetchVideo: (_taskId, { videoUrl }) => fetch(videoUrl!),
});
