// Prompt Enhance. The rewrite runs on the user's OpenRouter or fal key (see enhanceCall.ts).
// @mentions and #chips are swapped for placeholders here, then checked after the rewrite.
// The instruction alone is not the guarantee.

import { availabilityFor, type Availability } from "./registry/availability";
import type { PromptExpansion } from "./registry/types";

/** Providers that can run the rewrite. Order is the availability hint order. */
export const ENHANCE_PROVIDERS = ["openrouter", "fal"] as const;
export type EnhanceProvider = (typeof ENHANCE_PROVIDERS)[number];

/**
 * Cheap text model for the rewrite.
 * Checked 4 Nov 2026, no key, against https://openrouter.ai/api/v1/models:
 * `openai/gpt-4.1-nano` is listed, text in and text out, $0.10 / $0.40 per million tokens.
 * fal `openrouter/router/openai/v1/chat/completions` is an OpenAI-compatible passthrough
 * (https://api.fal.ai/v1/models?endpoint_id=openrouter/router/openai/v1/chat/completions),
 * so the same id is sent there.
 */
export const ENHANCE_MODEL = "openai/gpt-4.1-nano";

export interface EnhanceMessage {
  role: "system" | "user";
  content: string;
}

/** A catalog model, or the slim picker copy of one. */
export interface ExpansionModel {
  routes: readonly { endpoint: string }[];
  capabilities: { promptExpansion: PromptExpansion };
}

export interface NativeExpansion {
  field: "enable_prompt_expansion" | "prompt_expansion_mode";
  value: true | "balanced";
  /** Short label for the composer toggle. */
  label: string;
  /** Shown while the toggle is on. */
  detail: string;
}

const WAN_ENDPOINT = /^alibaba\/wan-3\.0(\/|$)/;
const MINIMAX_H3_ENDPOINT = /^minimax\/h3\//;

/**
 * Wan `enable_prompt_expansion` and MiniMax H3 `prompt_expansion_mode`, checked on the
 * live fal schemas (4 Nov 2026, no key). Other expanders stay off until their flag is known.
 * OpenRouter Wan is `promptExpansion: false` in the catalog, so it does not match.
 */
export function nativeExpansionOf(model: ExpansionModel): NativeExpansion | null {
  if (model.capabilities.promptExpansion === false) return null;
  const endpoints = model.routes.map((route) => route.endpoint);
  if (endpoints.some((endpoint) => WAN_ENDPOINT.test(endpoint))) {
    return {
      field: "enable_prompt_expansion",
      value: true,
      label: "Expand prompt",
      detail: "Wan rewrites this prompt. Enhance stays off.",
    };
  }
  if (endpoints.some((endpoint) => MINIMAX_H3_ENDPOINT.test(endpoint))) {
    return {
      field: "prompt_expansion_mode",
      value: "balanced",
      label: "Expand prompt",
      detail: "MiniMax rewrites this prompt. Enhance stays off.",
    };
  }
  return null;
}

/** Native on: send the flag and do not call the rewrite model. Otherwise the LLM may run. */
export function expansionChoice(nativeOn: boolean, model: ExpansionModel | null | undefined) {
  const flag = model ? nativeExpansionOf(model) : null;
  if (nativeOn && flag) return { callLlm: false as const, flag };
  return { callLlm: true as const, flag: null };
}

/** Adds the native flag to a fal queue body. No network. Off leaves the body unchanged. */
export function applyNativeExpansion<T extends Record<string, unknown>>(input: T, model: ExpansionModel, enabled: boolean): T {
  if (!enabled) return input;
  const native = nativeExpansionOf(model);
  if (!native) return input;
  return { ...input, [native.field]: native.value };
}

export function enhanceAvailability(keyed: ReadonlySet<string>): Availability {
  return availabilityFor(ENHANCE_PROVIDERS, keyed);
}

/** OpenRouter when both keys exist. The spec lists that endpoint first. */
export function enhanceProvider(keyed: ReadonlySet<string>): EnhanceProvider | null {
  if (keyed.has("openrouter")) return "openrouter";
  if (keyed.has("fal")) return "fal";
  return null;
}

const GUIDES: Record<string, string> = {
  Wan: "Name the subject, the action, the place, and the light. One motion at a time.",
  Alibaba: "Name the subject, the action, the place, and the light. One motion at a time.",
  MiniMax: "Lead with the subject and what it does, then the setting and the light. Short sentences.",
  H3: "Lead with the subject and what it does, then the setting and the light. Short sentences.",
  Kling: "Describe the shot as a camera would see it: subject, action, setting, and how the light falls.",
  Seedance: "Write one clear shot: subject, action, place, and light. Skip stacked metaphors.",
  ByteDance: "Write one clear shot: subject, action, place, and light. Skip stacked metaphors.",
  Google: "State what is in frame and what changes. Concrete nouns, one action.",
  Gemini: "State what is in frame and what changes. Concrete nouns, one action.",
  Flux: "Describe the picture: subject, materials, light, and framing.",
  FLUX: "Describe the picture: subject, materials, light, and framing.",
  "FLUX.1": "Describe the picture: subject, materials, light, and framing.",
  "Black Forest Labs": "Describe the picture: subject, materials, light, and framing.",
  Grok: "Plain visual description: who or what, the action, the place, the light.",
  Luma: "One shot: subject, motion, setting, and light.",
  Seedream: "Describe the still: subject, materials, light, and composition.",
  Ideogram: "Describe the image. Put any words that must appear in quotes.",
  Recraft: "Describe the style, the subject, and the palette in plain words.",
  "GPT Image": "Describe the image directly. Put any text that must appear in quotes.",
  "Nano Banana": "Describe the picture. For an edit, say what changes and what stays.",
};

export function familyGuide(family: string): string {
  return (
    GUIDES[family] ??
    "Make the prompt specific and visual: subject, action, setting, light, and mood. Do not add a camera move the user did not ask for."
  );
}

export interface Shield {
  text: string;
  tokens: string[];
  marker: string;
}

interface Span {
  start: number;
  end: number;
  text: string;
}

function mentionSpans(prompt: string): Span[] {
  const re = /@(images?|imagen|img|v[ií]deos?|vid|audios?)\s?(\d+|\?)/gi;
  return [...prompt.matchAll(re)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    text: match[0],
  }));
}

/** `#push-in`, `#static`, and any other #chip. The hash is part of the token. */
function chipSpans(prompt: string): Span[] {
  const re = /(?:^|[\s([{"'])#([A-Za-z][A-Za-z0-9_-]*)/g;
  const spans: Span[] = [];
  for (const match of prompt.matchAll(re)) {
    const text = `#${match[1]}`;
    const end = match.index + match[0].length;
    spans.push({ start: end - text.length, end, text });
  }
  return spans;
}

function markerFor(prompt: string): string {
  let marker = "RF";
  while (prompt.includes(`[[${marker}`)) marker += "x";
  return marker;
}

/** Replaces @mentions and #chips with `[[RF0]]` placeholders, in order. */
export function shieldPrompt(prompt: string): Shield {
  const spans = [...mentionSpans(prompt), ...chipSpans(prompt)].sort((a, b) => a.start - b.start || a.end - b.end);
  const kept: Span[] = [];
  for (const span of spans) {
    const prev = kept[kept.length - 1];
    if (prev && span.start < prev.end) continue;
    kept.push(span);
  }
  const marker = markerFor(prompt);
  const tokens: string[] = [];
  let text = "";
  let cursor = 0;
  for (const span of kept) {
    text += prompt.slice(cursor, span.start);
    text += `[[${marker}${tokens.length}]]`;
    tokens.push(span.text);
    cursor = span.end;
  }
  text += prompt.slice(cursor);
  return { text, tokens, marker };
}

export class EnhanceError extends Error {
  status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.status = status;
  }
}

function unwrapFence(text: string): string {
  const trimmed = text.trim();
  const fence = /^```(?:\w+)?\s*\n([\s\S]*?)\n```$/.exec(trimmed);
  return fence ? fence[1].trim() : trimmed;
}

/**
 * Puts the original tokens back. Each placeholder must appear once.
 * A dropped, duplicated, or rewritten token throws.
 */
export function restoreShield(raw: string, shield: Shield): string {
  const body = unwrapFence(raw);
  const re = new RegExp(`\\[\\[${shield.marker}(\\d+)\\]\\]`, "g");
  const seen = new Map<number, number>();
  const restored = body.replace(re, (_full, n: string) => {
    const index = Number(n);
    if (!Number.isInteger(index) || index < 0 || index >= shield.tokens.length) {
      throw new EnhanceError("The rewrite changed a reference or chip. Try again.");
    }
    seen.set(index, (seen.get(index) ?? 0) + 1);
    return shield.tokens[index];
  });
  for (let i = 0; i < shield.tokens.length; i++) {
    if (seen.get(i) !== 1) throw new EnhanceError("The rewrite changed a reference or chip. Try again.");
  }
  return restored.trim();
}

export function enhanceMessages(input: {
  prompt: string;
  family: string;
  guide: string;
  cameras: readonly string[];
  looks: readonly string[];
  references: readonly string[];
  marker: string;
}): EnhanceMessage[] {
  const family = input.family.trim() || "selected";
  const lines = [
    `You rewrite prompts for the ${family} model.`,
    input.guide,
    "Keep the prompt's language. A Spanish prompt stays Spanish unless the user asks for English.",
    `The prompt may contain protected tokens like [[${input.marker}0]]. Copy each protected token through unchanged, once. Do not translate, renumber, or drop one.`,
    input.cameras.length ? `Camera chips already chosen, applied separately: ${input.cameras.join("; ")}.` : "",
    input.looks.length ? `Look chips already chosen: ${input.looks.join("; ")}.` : "",
    input.references.length ? `References: ${input.references.join("; ")}.` : "",
    "Return only the rewritten prompt.",
  ].filter(Boolean);
  return [
    { role: "system", content: lines.join("\n") },
    { role: "user", content: input.prompt },
  ];
}

export interface DiffPart {
  kind: "same" | "add" | "del";
  text: string;
}

function tokenize(text: string): string[] {
  // Trailing space stays with its word, so a replacement doesn't sit against the next word.
  return text.match(/\S+\s*/g) ?? [];
}

/** Word-level diff for the accept / undo review. Prompts are short, so a full table is fine. */
export function wordDiff(before: string, after: string): DiffPart[] {
  const a = tokenize(before);
  const b = tokenize(after);
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const parts: DiffPart[] = [];
  const push = (kind: DiffPart["kind"], text: string) => {
    const last = parts[parts.length - 1];
    if (last && last.kind === kind) last.text += text;
    else parts.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push("same", a[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push("del", a[i]);
      i++;
    } else {
      push("add", b[j]);
      j++;
    }
  }
  while (i < n) push("del", a[i++]);
  while (j < m) push("add", b[j++]);
  return parts;
}
