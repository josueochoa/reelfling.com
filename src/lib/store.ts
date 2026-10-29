// Generations, scoped per user. Rows live in SQLite (see db.ts); finished videos
// are copied into the user's storage (their R2 bucket, or local disk — see storage.ts).

import { readFileSync, renameSync } from "node:fs";
import path from "node:path";
import { DATA_DIR, db } from "./db";
import { providerForUser } from "./providers";
import {
  activeDriver,
  adoptLegacyFile,
  deleteGenerationAssets,
  getAsset,
  migrateToR2,
  putAsset,
  videoKey,
  type Asset,
} from "./storage";
import { TERMINAL_STATUSES, type Generation } from "./types";

const parse = (row: { data: string } | undefined) => {
  if (!row) return undefined;
  const { localVideo, ...gen } = JSON.parse(row.data) as Generation & { localVideo?: boolean };
  // Records from before storage.ts called this `localVideo`.
  return { ...gen, stored: gen.stored ?? localVideo } as Generation;
};

export function listGenerations(userId: string): Generation[] {
  const rows = db.prepare("SELECT data FROM generations WHERE user_id = ? ORDER BY created_at DESC").all(userId) as {
    data: string;
  }[];
  return rows.map((r) => parse(r)!);
}

export function getGeneration(userId: string, id: string): Generation | undefined {
  return parse(db.prepare("SELECT data FROM generations WHERE id = ? AND user_id = ?").get(id, userId) as never);
}

export function insertGeneration(userId: string, gen: Generation) {
  db.prepare("INSERT INTO generations (id, user_id, created_at, data) VALUES (?, ?, ?, ?)").run(
    gen.id,
    userId,
    gen.createdAt,
    JSON.stringify(gen),
  );
}

export function updateGeneration(userId: string, id: string, patch: Partial<Generation>) {
  const gen = getGeneration(userId, id);
  if (!gen) return undefined;
  const next = { ...gen, ...patch, updatedAt: Date.now() };
  db.prepare("UPDATE generations SET data = ? WHERE id = ? AND user_id = ?").run(JSON.stringify(next), id, userId);
  return next;
}

export async function removeGeneration(userId: string, id: string) {
  await deleteGenerationAssets(userId, id);
  db.prepare("DELETE FROM generations WHERE id = ? AND user_id = ?").run(id, userId);
}

/** One-time move of the pre-accounts JSON history into a user's library. */
export function importLegacyGenerations(userId: string) {
  const file = path.join(DATA_DIR, "generations.json");
  let items: Generation[];
  try {
    items = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return;
  }
  for (const gen of items) insertGeneration(userId, { ...gen, provider: gen.provider ?? "modelark" });
  renameSync(file, `${file}.imported`);
}

const copies = new Map<string, Promise<Asset>>();

/**
 * The generation's stored video, copying it from the provider first if needed
 * (their URLs expire). Concurrent callers share one copy.
 */
export function ensureStoredVideo(userId: string, gen: Generation): Promise<Asset> {
  const { id } = gen;
  if (!copies.has(id)) {
    const job = (async () => {
      const key = videoKey(id);
      let asset = getAsset(userId, key) ?? (await adoptLegacyFile(userId, key, id, "video/mp4"));
      if (!asset) {
        const provider = providerForUser(userId, gen.provider ?? "modelark");
        const res = await provider.fetchVideo(gen.taskId, { videoUrl: gen.remoteVideoUrl });
        if (!res.ok) throw new Error(`Video download failed (${res.status})`);
        const body = Buffer.from(await res.arrayBuffer());
        asset = await putAsset(userId, { key, body, contentType: "video/mp4", generationId: id });
      } else if (asset.driver !== activeDriver()) {
        asset = await migrateToR2(asset);
      }
      if (!gen.stored) updateGeneration(userId, id, { stored: true });
      return asset;
    })().finally(() => copies.delete(id));
    copies.set(id, job);
  }
  return copies.get(id)!;
}

/** Pull the latest task state from the provider and persist it. */
export async function syncGeneration(userId: string, id: string): Promise<Generation | undefined> {
  let gen = getGeneration(userId, id);
  if (!gen) return undefined;

  if (!TERMINAL_STATUSES.includes(gen.status)) {
    const task = await providerForUser(userId, gen.provider ?? "modelark").getTask(gen.taskId);
    const done = TERMINAL_STATUSES.includes(task.status);
    gen = updateGeneration(userId, id, {
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

  if (gen.status === "succeeded" && !gen.stored) {
    await ensureStoredVideo(userId, gen).catch((e) => console.error(`[${id}]`, e));
    return getGeneration(userId, id);
  }
  return gen;
}
