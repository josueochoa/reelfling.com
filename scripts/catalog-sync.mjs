// Regenerates src/lib/registry/catalog/{fal,openrouter}.json from the live catalogs.
//
// fal:      GET https://api.fal.ai/v1/models?endpoint_id=…&expand=openapi-3.0
//           Auth is optional (higher rate limit). Pricing needs FAL_KEY:
//           GET https://api.fal.ai/v1/models/pricing?endpoint_id=…
//           Header: Authorization: Key <key>   (never written to disk)
// OpenRouter: GET https://openrouter.ai/api/v1/videos/models
//           Auth is optional. OPENROUTER_API_KEY is sent as Bearer only when set.
//
// Docs checked Nov 2026:
//   https://fal.ai/docs/platform-apis/v1/models
//   https://fal.ai/docs/platform-apis/v1/models/pricing
//   https://openrouter.ai/docs/api/api-reference/video-generation/list-all-video-generation-models

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { falModel, openRouterModel, stable } from "./catalog-map.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const catalogDir = join(root, "src/lib/registry/catalog");
const endpoints = JSON.parse(readFileSync(join(root, "src/lib/registry/fal-endpoints.json"), "utf8"));

const secrets = [process.env.FAL_KEY, process.env.OPENROUTER_API_KEY].filter(Boolean);

function redact(text) {
  let out = String(text);
  for (const secret of secrets) out = out.split(secret).join("[redacted]");
  return out;
}

function headersFor(kind) {
  const headers = { accept: "application/json" };
  if (kind === "fal" && process.env.FAL_KEY) headers.authorization = `Key ${process.env.FAL_KEY}`;
  if (kind === "openrouter" && process.env.OPENROUTER_API_KEY)
    headers.authorization = `Bearer ${process.env.OPENROUTER_API_KEY}`;
  return headers;
}

async function getJson(kind, url) {
  const res = await fetch(url, { headers: headersFor(kind) });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${kind} catalog ${res.status}: ${redact(text).slice(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${kind} catalog returned non-JSON (${res.status})`);
  }
}

async function fetchFal() {
  // expand=openapi-3.0 caps a single response (50 ids without it, fewer with the schema).
  const byId = new Map();
  const chunkSize = 8;
  for (let i = 0; i < endpoints.length; i += chunkSize) {
    const chunk = endpoints.slice(i, i + chunkSize);
    const url = new URL("https://api.fal.ai/v1/models");
    for (const spec of chunk) url.searchParams.append("endpoint_id", spec.endpoint);
    url.searchParams.append("expand", "openapi-3.0");
    const body = await getJson("fal", url);
    for (const model of body.models ?? []) byId.set(model.endpoint_id, model);
  }
  const missing = endpoints.filter((spec) => !byId.has(spec.endpoint)).map((spec) => spec.endpoint);
  if (missing.length) throw new Error(`fal catalog is missing ${missing.join(", ")}`);

  let prices = new Map();
  if (process.env.FAL_KEY) {
    const pricingUrl = new URL("https://api.fal.ai/v1/models/pricing");
    for (const spec of endpoints) pricingUrl.searchParams.append("endpoint_id", spec.endpoint);
    const priced = await getJson("fal", pricingUrl);
    prices = new Map((priced.prices ?? []).map((price) => [price.endpoint_id, price]));
  }

  return endpoints.map((spec) => falModel(spec, byId.get(spec.endpoint), prices.get(spec.endpoint)));
}

async function fetchOpenRouter() {
  const body = await getJson("openrouter", "https://openrouter.ai/api/v1/videos/models");
  const models = body.data ?? [];
  if (!models.length) throw new Error("OpenRouter video catalog returned no models");
  return models.map(openRouterModel);
}

function writeCatalog(name, source, docs, models) {
  const file = {
    source,
    docs,
    models: stable(models).sort((a, b) => a.id.localeCompare(b.id)),
  };
  const text = `${JSON.stringify(stable(file), null, 2)}\n`;
  if (secrets.some((secret) => text.includes(secret))) throw new Error(`Refusing to write ${name}: it contains a key`);
  writeFileSync(join(catalogDir, name), text);
  return file.models.length;
}

const [falModels, openRouterModels] = await Promise.all([fetchFal(), fetchOpenRouter()]);
const falCount = writeCatalog(
  "fal.json",
  "fal",
  "https://fal.ai/docs/platform-apis/v1/models",
  falModels,
);
const openRouterCount = writeCatalog(
  "openrouter.json",
  "openrouter",
  "https://openrouter.ai/docs/api/api-reference/video-generation/list-all-video-generation-models",
  openRouterModels,
);
console.log(
  `catalog:sync wrote ${falCount} fal models and ${openRouterCount} OpenRouter models` +
    (process.env.FAL_KEY ? " (fal prices included)" : " (fal prices skipped; set FAL_KEY to fetch them)"),
);
