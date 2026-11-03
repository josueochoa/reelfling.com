// Presets live in camera-presets.json. Adding one is a JSON edit: id, name,
// description, category, a prompt line per model family, and an optional native
// mapping. This file only applies that data.

import type { GenerateRequest } from "../types";
import type { VideoModel, VideoTask } from "./types";
import presetsFile from "./camera-presets.json" with { type: "json" };

interface NativeMapping {
  param: "camera_fixed";
  value: boolean;
}

export interface CameraPreset {
  id: string;
  name: string;
  description: string;
  category: string;
  prompts: Record<string, string>;
  native?: NativeMapping[];
}

interface PresetFile {
  max: number;
  presets: CameraPreset[];
}

function checked(file: PresetFile): PresetFile {
  if (!Number.isInteger(file.max) || file.max < 1) throw new Error("Camera presets need a max");
  const ids = new Set<string>();
  for (const preset of file.presets) {
    if (!preset.id || ids.has(preset.id)) throw new Error(`Bad camera preset id "${preset.id}"`);
    ids.add(preset.id);
    if (!preset.name || !preset.description || !preset.category) throw new Error(`${preset.id} is missing a label`);
    if (!preset.prompts?.default) throw new Error(`${preset.id} needs a default prompt`);
    for (const native of preset.native ?? []) {
      if (native.param !== "camera_fixed" || typeof native.value !== "boolean")
        throw new Error(`${preset.id} native mapping must be the camera_fixed boolean`);
    }
  }
  return file;
}

const file = checked(presetsFile as PresetFile);
const byId = new Map(file.presets.map((preset) => [preset.id, preset]));

export const CAMERA_MOVE_MAX = file.max;
export const cameraPresets: readonly CameraPreset[] = file.presets;

export function isCameraMove(value: string): boolean {
  return byId.has(value);
}

export function cameraPreset(id: string): CameraPreset | undefined {
  return byId.get(id);
}

export function cameraMoveLabel(id: string | undefined): string | undefined {
  if (!id) return undefined;
  return byId.get(id)?.name;
}

/** Names for the history card and detail, in chip order. Reads the legacy single field too. */
export function cameraSummary(moves?: readonly string[], legacy?: string): string | undefined {
  const ids = moves?.length ? moves : legacy ? [legacy] : [];
  const names = ids.flatMap((id) => {
    const name = cameraMoveLabel(id);
    return name ? [name] : [];
  });
  return names.length ? names.join(", ") : undefined;
}

const PROMPT_TASKS = new Set<VideoTask>(["t2v", "i2v", "ref2v"]);

function allowsPrompt(model: VideoModel): boolean {
  const camera = model.capabilities.camera;
  if (camera && camera.prompt === false) return false;
  if (camera && camera.prompt === true) return true;
  return PROMPT_TASKS.has(model.task);
}

function acceptedParams(model: VideoModel): Set<string> {
  const camera = model.capabilities.camera;
  if (!camera || !camera.params) return new Set();
  return new Set(camera.params);
}

/** Presets the composer can offer. Empty means the picker is hidden. */
export function cameraMovesFor(model: VideoModel): string[] {
  const params = acceptedParams(model);
  const prompt = allowsPrompt(model);
  if (!prompt && params.size === 0) return [];
  return cameraPresets
    .filter((preset) => prompt || (preset.native ?? []).some((entry) => params.has(entry.param)))
    .map((preset) => preset.id);
}

/**
 * Chips Reuse puts back, in order. `moves` is the current field. `legacy` is the
 * single preset stored before chips existed. Drops moves this model ignores.
 */
export function keptCameraMoves(model: VideoModel, moves?: readonly string[], legacy?: string): string[] {
  const raw = moves?.length ? moves : legacy ? [legacy] : [];
  const allowed = new Set(cameraMovesFor(model));
  const kept: string[] = [];
  for (const id of raw) {
    if (!isCameraMove(id) || !allowed.has(id) || kept.includes(id)) continue;
    kept.push(id);
    if (kept.length >= CAMERA_MOVE_MAX) break;
  }
  return kept;
}

function fragment(preset: CameraPreset, family: string): string {
  return preset.prompts[family] ?? preset.prompts.default;
}

function appendFragment(prompt: string, line: string): string {
  const base = prompt.trim();
  const next = line.trim();
  if (!next) return base;
  if (!base) return next;
  if (base.endsWith(next)) return base;
  return /[.!?…]$/.test(base) ? `${base} ${next}` : `${base}. ${next}`;
}

export interface CompiledCamera {
  prompt: string;
  /** Set when a chip maps onto BytePlus `camera_fixed`. */
  cameraFixed?: boolean;
  applied: string[];
}

/** Chips in order. Only a wired `camera_fixed` mapping replaces that chip's text. */
export function compileCamera(model: VideoModel, prompt: string, moves: readonly string[]): CompiledCamera {
  const allowed = new Set(cameraMovesFor(model));
  const fixed = acceptedParams(model).has("camera_fixed");
  let text = prompt;
  let cameraFixed: boolean | undefined;
  const applied: string[] = [];
  for (const id of moves) {
    if (applied.length >= CAMERA_MOVE_MAX) break;
    if (!allowed.has(id)) continue;
    const preset = byId.get(id);
    if (!preset || applied.includes(id)) continue;
    applied.push(id);
    const lock = fixed && (preset.native ?? []).find((entry) => entry.param === "camera_fixed" && entry.value === true);
    if (lock) {
      cameraFixed = true;
      continue;
    }
    text = appendFragment(text, fragment(preset, model.family));
  }
  return { prompt: text.trim(), ...(cameraFixed ? { cameraFixed } : {}), applied };
}

function requestedMoves(req: GenerateRequest): string[] {
  if (req.cameraMoves?.length) return req.cameraMoves;
  if (req.cameraMove) return [req.cameraMove];
  return [];
}

function withoutChips(req: GenerateRequest, dropFixed: boolean): GenerateRequest {
  const next = { ...req };
  delete next.cameraMove;
  delete next.cameraMoves;
  if (dropFixed) delete next.cameraFixed;
  return next;
}

/**
 * The request a provider should see. The user's prompt and chip ids stay on the
 * generation record; this returns the compiled copy.
 */
export function applyCameraMoves(model: VideoModel, req: GenerateRequest): GenerateRequest {
  const moves = requestedMoves(req);
  if (!moves.length) return withoutChips(req, false);
  const compiled = compileCamera(model, req.prompt, moves);
  return { ...withoutChips(req, true), prompt: compiled.prompt, ...(compiled.cameraFixed ? { cameraFixed: true } : {}) };
}
