// Inspector rows for a generation. Route is shown only when the record has one.

import { estimateCost } from "@/lib/registry";
import { lookupModel, lookupModelName } from "@/lib/registry/lookup";
import type { Generation } from "@/lib/types";
import { detailRoute, formatCreated, type ViewerDetail } from "./model";

export function videoDetails(gen: Generation): ViewerDetail[] {
  const model = lookupModel(gen.model);
  const route = detailRoute(gen);
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
  if (gen.seed !== undefined) rows.push({ label: "Seed", value: String(gen.seed) });
  if (cost !== undefined) rows.push({ label: "Cost", value: `$${cost.toFixed(2)}` });
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
}): ViewerDetail[] {
  const route = detailRoute(gen);
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
