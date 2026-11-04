// Look chips. Options and the per-family prompt templates live in looks.json.
// Auto is the default and adds nothing. A custom palette is a swatch reference
// when the request is in references mode and the model accepts image references.
// Frames mode always describes the colors in the prompt, so start, middle, and
// end frames stay frames.

import file from "./looks.json" with { type: "json" };

export const LOOK_GROUPS = ["camera", "lens", "aperture", "lighting", "palette", "era"] as const;
export type LookGroup = (typeof LOOK_GROUPS)[number];

export const PALETTE_CUSTOM = "custom";
export const PALETTE_COLOR_MAX = 5;
export const SAVED_LOOK_MAX = 24;
export const PALETTE_SWATCH_NAME = "Palette swatch.jpg";

const HEX = /^#[0-9a-f]{6}$/;

export interface LookOption {
  id: string;
  name: string;
  /** Sentence fragment. Absent on Auto and on the custom palette. */
  line?: string;
}

export interface LookGroupDef {
  id: LookGroup;
  label: string;
  options: LookOption[];
}

/** One chosen option per group. Missing or Auto means no line. */
export interface LookChoice {
  camera?: string;
  lens?: string;
  aperture?: string;
  lighting?: string;
  palette?: string;
  era?: string;
  /** Up to five #rrggbb colors when palette is custom. */
  colors?: string[];
}

export interface SavedLook {
  id: string;
  name: string;
  choice: LookChoice;
}

interface LookFile {
  line: Record<string, string>;
  swatch: Record<string, string>;
  colors: Record<string, string>;
  groups: LookGroupDef[];
}

function checked(raw: LookFile): LookFile {
  if (!raw.line?.default?.includes("{line}")) throw new Error("Look templates need a default {line}");
  if (!raw.colors?.default?.includes("{colors}")) throw new Error("Look templates need a default {colors}");
  if (!raw.swatch?.default) throw new Error("Look templates need a default swatch line");
  if (raw.groups.length !== LOOK_GROUPS.length) throw new Error("Look groups are camera, lens, aperture, lighting, palette, era");
  raw.groups.forEach((group, index) => {
    if (group.id !== LOOK_GROUPS[index]) throw new Error(`Look group ${index} must be ${LOOK_GROUPS[index]}`);
    if (!group.label) throw new Error(`${group.id} needs a label`);
    const ids = new Set<string>();
    if (group.options[0]?.id !== "auto") throw new Error(`${group.id} must start with Auto`);
    for (const option of group.options) {
      if (!option.id || ids.has(option.id)) throw new Error(`Bad look option "${option.id}"`);
      ids.add(option.id);
      if (!option.name) throw new Error(`${option.id} needs a name`);
      const custom = group.id === "palette" && option.id === PALETTE_CUSTOM;
      if (option.id !== "auto" && !custom && !option.line) throw new Error(`${option.id} needs a line`);
      if ((option.id === "auto" || custom) && option.line) throw new Error(`${option.id} adds nothing of its own`);
    }
    if (group.id === "palette" && !ids.has(PALETTE_CUSTOM)) throw new Error("Palette needs a custom option");
    if (group.id !== "palette" && [...ids].includes(PALETTE_CUSTOM)) throw new Error(`${group.id} cannot be custom`);
  });
  return raw;
}

const data = checked(file as LookFile);

export const lookGroups: readonly LookGroupDef[] = data.groups;

function groupOf(id: LookGroup): LookGroupDef {
  return data.groups[LOOK_GROUPS.indexOf(id)];
}

export function lookOption(group: LookGroup, id: string | undefined): LookOption | undefined {
  if (!id) return undefined;
  return groupOf(group).options.find((option) => option.id === id);
}

export function isHexColor(value: string): boolean {
  return HEX.test(value);
}

/** Drops Auto, unknown ids, and anything past five valid colors. */
export function keptLook(raw: unknown): LookChoice {
  if (!raw || typeof raw !== "object") return {};
  const src = raw as Record<string, unknown>;
  const choice: LookChoice = {};
  for (const group of LOOK_GROUPS) {
    const id = src[group];
    if (typeof id !== "string" || id === "auto" || !lookOption(group, id)) continue;
    choice[group] = id;
  }
  if (choice.palette === PALETTE_CUSTOM) {
    const colors = Array.isArray(src.colors)
      ? src.colors.flatMap((color) => (typeof color === "string" && isHexColor(color) ? [color.toLowerCase()] : [])).slice(0, PALETTE_COLOR_MAX)
      : [];
    if (colors.length) choice.colors = colors;
    else delete choice.palette;
  }
  return choice;
}

export function lookIsEmpty(choice: LookChoice | undefined): boolean {
  if (!choice) return true;
  return LOOK_GROUPS.every((group) => !choice[group]);
}

/** The chips a saved look puts back, in one step. */
export function applySavedLook(look: SavedLook): LookChoice {
  return keptLook(look.choice);
}

type LookModel = { family: string; capabilities: { references: { image: number } } };

export type LookMode = "frames" | "references";

export function modelTakesImageRefs(model: { capabilities: { references: { image: number } } }): boolean {
  return model.capabilities.references.image > 0;
}

/**
 * Custom palette rides along as an image only in references mode, on a model
 * that accepts image references. Frames mode is always text, so keyframes are
 * not turned into references.
 */
export function paletteUsesSwatch(
  model: { capabilities: { references: { image: number } } },
  choice: LookChoice | undefined,
  mode?: LookMode,
): boolean {
  if (mode === "frames") return false;
  const kept = keptLook(choice);
  return kept.palette === PALETTE_CUSTOM && !!kept.colors?.length && modelTakesImageRefs(model);
}

function familyLine(table: Record<string, string>, family: string): string {
  return table[family] ?? table.default;
}

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? "");
}

function appendFragment(prompt: string, line: string): string {
  const base = prompt.trim();
  const next = line.trim();
  if (!next) return base;
  if (!base) return next;
  if (base.endsWith(next)) return base;
  return /[.!?…]$/.test(base) ? `${base} ${next}` : `${base}. ${next}`;
}

export interface CompiledLook {
  prompt: string;
  /** The custom palette is attached as an image reference, not written as hex. */
  swatch: boolean;
}

/** Appends each chosen chip's family line. Auto and unknown ids add nothing. */
export function compileLook(
  model: LookModel,
  prompt: string,
  choice: LookChoice | undefined,
  mode?: LookMode,
): CompiledLook {
  const kept = keptLook(choice);
  let text = prompt;
  const swatch = paletteUsesSwatch(model, kept, mode);
  for (const group of LOOK_GROUPS) {
    const id = kept[group];
    if (!id) continue;
    if (group === "palette" && id === PALETTE_CUSTOM) {
      text = appendFragment(
        text,
        swatch
          ? familyLine(data.swatch, model.family)
          : fill(familyLine(data.colors, model.family), { colors: (kept.colors ?? []).join(", ") }),
      );
      continue;
    }
    const option = lookOption(group, id);
    if (!option?.line) continue;
    text = appendFragment(text, fill(familyLine(data.line, model.family), { line: option.line }));
  }
  return { prompt: text.trim(), swatch };
}

function lookMode(mode: string | undefined): LookMode | undefined {
  return mode === "frames" || mode === "references" ? mode : undefined;
}

/** Provider copy: chip ids stay on the record, the prompt gains the lines. Frames are left as frames. */
export function applyLook<T extends { prompt: string; look?: LookChoice; mode?: string }>(
  model: LookModel,
  req: T,
): Omit<T, "look"> {
  const compiled = compileLook(model, req.prompt, req.look, lookMode(req.mode));
  const next = { ...req, prompt: compiled.prompt };
  delete next.look;
  return next;
}
