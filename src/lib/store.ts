// Generations, scoped per workspace. Rows live in D1 (see db.ts); finished videos are
// copied into the user's R2 bucket (see storage.ts).

import { all, first, run } from "./db";
import { providerForWorkspace } from "./providers";
import { creatorsIn, deleteGenerationAssets, getAsset, putAsset, videoKey, type Asset } from "./storage";
import { TERMINAL_STATUSES, type Generation } from "./types";

/** Who made it lives in its own column, not in the JSON. */
const toJson = (gen: Generation) =>
  JSON.stringify(gen, (k, v) => (k === "createdBy" || k === "creator" ? undefined : v));

const parse = (row: { data: string; created_by: string | null } | undefined) =>
  row ? ({ ...(JSON.parse(row.data) as Generation), createdBy: row.created_by } as Generation) : undefined;

export async function listGenerations(workspaceId: string): Promise<Generation[]> {
  const [rows, creators] = await Promise.all([
    all<{ data: string; created_by: string | null }>(
      "SELECT data, created_by FROM generations WHERE workspace_id = ? ORDER BY created_at DESC",
      workspaceId,
    ),
    creatorsIn("generations", workspaceId),
  ]);
  return rows.map((r) => ({ ...parse(r)!, creator: (r.created_by && creators.get(r.created_by)) || undefined }));
}

export async function getGeneration(workspaceId: string, id: string): Promise<Generation | undefined> {
  return parse(
    await first<{ data: string; created_by: string | null }>(
      "SELECT data, created_by FROM generations WHERE id = ? AND workspace_id = ?",
      id,
      workspaceId,
    ),
  );
}

export async function insertGeneration(workspaceId: string, gen: Generation, createdBy: string) {
  await run(
    "INSERT INTO generations (id, workspace_id, created_by, created_at, data) VALUES (?, ?, ?, ?, ?)",
    gen.id,
    workspaceId,
    createdBy,
    gen.createdAt,
    toJson(gen),
  );
}

export async function updateGeneration(workspaceId: string, id: string, patch: Partial<Generation>) {
  const gen = await getGeneration(workspaceId, id);
  if (!gen) return undefined;
  const next = { ...gen, ...patch, updatedAt: Date.now() };
  await run("UPDATE generations SET data = ? WHERE id = ? AND workspace_id = ?", toJson(next), id, workspaceId);
  return next;
}

export async function removeGeneration(workspaceId: string, id: string) {
  await deleteGenerationAssets(workspaceId, id);
  await run("DELETE FROM generations WHERE id = ? AND workspace_id = ?", id, workspaceId);
}

/** Generations still in flight, or finished but not yet copied to storage — for the cron sweep. */
export async function unfinishedGenerations(limit: number, maxAgeMs: number) {
  return all<{ id: string; workspace_id: string }>(
    `SELECT id, workspace_id FROM generations
     WHERE created_at > ?
       AND (json_extract(data, '$.status') IN ('queued', 'running')
            OR (json_extract(data, '$.status') = 'succeeded' AND json_extract(data, '$.stored') IS NOT 1))
     ORDER BY created_at LIMIT ?`,
    Date.now() - maxAgeMs,
    limit,
  );
}

/** The generation's stored video, copying it from the provider first if needed (their URLs expire). */
export async function ensureStoredVideo(workspaceId: string, gen: Generation): Promise<Asset> {
  const key = videoKey(gen.id);
  let asset = await getAsset(workspaceId, key);
  if (!asset) {
    const provider = await providerForWorkspace(workspaceId, gen.provider ?? "modelark");
    const res = await provider.fetchVideo(gen.taskId, { videoUrl: gen.remoteVideoUrl });
    if (!res.ok) throw new Error(`Video download failed (${res.status})`);
    asset = await putAsset(workspaceId, {
      key,
      source: res,
      contentType: "video/mp4",
      generationId: gen.id,
      createdBy: gen.createdBy,
    });
  }
  if (!gen.stored) await updateGeneration(workspaceId, gen.id, { stored: true });
  return asset;
}

/** Pull the latest task state from the provider and persist it. */
export async function syncGeneration(workspaceId: string, id: string): Promise<Generation | undefined> {
  let gen = await getGeneration(workspaceId, id);
  if (!gen) return undefined;

  if (!TERMINAL_STATUSES.includes(gen.status)) {
    const task = await (await providerForWorkspace(workspaceId, gen.provider ?? "modelark")).getTask(gen.taskId);
    const done = TERMINAL_STATUSES.includes(task.status);
    gen = await updateGeneration(workspaceId, id, {
      status: task.status,
      progress: task.progress,
      remoteVideoUrl: task.videoUrl,
      lastFrameUrl: task.lastFrameUrl,
      error: task.error,
      seed: task.seed ?? gen.seed,
      tokens: task.tokens,
      billedSeconds: task.billedSeconds,
      cost: task.cost,
      ...(done && { completedAt: Date.now() }),
    });
    if (!gen) return undefined;
  }

  if (gen.status === "succeeded" && !gen.stored) {
    await ensureStoredVideo(workspaceId, gen).catch((e) => console.error(`[${id}]`, e));
    return getGeneration(workspaceId, id);
  }
  return gen;
}
