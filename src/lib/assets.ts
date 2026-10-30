// The Assets view across sources: deleting means different things per kind of file.

import { getImageGeneration, removeImageGeneration, updateImageGeneration } from "./images";
import { deleteAsset, getAsset } from "./storage";
import { removeGeneration } from "./store";
import { isAssetKey } from "./uploads";

/**
 * Deletes one of the user's assets. A generated video takes its generation with it; a
 * generated image is removed from its generation, which goes when its last image does.
 */
export async function deleteUserAsset(userId: string, key: string) {
  if (!isAssetKey(key)) return;
  const asset = await getAsset(userId, key);
  if (!asset) return;
  if (key.startsWith("videos/") && asset.generationId) return removeGeneration(userId, asset.generationId);
  if (key.startsWith("images/") && asset.generationId) {
    const gen = await getImageGeneration(userId, asset.generationId);
    const rest = gen?.images.filter((i) => i.key !== key) ?? [];
    if (!gen || !rest.length) return removeImageGeneration(userId, asset.generationId);
    await deleteAsset(asset);
    await updateImageGeneration(userId, gen.id, { images: rest });
    return;
  }
  await deleteAsset(asset);
}
