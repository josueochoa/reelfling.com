// Sequence grouping for extended clips. Pure: no catalog, no database, no secrets.
// A part number is assigned when a clip is continued. The feed groups parts that share a sequence id.

import type { GenerateRequest } from "./types";

export interface SequenceItem {
  id: string;
  sequenceId?: string;
  part?: number;
  createdAt: number;
}

export interface SequencePlan {
  sequenceId: string;
  /** Part number for the new clip. */
  part: number;
  /** Written onto the source when it is not in a sequence yet. */
  sourcePatch?: { sequenceId: string; part: number };
}

/**
 * The next part in the source clip's sequence. The source becomes part 1 the
 * first time something continues it. Later parts append after the highest number.
 */
export function nextSequencePart(
  source: { id: string; sequenceId?: string; part?: number },
  usedParts: readonly (number | undefined)[],
): SequencePlan {
  const sequenceId = source.sequenceId || source.id;
  const sourcePart = source.part ?? 1;
  const known = usedParts.filter(
    (part): part is number => typeof part === "number" && Number.isInteger(part) && part >= 1,
  );
  const part = Math.max(sourcePart, ...known, 0) + 1;
  const sourcePatch =
    source.sequenceId !== sequenceId || source.part == null ? { sequenceId, part: sourcePart } : undefined;
  return { sequenceId, part, sourcePatch };
}

/**
 * Newest sequence first. Parts inside a sequence run from part 1 upward.
 * A clip with no sequence id is its own group.
 */
export function groupFeed<T extends SequenceItem>(items: readonly T[]): { id: string; parts: T[] }[] {
  const newestFirst = [...items].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  const buckets = new Map<string, T[]>();
  const order: string[] = [];
  for (const item of newestFirst) {
    const key = item.sequenceId || item.id;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else {
      buckets.set(key, [item]);
      order.push(key);
    }
  }
  return order.map((id) => ({
    id,
    parts: buckets
      .get(id)!
      .slice()
      .sort((a, b) => (a.part ?? 1) - (b.part ?? 1) || a.createdAt - b.createdAt),
  }));
}

/** Two or more clips share a sequence, so the feed numbers them. */
export function isNumberedSequence(parts: readonly unknown[]): boolean {
  return parts.length > 1;
}

/** The next generation. The frame is an upload key on every route; the provider mapper places it. */
export function continueFromFrame(
  source: {
    id: string;
    model: string;
    prompt: string;
    ratio: string;
    resolution: string;
    duration: number;
    generateAudio?: boolean;
    route?: string;
  },
  frameKey: string,
): GenerateRequest {
  return {
    model: source.model,
    prompt: source.prompt,
    mode: "frames",
    ratio: source.ratio,
    resolution: source.resolution,
    duration: source.duration,
    ...(source.generateAudio !== undefined && { generateAudio: source.generateAudio }),
    ...(source.route && { route: source.route }),
    firstFrame: `upload:${frameKey}`,
    continueFrom: source.id,
  };
}
