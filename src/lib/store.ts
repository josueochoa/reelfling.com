// Minimal file-backed store: ./data/generations.json + ./data/videos/<id>.mp4.
// Good enough for a single-user local harness; swap for a DB when needed.

import { promises as fs } from "node:fs";
import path from "node:path";
import { getProvider } from "./providers";
import { TERMINAL_STATUSES, type Generation } from "./types";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_FILE = path.join(DATA_DIR, "generations.json");
export const VIDEO_DIR = path.join(DATA_DIR, "videos");

// Serialize read-modify-write cycles so concurrent polls don't clobber each other.
let queue: Promise<unknown> = Promise.resolve();
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

async function readAll(): Promise<Generation[]> {
  try {
    return JSON.parse(await fs.readFile(DB_FILE, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

async function writeAll(items: Generation[]) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${DB_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(items, null, 2));
  await fs.rename(tmp, DB_FILE);
}

export async function listGenerations() {
  const items = await readAll();
  return items.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getGeneration(id: string) {
  return (await readAll()).find((g) => g.id === id);
}

export function insertGeneration(gen: Generation) {
  return locked(async () => writeAll([...(await readAll()), gen]));
}

export function updateGeneration(id: string, patch: Partial<Generation>) {
  return locked(async () => {
    const items = await readAll();
    const i = items.findIndex((g) => g.id === id);
    if (i === -1) return undefined;
    items[i] = { ...items[i], ...patch, updatedAt: Date.now() };
    await writeAll(items);
    return items[i];
  });
}

export function removeGeneration(id: string) {
  return locked(async () => {
    await writeAll((await readAll()).filter((g) => g.id !== id));
    await fs.rm(videoPath(id), { force: true });
  });
}

export function videoPath(id: string) {
  return path.join(VIDEO_DIR, `${id.replace(/[^a-zA-Z0-9_-]/g, "")}.mp4`);
}

const downloads = new Map<string, Promise<void>>();

/** Provider video URLs expire, so keep a local copy. Concurrent callers share one download. */
export function ensureLocalVideo(gen: Generation) {
  const { id } = gen;
  if (!downloads.has(id)) {
    const job = (async () => {
      const res = await getProvider(gen.provider ?? "modelark").fetchVideo(gen.taskId, { videoUrl: gen.remoteVideoUrl });
      if (!res.ok) throw new Error(`Video download failed (${res.status})`);
      await fs.mkdir(VIDEO_DIR, { recursive: true });
      const tmp = `${videoPath(id)}.part`;
      await fs.writeFile(tmp, Buffer.from(await res.arrayBuffer()));
      await fs.rename(tmp, videoPath(id));
      await updateGeneration(id, { localVideo: true });
    })().finally(() => downloads.delete(id));
    downloads.set(id, job);
  }
  return downloads.get(id)!;
}

/** Pull the latest task state from the provider and persist it. */
export async function syncGeneration(id: string): Promise<Generation | undefined> {
  let gen = await getGeneration(id);
  if (!gen) return undefined;

  if (!TERMINAL_STATUSES.includes(gen.status)) {
    const task = await getProvider(gen.provider ?? "modelark").getTask(gen.taskId);
    const done = TERMINAL_STATUSES.includes(task.status);
    gen = await updateGeneration(id, {
      status: task.status,
      progress: task.progress,
      remoteVideoUrl: task.videoUrl,
      lastFrameUrl: task.lastFrameUrl,
      error: task.error,
      seed: task.seed ?? gen.seed,
      tokens: task.tokens,
      billedSeconds: task.billedSeconds,
      ...(done && { completedAt: Date.now() }),
    });
    if (!gen) return undefined;
  }

  if (gen.status === "succeeded" && !gen.localVideo) {
    await ensureLocalVideo(gen).catch((e) => console.error(`[${id}]`, e));
    return getGeneration(id);
  }
  return gen;
}
