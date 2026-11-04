// Gallery templates are prompts we wrote, with typed slots. They run as normal
// reference-to-video generations on models the video tab already allows.
// Vendor effect endpoints (fal-ai/kling-video/v1.6/pro/effects,
// fal-ai/vidu/template-to-video) are not used. fal-ai/kling-video/o3/pro/reference-to-video
// is not in the schema-checked fal allowlist, so it is not a template route.
// Seedance 2.5 is the OpenRouter model. ModelArk's reference model on the video
// tab is Seedance 2.0. Preview clips are not generated here: `preview.video` and
// `preview.poster` are optional https or same-origin URLs, and the gallery draws
// a placeholder when neither is set.

import catalogFile from "./templates.json" with { type: "json" };
import type { GenerateRequest, TemplateSlotFill } from "../types";
import { isAssetKey } from "../uploads";

const CATEGORY_IDS = ["effects", "product", "ugc"] as const;
const SLOT_KINDS = ["character", "location", "product", "text"] as const;
const ROUTES = ["fal", "modelark", "openrouter"] as const;

export type TemplateCategory = (typeof CATEGORY_IDS)[number];
export type SlotKind = (typeof SLOT_KINDS)[number];
export type TemplateRoute = (typeof ROUTES)[number];

export interface TemplateCategoryInfo {
  id: TemplateCategory;
  label: string;
}

export interface TemplateSlot {
  id: string;
  kind: SlotKind;
  label: string;
  required: boolean;
  hint?: string;
  maxLength?: number;
}

export interface TemplatePreview {
  video?: string;
  poster?: string;
}

export interface VideoTemplate {
  id: string;
  name: string;
  category: TemplateCategory;
  summary: string;
  model: string;
  route: TemplateRoute;
  duration: number;
  ratio: string;
  resolution: string;
  /** Ask the model for audio when it offers it. */
  audio?: boolean;
  prompt: string;
  slots: TemplateSlot[];
  preview?: TemplatePreview;
}

export interface SlotInput {
  /** Image slot: `upload:<key>`, an https URL, or a data URL. */
  image?: string;
  /** Library key, stored so Use this template again can find the file. */
  key?: string;
  text?: string;
}

export interface SlotError {
  id: string;
  message: string;
}

const IMAGE_KINDS = new Set<SlotKind>(["character", "location", "product"]);

function fail(message: string): never {
  throw new Error(`templates.json: ${message}`);
}

/** https URL, or a same-origin path. Empty and anything else are ignored. */
function mediaUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("/") && !trimmed.startsWith("//") && !trimmed.includes("\\")) return trimmed;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function parseSlot(templateId: string, raw: unknown, seen: Set<string>): TemplateSlot {
  if (!raw || typeof raw !== "object") fail(`${templateId} has a slot that is not an object`);
  const slot = raw as Record<string, unknown>;
  const id = slot.id;
  const kind = slot.kind;
  const label = slot.label;
  if (typeof id !== "string" || !/^[a-z][a-z0-9-]{0,40}$/.test(id)) fail(`${templateId} has a bad slot id`);
  if (seen.has(id)) fail(`${templateId} repeats slot ${id}`);
  seen.add(id);
  if (typeof kind !== "string" || !SLOT_KINDS.includes(kind as SlotKind)) fail(`${templateId} slot ${id} has a bad kind`);
  if (typeof label !== "string" || !label.trim()) fail(`${templateId} slot ${id} needs a label`);
  if (typeof slot.required !== "boolean") fail(`${templateId} slot ${id} needs required true or false`);
  const maxLength = slot.maxLength;
  if (maxLength !== undefined && (typeof maxLength !== "number" || !Number.isInteger(maxLength) || maxLength < 1 || maxLength > 160))
    fail(`${templateId} slot ${id} has a bad max length`);
  const hint = slot.hint;
  if (hint !== undefined && typeof hint !== "string") fail(`${templateId} slot ${id} has a bad hint`);
  return {
    id,
    kind: kind as SlotKind,
    label: label.trim(),
    required: slot.required,
    ...(typeof hint === "string" && hint.trim() ? { hint: hint.trim() } : {}),
    ...(typeof maxLength === "number" ? { maxLength } : {}),
  };
}

function parseTemplate(raw: unknown, categories: ReadonlySet<string>): VideoTemplate {
  if (!raw || typeof raw !== "object") fail("a template is not an object");
  const item = raw as Record<string, unknown>;
  const id = item.id;
  if (typeof id !== "string" || !/^[a-z][a-z0-9-]{0,40}$/.test(id)) fail("a template has a bad id");
  for (const key of ["name", "summary", "model", "prompt", "ratio", "resolution"] as const) {
    if (typeof item[key] !== "string" || !item[key].trim()) fail(`${id} needs ${key}`);
  }
  if (typeof item.category !== "string" || !categories.has(item.category)) fail(`${id} has a bad category`);
  if (typeof item.route !== "string" || !ROUTES.includes(item.route as TemplateRoute)) fail(`${id} has a bad route`);
  if (typeof item.duration !== "number" || !Number.isInteger(item.duration) || item.duration < 1)
    fail(`${id} needs a whole-second duration`);
  if (item.audio !== undefined && typeof item.audio !== "boolean") fail(`${id} has a bad audio flag`);
  if (!Array.isArray(item.slots) || item.slots.length === 0) fail(`${id} needs at least one slot`);
  const seen = new Set<string>();
  const kinds = new Set<string>();
  const slots = item.slots.map((slot) => {
    const parsed = parseSlot(id, slot, seen);
    if (kinds.has(parsed.kind)) fail(`${id} has two ${parsed.kind} slots`);
    kinds.add(parsed.kind);
    if (!(item.prompt as string).includes(`{{${parsed.id}}}`)) fail(`${id} prompt is missing {{${parsed.id}}}`);
    return parsed;
  });
  const previewRaw = item.preview;
  let preview: TemplatePreview | undefined;
  if (previewRaw !== undefined) {
    if (!previewRaw || typeof previewRaw !== "object") fail(`${id} has a bad preview`);
    const video = mediaUrl((previewRaw as { video?: unknown }).video);
    const poster = mediaUrl((previewRaw as { poster?: unknown }).poster);
    if (video || poster) preview = { ...(video && { video }), ...(poster && { poster }) };
  }
  return {
    id,
    name: (item.name as string).trim(),
    category: item.category as TemplateCategory,
    summary: (item.summary as string).trim(),
    model: (item.model as string).trim(),
    route: item.route as TemplateRoute,
    duration: item.duration as number,
    ratio: (item.ratio as string).trim(),
    resolution: (item.resolution as string).trim(),
    ...(item.audio === true ? { audio: true } : {}),
    prompt: (item.prompt as string).trim(),
    slots,
    ...(preview && { preview }),
  };
}

function parseCatalog(raw: unknown): { categories: TemplateCategoryInfo[]; templates: VideoTemplate[] } {
  if (!raw || typeof raw !== "object") fail("catalog is not an object");
  const body = raw as { categories?: unknown; templates?: unknown };
  if (!Array.isArray(body.categories) || body.categories.length === 0) fail("needs categories");
  const categories: TemplateCategoryInfo[] = body.categories.map((item) => {
    if (!item || typeof item !== "object") fail("a category is not an object");
    const category = item as { id?: unknown; label?: unknown };
    if (typeof category.id !== "string" || !CATEGORY_IDS.includes(category.id as TemplateCategory))
      fail("unknown category id");
    if (typeof category.label !== "string" || !category.label.trim()) fail(`${category.id} needs a label`);
    return { id: category.id as TemplateCategory, label: category.label.trim() };
  });
  const ids = new Set(categories.map((category) => category.id));
  if (ids.size !== categories.length) fail("duplicate category");
  if (!Array.isArray(body.templates)) fail("needs templates");
  const templates = body.templates.map((item) => parseTemplate(item, ids));
  const templateIds = new Set<string>();
  for (const template of templates) {
    if (templateIds.has(template.id)) fail(`duplicate template ${template.id}`);
    templateIds.add(template.id);
  }
  return { categories, templates };
}

const catalog = parseCatalog(catalogFile);

export const CATEGORIES: readonly TemplateCategoryInfo[] = catalog.categories;
export const TEMPLATES: readonly VideoTemplate[] = catalog.templates;

export function categoryLabel(id: TemplateCategory): string {
  return CATEGORIES.find((category) => category.id === id)?.label ?? id;
}

export function getTemplate(id: string | undefined): VideoTemplate | undefined {
  if (!id) return undefined;
  return TEMPLATES.find((template) => template.id === id);
}

export function listTemplates(category?: TemplateCategory): VideoTemplate[] {
  if (!category) return [...TEMPLATES];
  return TEMPLATES.filter((template) => template.category === category);
}

/** Video and poster the gallery may load. Invalid values are dropped. */
export function previewOf(template: { preview?: { video?: string; poster?: string } }): TemplatePreview {
  const video = mediaUrl(template.preview?.video);
  const poster = mediaUrl(template.preview?.poster);
  return { ...(video && { video }), ...(poster && { poster }) };
}

function textOf(value: SlotInput | undefined): string {
  return value?.text?.trim() ?? "";
}

/** Field errors for a template form. Empty when the slots are ready to run. */
export function slotErrors(template: VideoTemplate, values: Readonly<Record<string, SlotInput | undefined>>): SlotError[] {
  const errors: SlotError[] = [];
  for (const slot of template.slots) {
    if (slot.kind === "text") {
      const text = textOf(values[slot.id]);
      const max = slot.maxLength ?? 160;
      if (slot.required && !text) errors.push({ id: slot.id, message: `${slot.label} is required` });
      else if (text.length > max) errors.push({ id: slot.id, message: `${slot.label} must be ${max} characters or fewer` });
      else if (text.includes("{{")) errors.push({ id: slot.id, message: `${slot.label} has an unclosed {{` });
      else if (text.includes("@")) errors.push({ id: slot.id, message: `${slot.label} can't include @mentions` });
    } else if (slot.required && !values[slot.id]?.image?.trim()) {
      errors.push({ id: slot.id, message: `${slot.label} is required` });
    }
  }
  return errors;
}

/** Replaces `{{slot}}` tokens. Image slots become @Image N in slot order. */
export function fillPrompt(template: VideoTemplate, values: Readonly<Record<string, SlotInput | undefined>>): string {
  const mention = new Map<string, string>();
  let image = 0;
  for (const slot of template.slots) {
    if (!IMAGE_KINDS.has(slot.kind) || !values[slot.id]?.image?.trim()) continue;
    image += 1;
    mention.set(slot.id, `@Image ${image}`);
  }
  let prompt = template.prompt;
  for (const slot of template.slots) {
    const token = `{{${slot.id}}}`;
    const replacement = slot.kind === "text" ? textOf(values[slot.id]) : (mention.get(slot.id) ?? "");
    prompt = prompt.split(token).join(replacement);
  }
  return prompt
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The generation body for a filled template. `request` is absent when a slot
 * still needs a value. Image slots are reference images, in slot order.
 */
export function buildTemplateRequest(
  template: VideoTemplate,
  values: Readonly<Record<string, SlotInput | undefined>>,
): { request?: GenerateRequest; errors: SlotError[] } {
  const errors = slotErrors(template, values);
  if (errors.length) return { errors };
  const prompt = fillPrompt(template, values);
  if (prompt.includes("{{")) return { errors: [{ id: "", message: "This template has an unclosed {{" }] };
  const referenceImages: string[] = [];
  const referenceOrder: string[] = [];
  const templateSlots: TemplateSlotFill[] = [];
  for (const slot of template.slots) {
    const value = values[slot.id];
    if (slot.kind === "text") {
      const text = textOf(value);
      if (text) templateSlots.push({ id: slot.id, text });
      continue;
    }
    const image = value?.image?.trim();
    if (!image) continue;
    referenceImages.push(image);
    if (value?.key && isAssetKey(value.key)) {
      referenceOrder.push(value.key);
      templateSlots.push({ id: slot.id, key: value.key });
    }
  }
  return {
    errors: [],
    request: {
      model: template.model,
      route: template.route,
      prompt,
      mode: "references",
      ratio: template.ratio,
      resolution: template.resolution,
      duration: template.duration,
      ...(template.audio ? { generateAudio: true } : {}),
      ...(referenceImages.length ? { referenceImages } : {}),
      ...(referenceOrder.length ? { referenceOrder } : {}),
      templateId: template.id,
      ...(templateSlots.length ? { templateSlots } : {}),
    },
  };
}

/**
 * Null when this generation is not from a template, or the template matches the
 * model and the provider the studio guard already chose.
 */
export function templateRouteError(req: Pick<GenerateRequest, "templateId" | "model">, provider: string): string | null {
  if (!req.templateId) return null;
  const template = getTemplate(req.templateId);
  if (!template) return "Unknown template";
  if (req.model !== template.model || provider !== template.route) return "This template runs on a different model.";
  return null;
}

/** 400 when the field is present and not a list. Absent is fine. */
export function templateSlotsError(raw: unknown): string | null {
  if (raw == null) return null;
  if (!Array.isArray(raw)) return "Template slots must be a list";
  return null;
}

function cleanFills(template: VideoTemplate, raw: TemplateSlotFill[] | undefined): TemplateSlotFill[] | undefined {
  if (!Array.isArray(raw) || !raw.length) return undefined;
  const fills: TemplateSlotFill[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item.id !== "string" || seen.has(item.id)) continue;
    const slot = template.slots.find((entry) => entry.id === item.id);
    if (!slot) continue;
    seen.add(item.id);
    if (slot.kind === "text") {
      const text = typeof item.text === "string" ? item.text.trim().slice(0, slot.maxLength ?? 160) : "";
      if (text) fills.push({ id: slot.id, text });
    } else if (typeof item.key === "string" && isAssetKey(item.key)) {
      fills.push({ id: slot.id, key: item.key });
    }
  }
  return fills.length ? fills : undefined;
}

/** Fields to copy onto the generation record. Unknown template ids are dropped. */
export function templateRecord(
  req: Pick<GenerateRequest, "templateId" | "templateSlots">,
): { templateId: string; templateSlots?: TemplateSlotFill[] } | undefined {
  const template = getTemplate(req.templateId);
  if (!template) return undefined;
  const templateSlots = cleanFills(template, req.templateSlots);
  return templateSlots ? { templateId: template.id, templateSlots } : { templateId: template.id };
}

/** Slot values Use this template again writes back into the form. */
export function restoredSlotInputs(gen: { templateId?: string; templateSlots?: TemplateSlotFill[] }): Record<string, SlotInput> {
  const template = getTemplate(gen.templateId);
  if (!template || !gen.templateSlots) return {};
  const values: Record<string, SlotInput> = {};
  for (const fill of gen.templateSlots) {
    const slot = template.slots.find((entry) => entry.id === fill.id);
    if (!slot) continue;
    if (slot.kind === "text" && fill.text) values[slot.id] = { text: fill.text };
    else if (fill.key && isAssetKey(fill.key)) values[slot.id] = { image: `upload:${fill.key}`, key: fill.key };
  }
  return values;
}
