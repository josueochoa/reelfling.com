// Generations, scoped per user. Rows live in D1 (see db.ts); finished videos are
// copied into the user's R2 bucket (see storage.ts).

import { all, first, run } from "./db";
import { getCredentials } from "./keys";
import { providerForUser, terminalPollUpdate } from "./providers";
import { fetchFalOutput, pollFal } from "./providers/fal";
import { staleVideoFailure } from "./staleVideo";
import { deleteGenerationAssets, getAsset, putAsset, videoKey, type Asset } from "./storage";
import { nextSequencePart, type SequencePlan } from "./sequence";
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
    "INSERT INTO generations (id, user_id, created_at, data, route) VALUES (?, ?, ?, ?, ?)",
    gen.id,
    userId,
    gen.createdAt,
    JSON.stringify(gen),
    gen.route ?? null,
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
    const providerId = gen.provider && gen.provider !== "fal" ? gen.provider : "modelark";
    const res =
      (gen.route ?? gen.provider) === "fal"
        ? await fetchFalOutput(gen.remoteVideoUrl || "")
        : await (await providerForUser(userId, providerId)).fetchVideo(gen.taskId, { videoUrl: gen.remoteVideoUrl });
    if (!res.ok) throw new Error(`Video download failed (${res.status})`);
    asset = await putAsset(userId, { key, source: res, contentType: "video/mp4", generationId: gen.id });
  }
  if (!gen.stored) await updateGeneration(userId, gen.id, { stored: true });
  return asset;
}

/** Fail every queued or running video that has been open for 2 hours. Returns rows changed. */
export async function failStaleGenerations(now = Date.now()) {
  const { sql, params } = staleVideoFailure(now);
  const res = await run(sql, ...params);
  return res.meta.changes;
}

/** fal polls the URLs from submit. Every other provider uses its task id. */
async function syncTask(userId: string, gen: Generation) {
  if ((gen.route ?? gen.provider) !== "fal") {
    const providerId = gen.provider && gen.provider !== "fal" ? gen.provider : "modelark";
    return (await providerForUser(userId, providerId)).getTask(gen.taskId);
  }
  if (!gen.falStatusUrl || !gen.falResponseUrl) return { status: gen.status };
  const creds = await getCredentials(userId, "fal");
  if (!creds) return { status: gen.status };
  const snap = await pollFal(creds.apiKey, { statusUrl: gen.falStatusUrl, responseUrl: gen.falResponseUrl });
  return { status: snap.status, videoUrl: snap.outputs[0]?.url, error: snap.error };
}

/**
 * Appends a part to the source clip's sequence and numbers the source part 1
 * the first time. Returns undefined when that generation is gone.
 */
export async function continueSequence(
  userId: string,
  sourceId: string,
): Promise<(SequencePlan & { sourceGenerationId: string }) | undefined> {
  const source = await getGeneration(userId, sourceId);
  if (!source) return undefined;
  const sequenceId = source.sequenceId || source.id;
  const [gens, jobs] = await Promise.all([
    all<{ data: string }>(
      `SELECT data FROM generations
       WHERE user_id = ? AND (id = ? OR json_extract(data, '$.sequenceId') = ?)`,
      userId,
      source.id,
      sequenceId,
    ),
    all<{ data: string }>(
      `SELECT data FROM fal_jobs
       WHERE user_id = ? AND json_extract(data, '$.sequence.sequenceId') = ?`,
      userId,
      sequenceId,
    ),
  ]);
  const used = [
    ...gens.map((row) => (JSON.parse(row.data) as Generation).part),
    ...jobs.map((row) => (JSON.parse(row.data) as { sequence?: { part?: number } }).sequence?.part),
  ];
  const plan = nextSequencePart(source, used);
  if (plan.sourcePatch) await updateGeneration(userId, source.id, plan.sourcePatch);
  return { ...plan, sourceGenerationId: source.id };
}

/** Pull the latest task state from the provider and persist it. */
export async function syncGeneration(userId: string, id: string): Promise<Generation | undefined> {
  let gen = await getGeneration(userId, id);
  if (!gen) return undefined;

  if (!TERMINAL_STATUSES.includes(gen.status)) {
    try {
      const task = await syncTask(userId, gen);
      const done = TERMINAL_STATUSES.includes(task.status);
      gen = await updateGeneration(userId, id, {
        status: task.status,
        progress: task.progress,
        remoteVideoUrl: task.videoUrl,
        error: task.error,
        seed: task.seed ?? gen.seed,
        tokens: task.tokens,
        billedSeconds: task.billedSeconds,
        ...(done && { completedAt: Date.now() }),
      });
      if (!gen) return undefined;
    } catch (e) {
      // 404 (task not on this key) and a missing key end the job. 429, 5xx, and
      // network errors are rethrown so the row stays in flight and the next poll retries.
      const failed = terminalPollUpdate(e);
      if (!failed) throw e;
      return updateGeneration(userId, id, { ...failed, completedAt: Date.now() });
    }
  }

  if (gen.status === "succeeded" && !gen.stored) {
    await ensureStoredVideo(userId, gen).catch((e) => console.error(`[${id}]`, e));
    return getGeneration(userId, id);
  }
  return gen;
}
