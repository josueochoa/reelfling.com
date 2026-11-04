// Inspector rows for a generation. Route is shown only when the record has one.

import { cameraSummary, estimateCost } from "@/lib/registry";
import { lookupModel, lookupModelName } from "@/lib/registry/lookup";
import type { Generation } from "@/lib/types";
import { detailRoute, formatCreated, type ViewerDetail } from "./model";

export function videoDetails(gen: Generation): ViewerDetail[] {
  const model = lookupModel(gen.model);
  const route = detailRoute(gen.route);
  const camera = cameraSummary(gen.cameraMoves, gen.cameraMove);
  const billed = gen.billedSeconds;
  const hadReferenceVideo = gen.inputs.videos > 0;
  const computed =
    model &&
    estimateCost(model, {
      resolution: gen.resolution,
      duration: billed ?? gen.duration,
      audio: gen.generateAudio,
      ...(hadReferenceVideo && billed !== undefined ? { referenceVideoSeconds: 0, durationIsBilled: true } : {}),
    });
  const cost = gen.estimatedCost ?? computed;
  const rows: ViewerDetail[] = [{ label: "Model", value: model?.name ?? gen.model }];
  if (route) rows.push({ label: "Route", value: route });
  rows.push(
    { label: "Resolution", value: gen.resolution },
    { label: "Ratio", value: gen.ratio },
    { label: "Duration", value: `${gen.duration}s` },
    { label: "Audio", value: gen.generateAudio ? "On" : "Off" },
  );
  if (camera) rows.push({ label: "Camera", value: camera });
  if (gen.billedSeconds !== undefined) rows.push({ label: "Billed", value: `${gen.billedSeconds}s` });
  if (gen.seed !== undefined) rows.push({ label: "Seed", value: String(gen.seed) });
  if (gen.tokens !== undefined) rows.push({ label: "Tokens", value: gen.tokens.toLocaleString() });
  if (cost !== undefined) rows.push({ label: "Cost", value: `$${cost.toFixed(2)}` });
  if (gen.completedAt !== undefined) {
    const secs = Math.max(0, Math.round((gen.completedAt - gen.createdAt) / 1000));
    rows.push({ label: "Render time", value: secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, "0")}s` });
  }
  rows.push({ label: "Task", value: gen.taskId });
  rows.push({ label: "Created", value: formatCreated(gen.createdAt) });
  return rows;
}

export function imageDetails(gen: {
  model: string;
  ratio: string;
  aspect?: string;
  resolution: string;
  quality?: string;
  cost: number;
  createdAt: number;
  route?: string;
}): ViewerDetail[] {
  const route = detailRoute(gen.route);
  const rows: ViewerDetail[] = [{ label: "Model", value: lookupModelName(gen.model) }];
  if (route) rows.push({ label: "Route", value: route });
  rows.push(
    { label: "Resolution", value: gen.resolution.toUpperCase() },
    { label: "Ratio", value: gen.aspect ?? gen.ratio },
  );
  if (gen.quality) rows.push({ label: "Quality", value: gen.quality });
  if (gen.cost !== undefined) rows.push({ label: "Cost", value: `$${gen.cost.toFixed(3)}` });
  rows.push({ label: "Created", value: formatCreated(gen.createdAt) });
  return rows;
}
