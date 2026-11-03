// The Assets view across sources: deleting means different things per kind of file.

import { getFalJob, removeFalJob, updateFalJob } from "./falJobs";
import { getImageGeneration, removeImageGeneration, updateImageGeneration } from "./images";
import { deleteAsset, getAsset } from "./storage";
import { removeGeneration } from "./store";
import { isAssetKey } from "./uploads";

/**
 * Deletes one asset in a workspace. A generated video takes its generation with it; a
 * generated image is removed from its generation, which goes when its last image does.
 * The caller has already checked that this user may modify it.
 */
export async function deleteWorkspaceAsset(workspaceId: string, key: string) {
  if (!isAssetKey(key)) return;
  const asset = await getAsset(workspaceId, key);
  if (!asset) return;
  if (key.startsWith("videos/") && asset.generationId) return removeGeneration(workspaceId, asset.generationId);
  if (key.startsWith("fal/") && asset.generationId) {
    const job = await getFalJob(workspaceId, asset.generationId);
    const rest = job?.outputs.filter((output) => output.key !== key) ?? [];
    if (!job || !rest.length) return removeFalJob(workspaceId, asset.generationId);
    await deleteAsset(asset);
    await updateFalJob(workspaceId, job.id, { outputs: rest });
    return;
  }
  if (key.startsWith("images/") && asset.generationId) {
    const gen = await getImageGeneration(workspaceId, asset.generationId);
    const rest = gen?.images.filter((i) => i.key !== key) ?? [];
    if (!gen || !rest.length) return removeImageGeneration(workspaceId, asset.generationId);
    await deleteAsset(asset);
    await updateImageGeneration(workspaceId, gen.id, { images: rest });
    return;
  }
  await deleteAsset(asset);
}
