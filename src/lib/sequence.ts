// Sequence grouping for extended clips. Pure: no catalog, no database, no secrets.
// The feed groups parts that share a sequence id.

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
