// Pure catalog → registry transforms. The sync script fetches; this file does not.

const VIDEO_TASKS = ["t2v", "i2v", "ref2v", "v2v-edit", "extend", "upscale", "lipsync", "avatar", "motion"];
const IMAGE_TASKS = ["image", "image-edit"];

/** 16:9 sizes used to turn a token rate into a dollar estimate (BytePlus's published formula). */
const PIXELS = {
  "480p": { width: 864, height: 480 },
  "720p": { width: 1280, height: 720 },
  "768p": { width: 1366, height: 768 },
  "1080p": { width: 1920, height: 1080 },
  "2k": { width: 2560, height: 1440 },
  "4k": { width: 3840, height: 2160 },
};

const SIZE_RATIO = {
  square: "1:1",
  square_hd: "1:1",
  landscape_16_9: "16:9",
  portrait_16_9: "9:16",
  landscape_4_3: "4:3",
  portrait_4_3: "3:4",
  landscape_21_9: "21:9",
};

function clean(text, max = 400) {
  const value = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return value.length > max ? `${value.slice(0, max - 1).trim()}…` : value;
}

function groupOf(task) {
  if (IMAGE_TASKS.includes(task)) return "image";
  if (task === "tts") return "speech";
  if (task === "tool") return "tool";
  return "video";
}

export function durationCap(values) {
  const sorted = [...new Set(values.map(Number))]
    .filter((n) => Number.isInteger(n) && n > 0)
    .sort((a, b) => a - b);
  if (!sorted.length) return undefined;
  const contiguous = sorted.every((n, i) => i === 0 || n === sorted[i - 1] + 1);
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    default: sorted.includes(5) ? 5 : sorted[Math.floor((sorted.length - 1) / 2)],
    ...(contiguous ? {} : { options: sorted }),
  };
}

function dollars(skus, key) {
  const n = Number(skus[key]);
  if (!Number.isFinite(n)) return undefined;
  return key.startsWith("cents_") ? round(n / 100) : n;
}

function round(n) {
  return Math.round(n * 1e8) / 1e8;
}

const RES_RE = /(480p|580p|720p|768p|1080p|2k|4k)$/i;

function resolutionOf(key, supported) {
  const match = key.match(RES_RE);
  if (!match) return "*";
  const raw = match[1];
  return (supported ?? []).find((s) => s.toLowerCase() === raw.toLowerCase()) ?? raw.toLowerCase();
}

function skippedSku(key) {
  return /with_video|continuation|long_duration|reference_|minimum_|image_input|per_image/.test(key);
}

function collectRates(skus, supported, pred) {
  const out = {};
  const rank = {};
  for (const key of Object.keys(skus)) {
    if (skippedSku(key) || !pred(key)) continue;
    const value = dollars(skus, key);
    if (value === undefined) continue;
    const res = resolutionOf(key, supported);
    const score = key.includes("text_to_video") ? 3 : key.includes("image_to_video") ? 1 : 2;
    if (rank[res] === undefined || score > rank[res]) {
      out[res] = value;
      rank[res] = score;
    }
  }
  return out;
}

/** `video_tokens_with_video_input` and its 1080p / 4k overrides. */
function withVideoTokenRates(skus, supported) {
  const base = dollars(skus, "video_tokens_with_video_input");
  if (base === undefined) return { usd: undefined, byResolution: {} };
  const byResolution = {};
  for (const res of supported) {
    const specific =
      res.toLowerCase() === "1080p"
        ? skus.video_tokens_1080p_with_video_input
        : res.toLowerCase() === "4k"
          ? skus.video_tokens_4k_with_video_input
          : undefined;
    byResolution[res] = specific !== undefined ? Number(specific) : base;
  }
  return { usd: base, byResolution };
}

function pixelsFor(resolutions) {
  const pixels = {};
  for (const res of resolutions ?? []) {
    const size = PIXELS[res.toLowerCase()];
    if (size) pixels[res] = size;
  }
  return pixels;
}

/** OpenRouter pricing_skus → one of the four registry formulas, or undefined. */
export function openRouterPrice(model) {
  const skus = model.pricing_skus ?? {};
  const supported = model.supported_resolutions ?? [];
  const keys = Object.keys(skus);
  const mega = keys.find((key) => key.includes("megapixel"));
  if (mega) {
    const usd = dollars(skus, mega);
    if (usd === undefined) return undefined;
    return { type: "per_megapixel", usd, ...(mega.includes("second") ? { perSecond: true } : {}) };
  }
  if (skus.video_tokens !== undefined || skus.video_tokens_without_audio !== undefined) {
    const base = dollars(skus, skus.video_tokens_without_audio !== undefined ? "video_tokens_without_audio" : "video_tokens");
    if (base === undefined) return undefined;
    const byResolution = {};
    for (const res of supported) {
      const specific =
        res.toLowerCase() === "1080p"
          ? skus.video_tokens_1080p
          : res.toLowerCase() === "4k"
            ? skus.video_tokens_4k
            : undefined;
      byResolution[res] = specific !== undefined ? Number(specific) : base;
    }
    const pixels = pixelsFor(supported);
    const withVideo = withVideoTokenRates(skus, supported);
    return {
      type: "tokens",
      usdPerToken: base,
      ...(withVideo.usd !== undefined ? { usdPerTokenWithVideo: withVideo.usd } : {}),
      ...(Object.keys(byResolution).length ? { byResolution } : {}),
      ...(Object.keys(withVideo.byResolution).length ? { byResolutionWithVideo: withVideo.byResolution } : {}),
      fps: 24,
      ...(Object.keys(pixels).length ? { pixels } : {}),
    };
  }
  const isSecond = (key) => /duration_seconds|per_second_output|per_video_output_second|cents_per_second/.test(key);
  const withAudio = collectRates(skus, supported, (key) => isSecond(key) && key.includes("with_audio"));
  const withoutAudio = collectRates(skus, supported, (key) => isSecond(key) && key.includes("without_audio"));
  const plain = collectRates(skus, supported, (key) => isSecond(key) && !key.includes("with_audio") && !key.includes("without_audio"));
  const silent = Object.keys(withoutAudio).length ? withoutAudio : plain;
  if (!Object.keys(silent).length && !Object.keys(withAudio).length) return undefined;
  const minimum = dollars(skus, "minimum_cents_per_generation");
  return {
    type: "per_second",
    byResolution: Object.keys(silent).length ? silent : withAudio,
    ...(Object.keys(withAudio).length ? { byResolutionWithAudio: withAudio } : {}),
    ...(minimum !== undefined ? { minimum } : {}),
  };
}

export function openRouterModel(model) {
  const frames = new Set(model.supported_frame_images ?? []);
  const id = String(model.id);
  const references = openRouterReferences(model);
  const { task, tasks } = openRouterTasks(id, frames, references);
  const durations = Array.isArray(model.supported_durations) ? durationCap(model.supported_durations) : undefined;
  const pass = model.allowed_passthrough_parameters ?? [];
  const has = (pattern) => pass.some((name) => pattern.test(name));
  const start = frames.has("first_frame") || tasks.includes("i2v");
  const family = model.name?.includes(":") ? model.name.split(":")[0].trim() : id.split("/")[0];
  const price = openRouterPrice(model);
  return compact({
    id: `openrouter:${id}`,
    family,
    name: model.name || id,
    description: clean(model.description),
    group: "video",
    task,
    tasks,
    routes: [{ provider: "openrouter", endpoint: id, mapper: "openrouter.video" }],
    promptRequired: !start,
    refSyntax: "at",
    capabilities: compact({
      durations,
      resolutions: model.supported_resolutions ?? [],
      ratios: model.supported_aspect_ratios ?? [],
      audio: model.generate_audio === true ? "optional" : false,
      frames: { start, middle: frames.has("middle_frame"), end: frames.has("last_frame") },
      references,
      seed: model.seed === true,
      promptExpansion: has(/enhance_?prompt|prompt_extend|prompt_expansion/i) ? "optional" : false,
      camera: openRouterCamera(pass),
      watermark: has(/watermark/i),
      lastFrameOutput: false,
    }),
    price,
  });
}

/**
 * Camera capability from OpenRouter `allowed_passthrough_parameters`.
 * `camera_fixed` is mapped because BytePlus documents it as a boolean lock.
 * Other names (`shot_type`, `motion_prompt`, `cfg_scale`, …) are not camera moves
 * and stay unmapped until their values are checked.
 */
export function openRouterCamera(pass) {
  const names = Array.isArray(pass) ? pass.map((name) => String(name)) : [];
  if (!names.includes("camera_fixed")) return false;
  return { fixed: true, prompt: true, params: ["camera_fixed"] };
}

/**
 * Reference caps the video models API does not publish (`per_request_limits` is null).
 * Seedance 2.5's model page says "up to 50 image, video, and audio reference assets":
 * https://openrouter.ai/bytedance/seedance-2.5
 * Each kind shares that combined ceiling. Other models stay at zero until their page
 * states a number.
 */
export function openRouterReferences(model) {
  if (String(model?.id) === "bytedance/seedance-2.5") return { image: 50, video: 50, audio: 50, total: 50 };
  return { image: 0, video: 0, audio: 0, total: 0 };
}

function openRouterTasks(id, frames, references) {
  const slug = id.toLowerCase();
  if (slug.includes("upscale")) return { task: "upscale", tasks: ["upscale"] };
  if (slug.includes("avatar")) return { task: "avatar", tasks: ["avatar"] };
  if (slug.includes("lip")) return { task: "lipsync", tasks: ["lipsync"] };
  if (slug.includes("edit")) return { task: "v2v-edit", tasks: ["v2v-edit"] };
  const tasks = [];
  if (!/image-to-video|\/i2v/.test(slug)) tasks.push("t2v");
  if (frames.has("first_frame")) tasks.push("i2v");
  const refs = references ?? { image: 0, video: 0, audio: 0 };
  if (refs.image + refs.video + refs.audio > 0) tasks.push("ref2v");
  if (!tasks.length) tasks.push("t2v");
  const order = VIDEO_TASKS;
  tasks.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return { task: tasks.includes("t2v") ? "t2v" : tasks[0], tasks };
}

function resolveSchema(root, schema, depth = 0) {
  if (!schema || typeof schema !== "object" || depth > 10) return {};
  if (schema.$ref) {
    const name = String(schema.$ref).split("/").pop();
    return resolveSchema(root, root.components?.schemas?.[name], depth + 1);
  }
  if (Array.isArray(schema.allOf)) {
    return schema.allOf.reduce((acc, part) => mergeSchema(acc, resolveSchema(root, part, depth + 1)), {});
  }
  return schema;
}

function mergeSchema(left, right) {
  return {
    ...left,
    ...right,
    properties: { ...(left.properties ?? {}), ...(right.properties ?? {}) },
    required: [...new Set([...(left.required ?? []), ...(right.required ?? [])])],
  };
}

function unwrap(root, schema, depth = 0) {
  if (!schema || typeof schema !== "object" || depth > 10) return {};
  const options = schema.anyOf || schema.oneOf;
  if (Array.isArray(options)) {
    const resolved = options
      .map((option) => unwrap(root, resolveSchema(root, option), depth + 1))
      .filter((option) => option.type !== "null");
    const enums = [...new Set(resolved.flatMap((option) => option.enum ?? []))];
    const merged = resolved.find((option) => option.enum?.length) ?? resolved.find((option) => option.type) ?? resolved[0] ?? {};
    return enums.length ? { ...merged, enum: enums } : merged;
  }
  return resolveSchema(root, schema);
}

function inputSchema(openapi) {
  if (!openapi || openapi.error || !openapi.components?.schemas) return { properties: {}, required: [] };
  const schemas = openapi.components.schemas;
  const name =
    Object.keys(schemas).find((key) => /Input$/.test(key)) ??
    Object.keys(schemas).find((key) => /Input/i.test(key));
  return name ? resolveSchema(openapi, schemas[name]) : { properties: {}, required: [] };
}

function propertiesOf(openapi) {
  const schema = inputSchema(openapi);
  const props = {};
  for (const [key, value] of Object.entries(schema.properties ?? {})) {
    const resolved = unwrap(openapi, value);
    props[key] = {
      type: resolved.type,
      enum: Array.isArray(resolved.enum) ? resolved.enum.filter((item) => item != null) : undefined,
      minimum: typeof resolved.minimum === "number" ? resolved.minimum : undefined,
      maximum: typeof resolved.maximum === "number" ? resolved.maximum : undefined,
      default: resolved.default,
      maxItems: typeof resolved.maxItems === "number" ? resolved.maxItems : undefined,
    };
  }
  return { props, required: schema.required ?? [] };
}

function hasKey(props, pattern) {
  return Object.keys(props).some((key) => pattern.test(key));
}

function arrayLimit(props, pattern) {
  for (const [key, spec] of Object.entries(props)) {
    if (!pattern.test(key)) continue;
    if (spec.type === "array") return spec.maxItems ?? 4;
    return 1;
  }
  return 0;
}

function enumStrings(spec) {
  return (spec?.enum ?? []).filter((item) => typeof item === "string");
}

function ratiosFrom(props) {
  const aspect = enumStrings(props.aspect_ratio);
  if (aspect.length) return aspect;
  const sizes = enumStrings(props.image_size);
  const ratios = sizes.map((size) => SIZE_RATIO[size] ?? (size.includes(":") ? size : undefined)).filter(Boolean);
  return [...new Set(ratios)];
}

function resolutionsFrom(props) {
  return enumStrings(props.resolution).concat(enumStrings(props.video_resolution));
}

function durationsFrom(props) {
  const direct = props.duration ?? props.video_length ?? props.seconds;
  if (direct?.enum?.length) return durationCap(direct.enum);
  if (typeof direct?.minimum === "number" || typeof direct?.maximum === "number") {
    const min = Math.max(1, Math.round(direct.minimum ?? 1));
    const max = Math.max(min, Math.round(direct.maximum ?? min));
    const fallback = typeof direct.default === "number" ? Math.round(direct.default) : min;
    return { min, max, default: Math.min(max, Math.max(min, fallback)) };
  }
  const frames = props.num_frames;
  if (frames && (typeof frames.minimum === "number" || typeof frames.maximum === "number")) {
    const fps = props.frames_per_second?.default || props.fps?.default || 16;
    const min = Math.max(1, Math.round((frames.minimum ?? fps) / fps));
    const max = Math.max(min, Math.round((frames.maximum ?? frames.minimum ?? fps) / fps));
    return { min, max, default: Math.min(max, Math.max(min, 5)) };
  }
  return undefined;
}

function tasksFor(primary, props) {
  const tasks = [primary];
  if (primary === "t2v" && hasKey(props, /^(image_url|start_image_url|first_frame_url)$/)) tasks.push("i2v");
  return tasks;
}

function framesFor(task, tasks, props) {
  const start =
    tasks.includes("i2v") ||
    task === "avatar" ||
    hasKey(props, /^(image_url|start_image_url|first_frame_url|image)$/);
  return {
    start: task === "image" || task === "image-edit" || task === "tool" || task === "tts" ? false : start,
    middle: hasKey(props, /middle_image|middle_frame|mid_frame/),
    end: hasKey(props, /end_image|tail_image|last_frame|end_frame/),
  };
}

function referencesFor(task, props) {
  let image = arrayLimit(props, /^(reference_images?|image_urls|subject_images?|images)$/);
  let video = arrayLimit(props, /reference_video|video_urls/);
  let audio = arrayLimit(props, /reference_audio|audio_urls|audio_url$/);
  if (["extend", "upscale", "v2v-edit", "lipsync", "motion"].includes(task) && video === 0 && hasKey(props, /video_url/))
    video = 1;
  if (task === "lipsync" && audio === 0 && hasKey(props, /audio/)) audio = 1;
  if (task === "ref2v" && image + video + audio === 0) image = arrayLimit(props, /image/) || 1;
  if (task === "image-edit" && image === 0) image = 1;
  const total = image + video + audio;
  return { image, video, audio, total };
}

function priceFromUnit(unitPrice, unit) {
  if (typeof unitPrice !== "number") return undefined;
  const name = String(unit ?? "").toLowerCase();
  if (name.includes("megapixel"))
    return { type: "per_megapixel", usd: unitPrice, ...(name.includes("second") ? { perSecond: true } : {}) };
  if (name.includes("second")) return { type: "per_second", byResolution: { "*": unitPrice } };
  if (name.includes("image")) return { type: "per_image", usd: unitPrice };
  return undefined;
}

export function falModel(spec, raw, unit) {
  const task = spec.task;
  const openapi = raw.openapi?.openapi ? raw.openapi : undefined;
  const { props, required } = propertiesOf(openapi);
  const meta = raw.metadata ?? {};
  const tasks = tasksFor(task, props);
  const group = groupOf(task);
  const frames = framesFor(task, tasks, props);
  const references = referencesFor(task, props);
  const durations = durationsFrom(props);
  const resolutions = resolutionsFrom(props);
  const ratios = ratiosFrom(props);
  const promptExpansion = hasKey(props, /prompt_expansion|prompt_optimizer|enhance_prompt/) ? "optional" : false;
  // Only `camera_fixed` is wired through to a provider body. Other camera-like
  // fields stay off until a builder actually sends them.
  const camera = hasKey(props, /^camera_fixed$/)
    ? { fixed: true, prompt: true, params: ["camera_fixed"] }
    : false;
  const price = priceFromUnit(unit?.unit_price, unit?.unit);
  const display = (meta.display_name || spec.endpoint).trim();
  const family = display.split(/\s+/)[0]?.replace(/:$/, "") || spec.endpoint.split("/")[0];
  const base = {
    id: `fal:${spec.endpoint}`,
    family,
    name: meta.display_name || spec.endpoint,
    description: clean(meta.description),
    group,
    task,
    tasks: group === "video" ? tasks.filter((item) => VIDEO_TASKS.includes(item)) : [task],
    routes: [{ provider: "fal", endpoint: spec.endpoint, mapper: "fal.queue" }],
    promptRequired: required.includes("prompt") || task === "t2v" || task === "tts",
    refSyntax: "at",
    price,
  };
  // Every fal route names fal.queue. The fal tab still submits raw JSON; nothing calls a mapper yet.
  if (group === "image") {
    const maxImages = props.num_images?.maximum ?? props.num_images?.default ?? 1;
    return compact({
      ...base,
      capabilities: {
        resolutions,
        ratios: ratios.length ? ratios : ["1:1"],
        references,
        maxImages: Math.max(1, Math.round(maxImages)),
        seed: Boolean(props.seed),
        promptExpansion,
      },
    });
  }
  if (group === "speech") {
    return compact({
      ...base,
      capabilities: { seed: Boolean(props.seed), promptExpansion },
    });
  }
  if (group === "tool") {
    // One media kind per tool. image_url and video_url come from the live input schema.
    const video = hasKey(props, /video_url/);
    const image = hasKey(props, /image_url/);
    const accepts = video && !image ? "video" : image ? "image" : undefined;
    return compact({
      ...base,
      capabilities: compact({
        accepts,
        resolutions: resolutions.length ? resolutions : undefined,
      }),
    });
  }
  return compact({
    ...base,
    capabilities: compact({
      durations,
      resolutions,
      ratios,
      audio: hasKey(props, /^generate_audio$|^audio$/) ? "optional" : false,
      frames,
      references,
      seed: Boolean(props.seed),
      promptExpansion,
      camera,
      watermark: hasKey(props, /^watermark$/),
      lastFrameOutput: false,
    }),
  });
}

function compact(value) {
  if (Array.isArray(value)) return value.map(compact);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) continue;
    out[key] = compact(value[key]);
  }
  return out;
}

export function stable(value) {
  return compact(value);
}
