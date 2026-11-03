// Generations, scoped per workspace. Rows keep user_id (the person who made them).
// Finished videos are copied into the workspace's R2 bucket (see storage.ts).

import { providerForWorkspace } from "./providers";
import { byWorkspace, persistJson, wsArgs } from "./scope";
import { creatorsIn, deleteGenerationAssets, getAsset, putAsset, videoKey, type Asset } from "./storage";
import { all, first, run } from "./db";
import { TERMINAL_STATUSES, type Generation } from "./types";

type Row = { data: string; created_by: string | null };
const parse = (row: Row | undefined) =>
  row ? ({ ...(JSON.parse(row.data) as Generation), createdBy: row.created_by } as Generation) : undefined;

export async function listGenerations(workspaceId: string): Promise<Generation[]> {
  const [rows, creators] = await Promise.all([
    all<Row>(`SELECT data, created_by FROM generations WHERE ${byWorkspace()} ORDER BY created_at DESC`, ...wsArgs(workspaceId)),
    creatorsIn("generations", workspaceId),
  ]);
  return rows.map((r) => ({ ...parse(r)!, creator: (r.created_by && creators.get(r.created_by)) || undefined }));
}

export async function getGeneration(workspaceId: string, id: string): Promise<Generation | undefined> {
  return parse(
    await first<Row>(`SELECT data, created_by FROM generations WHERE id = ? AND ${byWorkspace()}`, id, ...wsArgs(workspaceId)),
  );
}

export async function insertGeneration(workspaceId: string, gen: Generation, createdBy: string) {
  await run(
    "INSERT INTO generations (id, user_id, workspace_id, created_by, created_at, data) VALUES (?, ?, ?, ?, ?, ?)",
    gen.id,
    createdBy,
    workspaceId,
    createdBy,
    gen.createdAt,
    persistJson(gen),
  );
}

export async function updateGeneration(workspaceId: string, id: string, patch: Partial<Generation>) {
  const gen = await getGeneration(workspaceId, id);
  if (!gen) return undefined;
  const next = { ...gen, ...patch, updatedAt: Date.now() };
  await run(
    `UPDATE generations SET data = ? WHERE id = ? AND ${byWorkspace()}`,
    persistJson(next),
    id,
    ...wsArgs(workspaceId),
  );
  return next;
}

export async function removeGeneration(workspaceId: string, id: string) {
  await deleteGenerationAssets(workspaceId, id);
  await run(`DELETE FROM generations WHERE id = ? AND ${byWorkspace()}`, id, ...wsArgs(workspaceId));
}

/** Generations still in flight, or finished but not yet copied to storage — for the cron sweep. */
export async function unfinishedGenerations(limit: number, maxAgeMs: number) {
  return all<{ id: string; workspace_id: string }>(
    `SELECT id, COALESCE(workspace_id, user_id) AS workspace_id FROM generations
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
    const keyWorkspace = gen.keyWorkspaceId || workspaceId;
    const provider = await providerForWorkspace(keyWorkspace, gen.provider ?? "modelark");
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
    const keyWorkspace = gen.keyWorkspaceId || workspaceId;
    const task = await (await providerForWorkspace(keyWorkspace, gen.provider ?? "modelark")).getTask(gen.taskId);
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
      ...(task.costUsd !== undefined ? { reportedCost: task.costUsd } : {}),
      ...(done && { completedAt: Date.now() }),
    });
    if (!gen) return undefined;
  }

  if (gen.status === "succeeded" && !gen.stored) {
    await ensureStoredVideo(workspaceId, gen).catch((e) => console.error(`[${id}]`, (e as Error).message));
    return getGeneration(workspaceId, id);
  }
  return gen;
}
