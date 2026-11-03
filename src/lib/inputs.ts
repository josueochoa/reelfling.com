// What a generation was given, so Reuse can put it back. Older rows only have counts
// (`inputs.images` and friends); the keys below are optional and absent on those.

import { mentionToken, remapMentions, type RefKind } from "./mentions";
import type { Generation, GenerationMode, MediaBlock } from "./types";

const REF_KIND: Record<MediaBlock["kind"], RefKind> = { image: "Image", video: "Video", audio: "Audio" };

export interface RestoreResult {
  mode: GenerationMode;
  /** Prompt, with mentions renumbered when a reference block could not be restored. */
  prompt: string;
  firstFrameKey?: string;
  lastFrameKey?: string;
  /** Library keys of the reference blocks that are still available, in their original order. */
  referenceKeys: string[];
  /** Set when a stored file is gone. Undefined for old count-only records. */
  notice?: string;
}

function frameLabel(role: "Start frame" | "End frame", name?: string) {
  const clean = name?.trim();
  return clean ? `${role} "${clean}"` : role;
}

/** "@Image 2 (roof.png)" using the numbering the prompt was written with. */
function blockLabels(blocks: MediaBlock[]) {
  const n: Record<MediaBlock["kind"], number> = { image: 0, video: 0, audio: 0 };
  return blocks.map((b) => {
    const mention = mentionToken(REF_KIND[b.kind], ++n[b.kind]);
    const clean = b.name?.trim();
    return clean ? `${mention} (${clean})` : mention;
  });
}

function missingNotice(labels: string[]): string | undefined {
  if (!labels.length) return undefined;
  const list = labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
  return `${list} ${labels.length === 1 ? "is" : "are"} no longer in your uploads. Everything else was restored.`;
}

/**
 * Decides what Reuse can put back. `available` is the set of library keys that still
 * exist. Records that only stored counts restore the prompt unchanged and no media.
 */
export function restoreInputs(
  gen: Pick<Generation, "mode" | "prompt" | "inputs">,
  available: ReadonlySet<string>,
): RestoreResult {
  const { inputs } = gen;
  const mode = gen.mode;
  const storedFrames = !!(inputs.firstFrameKey || inputs.lastFrameKey);
  const storedBlocks = !!inputs.blocks;

  if (!storedFrames && !storedBlocks) {
    return { mode, prompt: gen.prompt, referenceKeys: [] };
  }

  if (mode === "frames") {
    const missing: string[] = [];
    let firstFrameKey: string | undefined;
    let lastFrameKey: string | undefined;
    if (inputs.firstFrameKey) {
      if (available.has(inputs.firstFrameKey)) firstFrameKey = inputs.firstFrameKey;
      else missing.push(frameLabel("Start frame", inputs.firstFrameName));
    }
    if (inputs.lastFrameKey) {
      if (available.has(inputs.lastFrameKey)) lastFrameKey = inputs.lastFrameKey;
      else missing.push(frameLabel("End frame", inputs.lastFrameName));
    }
    return { mode, prompt: gen.prompt, firstFrameKey, lastFrameKey, referenceKeys: [], notice: missingNotice(missing) };
  }

  const blocks = inputs.blocks ?? [];
  const labels = blockLabels(blocks);
  const missing: string[] = [];
  const kept: { id: string; kind: RefKind }[] = [];
  blocks.forEach((b, i) => {
    if (available.has(b.key)) kept.push({ id: b.key, kind: REF_KIND[b.kind] });
    else missing.push(labels[i]);
  });
  const prev = blocks.map((b) => ({ id: b.key, kind: REF_KIND[b.kind] }));
  return {
    mode,
    prompt: remapMentions(gen.prompt, prev, kept),
    referenceKeys: kept.map((b) => b.id),
    notice: missingNotice(missing),
  };
}

// ---------------------------------------------------------------- orphan sweep

export interface StoredRecord {
  userId: string;
  /** Set when the generation lives in a shared workspace. Protects that workspace's copy of the key. */
  workspaceId?: string | null;
  data: string;
}

function pushKey(keys: string[], value: unknown) {
  if (typeof value === "string" && value) keys.push(value);
}

/** R2 keys a saved generation (video or image) points at. Malformed rows contribute nothing. */
export function keysInRecord(data: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const row = parsed as {
    inputs?: { firstFrameKey?: unknown; lastFrameKey?: unknown; blocks?: unknown };
    references?: unknown;
  };
  const keys: string[] = [];
  pushKey(keys, row.inputs?.firstFrameKey);
  pushKey(keys, row.inputs?.lastFrameKey);
  if (Array.isArray(row.inputs?.blocks)) {
    for (const block of row.inputs.blocks) {
      if (block && typeof block === "object" && "key" in block) pushKey(keys, (block as { key: unknown }).key);
    }
  }
  // Image generations store reference keys on the record itself.
  if (Array.isArray(row.references)) for (const key of row.references) pushKey(keys, key);
  return keys;
}

/** Distinct user ids on a page of orphan candidates. The sweep only reads their generations. */
export function candidateUserIds(rows: { user_id: string }[]): string[] {
  return [...new Set(rows.map((r) => r.user_id))];
}

/** `${userId}\\0${key}` for every file a saved generation still points at. */
export function referencedKeySet(records: StoredRecord[]): Set<string> {
  const set = new Set<string>();
  for (const rec of records) {
    for (const key of keysInRecord(rec.data)) {
      set.add(`${rec.userId}\0${key}`);
      // A teammate's generation protects the file even when user ids differ.
      if (rec.workspaceId) set.add(`\u0001${rec.workspaceId}\0${key}`);
    }
  }
  return set;
}

/** Drops assets whose key is stored on one of that user's (or that workspace's) generations. */
export function withoutReferenced<T extends { user_id: string; key: string; workspace_id?: string | null }>(
  rows: T[],
  referenced: Set<string>,
): T[] {
  return rows.filter((row) => {
    if (referenced.has(`${row.user_id}\0${row.key}`)) return false;
    if (row.workspace_id && referenced.has(`\u0001${row.workspace_id}\0${row.key}`)) return false;
    return true;
  });
}
