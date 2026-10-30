// Generations, scoped per user. Rows live in D1 (see db.ts); finished videos are
// copied into the user's R2 bucket (see storage.ts).

import { all, first, run } from "./db";
import { providerForUser } from "./providers";
import { deleteGenerationAssets, getAsset, putAsset, videoKey, type Asset } from "./storage";
import { TERMINAL_STATUSES, type Generation } from "./types";

const parse = (row: { data: string } | undefined) => (row ? (JSON.parse(row.data) as Generation) : undefined);

export async function listGenerations(userId: string): Promise<Generation[]> {
  const rows = await all<{ data: string }>(
    "SELECT data FROM generations WHERE user_id = ? ORDER BY created_at DESC",
    userId,
  );
  return rows.map((r) => parse(r)!);
}

export async function getGeneration(userId: string, id: string): Promise<Generation | undefined> {
  return parse(await first<{ data: string }>("SELECT data FROM generations WHERE id = ? AND user_id = ?", id, userId));
}

export async function insertGeneration(userId: string, gen: Generation) {
  await run(
    "INSERT INTO generations (id, user_id, created_at, data) VALUES (?, ?, ?, ?)",
    gen.id,
    userId,
    gen.createdAt,
    JSON.stringify(gen),
  );
}

export async function updateGeneration(userId: string, id: string, patch: Partial<Generation>) {
  const gen = await getGeneration(userId, id);
  if (!gen) return undefined;
  const next = { ...gen, ...patch, updatedAt: Date.now() };
  await run("UPDATE generations SET data = ? WHERE id = ? AND user_id = ?", JSON.stringify(next), id, userId);
  return next;
}

export async function removeGeneration(userId: string, id: string) {
  await deleteGenerationAssets(userId, id);
  await run("DELETE FROM generations WHERE id = ? AND user_id = ?", id, userId);
}

/** Generations still in flight, or finished but not yet copied to storage — for the cron sweep. */
export async function unfinishedGenerations(limit: number, maxAgeMs: number) {
  return all<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM generations
     WHERE created_at > ?
       AND (json_extract(data, '$.status') IN ('queued', 'running')
            OR (json_extract(data, '$.status') = 'succeeded' AND json_extract(data, '$.stored') IS NOT 1))
     ORDER BY created_at LIMIT ?`,
    Date.now() - maxAgeMs,
    limit,
  );
}

/** The generation's stored video, copying it from the provider first if needed (their URLs expire). */
export async function ensureStoredVideo(userId: string, gen: Generation): Promise<Asset> {
  const key = videoKey(gen.id);
  let asset = await getAsset(userId, key);
  if (!asset) {
    const provider = await providerForUser(userId, gen.provider ?? "modelark");
    const res = await provider.fetchVideo(gen.taskId, { videoUrl: gen.remoteVideoUrl });
    if (!res.ok) throw new Error(`Video download failed (${res.status})`);
    asset = await putAsset(userId, { key, source: res, contentType: "video/mp4", generationId: gen.id });
  }
  if (!gen.stored) await updateGeneration(userId, gen.id, { stored: true });
  return asset;
}

/** Pull the latest task state from the provider and persist it. */
export async function syncGeneration(userId: string, id: string): Promise<Generation | undefined> {
  let gen = await getGeneration(userId, id);
  if (!gen) return undefined;

  if (!TERMINAL_STATUSES.includes(gen.status)) {
    const task = await (await providerForUser(userId, gen.provider ?? "modelark")).getTask(gen.taskId);
    const done = TERMINAL_STATUSES.includes(task.status);
    gen = await updateGeneration(userId, id, {
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
