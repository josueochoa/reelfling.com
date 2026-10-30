// Prompt mentions of reference inputs: "@Image 2", "@video1", "@img 3", "@Imagen 2", …
// The editor always writes the canonical "@Image 2" form; providers with a
// different syntax get it rewritten at submit time.

export type RefKind = "Image" | "Video" | "Audio";

/**
 * Matches a mention; group 1 = kind alias, group 2 = number or "?" (removed reference).
 * Spanish aliases ("@Imagen 2", "@Vídeo 1") are accepted too.
 */
export const MENTION_RE = /@(images?|imagen|img|v[ií]deos?|vid|audios?)\s?(\d+|\?)/gi;

function kindOf(alias: string): RefKind {
  const a = alias.toLowerCase();
  if (a.startsWith("i")) return "Image";
  if (a.startsWith("v")) return "Video";
  return "Audio";
}

export const mentionToken = (kind: RefKind, n: number | "?") => `@${kind} ${n}`;

export interface RefCounts {
  Image: number;
  Video: number;
  Audio: number;
}

/** Mentions that don't point at an attached reference. */
export function invalidMentions(prompt: string, counts: RefCounts): string[] {
  const bad = new Set<string>();
  for (const m of prompt.matchAll(MENTION_RE)) {
    const kind = kindOf(m[1]);
    const n = m[2] === "?" ? NaN : Number(m[2]);
    if (!(n >= 1 && n <= counts[kind])) bad.add(m[0]);
  }
  return [...bad];
}

/** Rewrites every mention into the provider's syntax. */
export function normalizeMentions(prompt: string, syntax: (kind: RefKind, n: number) => string) {
  return prompt.replace(MENTION_RE, (_, alias: string, n: string) => syntax(kindOf(alias), Number(n)));
}

/**
 * Keeps mentions pointing at the same references after the list changes (removed,
 * reordered). `prev` and `next` are reference ids in order; numbering is per kind.
 * A removed reference's mentions become "@Image ?" so they're flagged.
 */
export function remapMentions(
  prompt: string,
  prev: { id: string; kind: RefKind }[],
  next: { id: string; kind: RefKind }[],
) {
  const position = (list: typeof prev, kind: RefKind) => list.filter((r) => r.kind === kind).map((r) => r.id);
  const maps = new Map<RefKind, Map<number, number | "?">>();
  for (const kind of ["Image", "Video", "Audio"] as const) {
    const before = position(prev, kind);
    const after = position(next, kind);
    maps.set(kind, new Map(before.map((id, i) => [i + 1, after.indexOf(id) + 1 || "?"])));
  }
  return prompt.replace(MENTION_RE, (match, alias: string, n: string) => {
    const kind = kindOf(alias);
    const to = n === "?" ? undefined : maps.get(kind)!.get(Number(n));
    return to === undefined || to === Number(n) ? match : mentionToken(kind, to);
  });
}

/**
 * Higgsfield-style mentions, "@[Imagen 2](image_2)": any label, then the reference it
 * points at. The target decides the kind and number, so localized labels work.
 */
const HIGGSFIELD_RE = /@\[[^\]\n]*\]\(\s*(image|img|video|audio)[\s_-]?(\d+)\s*\)/gi;

/** Rewrites Higgsfield mentions into ours ("@Image 2"). Returns how many were converted. */
export function convertHiggsfieldMentions(text: string) {
  let count = 0;
  const converted = text.replace(HIGGSFIELD_RE, (_, alias: string, n: string) => {
    count++;
    return mentionToken(kindOf(alias), Number(n));
  });
  return { text: converted, count };
}

/** Splits a prompt into text and mention segments, for highlighting. */
export function segmentPrompt(prompt: string, counts: RefCounts) {
  const parts: { text: string; mention?: "ok" | "bad"; kind?: RefKind; n?: number }[] = [];
  let last = 0;
  for (const m of prompt.matchAll(MENTION_RE)) {
    if (m.index > last) parts.push({ text: prompt.slice(last, m.index) });
    const kind = kindOf(m[1]);
    const n = Number(m[2]);
    parts.push({ text: m[0], mention: n >= 1 && n <= counts[kind] ? "ok" : "bad", kind, n });
    last = m.index + m[0].length;
  }
  if (last < prompt.length) parts.push({ text: prompt.slice(last) });
  return parts;
}
