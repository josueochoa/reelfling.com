import type { VideoModel } from "./types";

export interface ModelBadge {
  id: "audio" | "end" | "refs" | "duration";
  label: string;
}

/** Picker marks: audio, end frame, references, and the longest duration. */
export function modelBadges(model: VideoModel): ModelBadge[] {
  const caps = model.capabilities;
  const badges: ModelBadge[] = [];
  if (caps.audio) badges.push({ id: "audio", label: "Audio" });
  if (caps.frames.end) badges.push({ id: "end", label: "End" });
  if (caps.references.image + caps.references.video > 0) badges.push({ id: "refs", label: "Refs" });
  if (caps.durations) badges.push({ id: "duration", label: `${caps.durations.max}s` });
  return badges;
}

/** Groups by family, keeping the family where its first model already sits. */
export function groupByFamily<T extends { family: string }>(models: readonly T[]): { family: string; models: T[] }[] {
  const order: string[] = [];
  const by = new Map<string, T[]>();
  for (const model of models) {
    const family = model.family || "Model";
    const list = by.get(family);
    if (list) list.push(model);
    else {
      order.push(family);
      by.set(family, [model]);
    }
  }
  return order.map((family) => ({ family, models: by.get(family)! }));
}
