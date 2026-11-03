// Names for models the client learned from /api/models. The generated catalog stays on the server.

import { getModel } from "./index";
import type { ModelEntry, VideoModel } from "./types";

const extra = new Map<string, VideoModel>();

export function rememberModels(models: readonly VideoModel[]) {
  for (const model of models) extra.set(model.id, model);
}

export function lookupModel(id: string): ModelEntry | undefined {
  return getModel(id) ?? extra.get(id);
}

export function lookupModelName(id: string) {
  return lookupModel(id)?.name ?? id;
}
