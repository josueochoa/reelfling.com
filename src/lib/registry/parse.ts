import {
  CAMERA_MOVE_IDS,
  IMAGE_TASKS,
  MAPPER_IDS,
  ROUTE_PROVIDERS,
  SPEECH_TASKS,
  TOOL_TASKS,
  VIDEO_TASKS,
  type ImageModel,
  type ImageTask,
  type MapperId,
  type ModelEntry,
  type RouteProvider,
  type SpeechModel,
  type SpeechTask,
  type ToolModel,
  type ToolTask,
  type VideoModel,
  type VideoTask,
} from "./types";

const GROUPS = ["video", "image", "speech", "tool"] as const;
const PRICE_TYPES = ["per_second", "per_image", "per_megapixel", "tokens"] as const;

const asRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
};

const asString = (value: unknown, label: string) => {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be a non-empty string`);
  return value;
};

function asTasks<T extends string>(value: unknown, allowed: readonly T[], label: string): T[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} needs at least one task`);
  return value.map((task) => {
    if (typeof task !== "string" || !allowed.includes(task as T))
      throw new Error(`${label} has task "${String(task)}" which isn't a ${label.split(" ")[0]} task`);
    return task as T;
  });
}

function asRoute(value: unknown): ModelEntry["routes"][number] {
  const route = asRecord(value, "route");
  const provider = asString(route.provider, "route provider");
  if (!ROUTE_PROVIDERS.includes(provider as RouteProvider)) throw new Error(`Unknown provider "${provider}"`);
  const mapper = asString(route.mapper, "route mapper");
  if (!MAPPER_IDS.includes(mapper as MapperId)) throw new Error(`Unknown mapper "${mapper}"`);
  return {
    provider: provider as RouteProvider,
    endpoint: asString(route.endpoint, "route endpoint"),
    mapper: mapper as MapperId,
  };
}

function asPrice(value: unknown): ModelEntry["price"] {
  if (value === undefined) return undefined;
  const price = asRecord(value, "price");
  const type = asString(price.type, "price type");
  if (!PRICE_TYPES.includes(type as (typeof PRICE_TYPES)[number])) throw new Error(`Unknown price formula "${type}"`);
  return price as NonNullable<ModelEntry["price"]>;
}

/** Turns catalog JSON into a model, or throws when a provider, mapper, or task is unknown. */
export function parseModel(value: unknown): ModelEntry {
  const raw = asRecord(value, "model");
  const group = asString(raw.group, "group");
  if (!GROUPS.includes(group as (typeof GROUPS)[number])) throw new Error(`Unknown model group "${group}"`);
  const routes = Array.isArray(raw.routes) ? raw.routes.map(asRoute) : [];
  if (!routes.length) throw new Error(`Model "${String(raw.id)}" has no routes`);
  const base = {
    id: asString(raw.id, "id"),
    family: asString(raw.family, "family"),
    name: asString(raw.name, "name"),
    description: typeof raw.description === "string" ? raw.description : "",
    routes,
    promptRequired: raw.promptRequired === true,
    refSyntax: raw.refSyntax === "brackets" || raw.refSyntax === "plain" ? raw.refSyntax : "at",
    ...(typeof raw.mark === "string" && { mark: raw.mark }),
    capabilities: asRecord(raw.capabilities, "capabilities"),
    price: asPrice(raw.price),
  };
  if (group === "video") {
    const tasks = asTasks(raw.tasks, VIDEO_TASKS, "video tasks");
    const task = asString(raw.task, "task") as VideoTask;
    if (!VIDEO_TASKS.includes(task) || !tasks.includes(task)) throw new Error(`Unknown video task "${raw.task}"`);
    return { ...base, group, task, tasks, capabilities: base.capabilities } as unknown as VideoModel;
  }
  if (group === "image") {
    const tasks = asTasks(raw.tasks, IMAGE_TASKS, "image tasks");
    const task = asString(raw.task, "task") as ImageTask;
    if (!IMAGE_TASKS.includes(task) || !tasks.includes(task)) throw new Error(`Unknown image task "${raw.task}"`);
    return { ...base, group, task, tasks, capabilities: base.capabilities } as unknown as ImageModel;
  }
  if (group === "speech") {
    const tasks = asTasks(raw.tasks, SPEECH_TASKS, "speech tasks");
    const task = asString(raw.task, "task") as SpeechTask;
    if (!SPEECH_TASKS.includes(task) || !tasks.includes(task)) throw new Error(`Unknown speech task "${raw.task}"`);
    return { ...base, group, task, tasks, capabilities: base.capabilities } as unknown as SpeechModel;
  }
  const tasks = asTasks(raw.tasks, TOOL_TASKS, "tool tasks");
  const task = asString(raw.task, "task") as ToolTask;
  if (!TOOL_TASKS.includes(task) || !tasks.includes(task)) throw new Error(`Unknown tool task "${raw.task}"`);
  return { ...base, group: "tool" as const, task, tasks, capabilities: base.capabilities } as unknown as ToolModel;
}

function assertCamera(model: VideoModel) {
  const camera = model.capabilities.camera;
  if (!camera || !camera.native) return;
  for (const [move, binding] of Object.entries(camera.native)) {
    if (!(CAMERA_MOVE_IDS as readonly string[]).includes(move))
      throw new Error(`${model.id} maps unknown camera move "${move}"`);
    const value = binding as { param?: unknown; value?: unknown } | undefined;
    if (!value || value.param !== "camera_fixed" || typeof value.value !== "boolean")
      throw new Error(`${model.id} camera move "${move}" is not the camera_fixed boolean`);
  }
}

const VIDEO_PRICE = new Set(["per_second", "tokens", "per_megapixel"]);
const IMAGE_PRICE = new Set(["per_image", "per_megapixel", "tokens"]);

/**
 * Checks a list of models. Throws on an unknown provider or mapper, a task that
 * doesn't belong to the group, or a price formula the group can't use.
 */
export function assertRegistry(models: readonly ModelEntry[]) {
  const seen = new Set<string>();
  for (const model of models) {
    if (seen.has(model.id)) throw new Error(`Duplicate model id "${model.id}"`);
    seen.add(model.id);
    if (!model.tasks.includes(model.task as never))
      throw new Error(`${model.id} primary task ${model.task} is missing from tasks`);
    for (const route of model.routes) {
      if (!ROUTE_PROVIDERS.includes(route.provider)) throw new Error(`Unknown provider "${route.provider}"`);
      if (!MAPPER_IDS.includes(route.mapper)) throw new Error(`Unknown mapper "${route.mapper}"`);
    }
    if (model.group === "video") {
      for (const task of model.tasks)
        if (!VIDEO_TASKS.includes(task)) throw new Error(`${model.id} lists ${task}, which isn't a video task`);
      if (model.tasks.includes("i2v") && !model.capabilities.frames?.start)
        throw new Error(`${model.id} is image-to-video but has no start frame`);
      if (model.tasks.includes("ref2v")) {
        const refs = model.capabilities.references;
        if (!refs || refs.image + refs.video + refs.audio === 0)
          throw new Error(`${model.id} is reference-to-video but takes no references`);
      }
      if (model.price && !VIDEO_PRICE.has(model.price.type))
        throw new Error(`${model.id} uses price "${model.price.type}", which isn't a video formula`);
      assertCamera(model);
    } else if (model.group === "image") {
      for (const task of model.tasks)
        if (!IMAGE_TASKS.includes(task)) throw new Error(`${model.id} lists ${task}, which isn't an image task`);
      if (model.tasks.includes("image-edit") && !(model.capabilities.references?.image > 0))
        throw new Error(`${model.id} is an image edit but takes no reference images`);
      if (model.price && !IMAGE_PRICE.has(model.price.type))
        throw new Error(`${model.id} uses price "${model.price.type}", which isn't an image formula`);
    } else {
      const expected = model.group === "speech" ? "tts" : "tool";
      if (model.task !== expected) throw new Error(`${model.id} task ${model.task} doesn't match ${model.group}`);
    }
  }
}
