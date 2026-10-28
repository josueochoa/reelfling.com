// Prompt mentions of reference inputs: "@Image 2", "@video1", "@img 3", …
// The editor always writes the canonical "@Image 2" form; providers with a
// different syntax get it rewritten at submit time.

export type RefKind = "Image" | "Video" | "Audio";

/** Matches a mention; group 1 = kind alias, group 2 = number or "?" (removed reference). */
export const MENTION_RE = /@(images?|img|videos?|vid|audios?)\s?(\d+|\?)/gi;

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
 * Keeps mentions pointing at the right reference after one is removed:
 * later ones shift down, the removed one becomes "@Image ?" so it's flagged.
 */
export function renumberAfterRemoval(prompt: string, kind: RefKind, removed: number) {
  return prompt.replace(MENTION_RE, (match, alias: string, n: string) => {
    if (kindOf(alias) !== kind || n === "?") return match;
    const i = Number(n);
    if (i === removed) return mentionToken(kind, "?");
    return i > removed ? mentionToken(kind, i - 1) : match;
  });
}

/** Splits a prompt into text and mention segments, for highlighting. */
export function segmentPrompt(prompt: string, counts: RefCounts) {
  const parts: { text: string; mention?: "ok" | "bad" }[] = [];
  let last = 0;
  for (const m of prompt.matchAll(MENTION_RE)) {
    if (m.index > last) parts.push({ text: prompt.slice(last, m.index) });
    const n = Number(m[2]);
    parts.push({ text: m[0], mention: n >= 1 && n <= counts[kindOf(m[1])] ? "ok" : "bad" });
    last = m.index + m[0].length;
  }
  if (last < prompt.length) parts.push({ text: prompt.slice(last) });
  return parts;
}
