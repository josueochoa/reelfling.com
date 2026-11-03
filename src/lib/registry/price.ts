import type { EstimateInput, ModelEntry, PriceFormula } from "./types";

function rate(table: Readonly<Record<string, number>> | undefined, resolution: string | undefined) {
  if (!table) return undefined;
  if (resolution && table[resolution] !== undefined) return table[resolution];
  if (table["*"] !== undefined) return table["*"];
  const values = Object.values(table);
  return values.length === 1 ? values[0] : undefined;
}

/** USD the user's provider is expected to bill. Undefined when the entry has no formula. */
export function estimateCost(model: Pick<ModelEntry, "price">, input: EstimateInput = {}): number | undefined {
  const price = model.price;
  if (!price) return undefined;
  const amount = applyPrice(price, input);
  if (amount === undefined) return undefined;
  const minimum = price.type === "per_second" ? price.minimum : undefined;
  const total = minimum !== undefined ? Math.max(amount, minimum) : amount;
  // Rates are decimal dollars. Snap so 50 × 0.0523 displays as $2.62, not $2.61.
  return Math.round(total * 1e8) / 1e8;
}

function videoInput(input: EstimateInput) {
  return input.referenceVideoSeconds !== undefined;
}

/** ArgoLink: output + floored reference seconds, at least ceil(output × 5/3). */
function argolinkBilledSeconds(output: number, referenceVideoSeconds: number) {
  return Math.max(output + Math.floor(referenceVideoSeconds), Math.ceil((output * 5) / 3));
}

function applyPrice(price: PriceFormula, input: EstimateInput): number | undefined {
  const count = input.count ?? 1;
  if (price.type === "per_second") {
    const withVideo = videoInput(input) && price.byResolutionWithVideo;
    const table = withVideo
      ? price.byResolutionWithVideo
      : input.audio && price.byResolutionWithAudio
        ? price.byResolutionWithAudio
        : price.byResolution;
    const perSecond =
      rate(table, input.resolution) ??
      (input.audio && !withVideo ? rate(price.byResolution, input.resolution) : undefined);
    if (perSecond === undefined || input.duration === undefined) return undefined;
    const ref = input.referenceVideoSeconds ?? 0;
    const seconds =
      withVideo && !input.durationIsBilled && price.referenceBilling === "argolink"
        ? argolinkBilledSeconds(input.duration, ref)
        : input.duration;
    return perSecond * seconds;
  }
  if (price.type === "per_image") {
    const each = rate(price.byResolution, input.resolution) ?? price.usd;
    return each === undefined ? undefined : each * count;
  }
  if (price.type === "per_megapixel") {
    const mp = input.megapixels ?? 1;
    const seconds = price.perSecond ? (input.duration ?? 1) : 1;
    return price.usd * mp * seconds;
  }
  const withVideo =
    videoInput(input) && (price.byResolutionWithVideo !== undefined || price.usdPerTokenWithVideo !== undefined);
  const usdPerToken = withVideo
    ? (rate(price.byResolutionWithVideo, input.resolution) ??
      price.usdPerTokenWithVideo ??
      rate(price.byResolution, input.resolution) ??
      price.usdPerToken)
    : (rate(price.byResolution, input.resolution) ?? price.usdPerToken);
  if (input.duration !== undefined && price.pixels) {
    const px = price.pixels[input.resolution ?? ""] ?? price.pixels["*"];
    if (!px) return undefined;
    const ref = withVideo && !input.durationIsBilled ? (input.referenceVideoSeconds ?? 0) : 0;
    const tokens = ((input.duration + ref) * px.width * px.height * (price.fps ?? 24)) / 1024;
    return tokens * usdPerToken;
  }
  const perImage =
    typeof price.tokensPerImage === "number"
      ? price.tokensPerImage
      : price.tokensPerImage?.[input.resolution ?? ""];
  return perImage === undefined ? undefined : perImage * usdPerToken * count;
}

export function ratioAllowed(
  model: { capabilities: { ratios: readonly string[]; ratioResolutions?: Readonly<Record<string, readonly string[]>> } },
  ratio: string,
  resolution: string,
) {
  if (!model.capabilities.ratios.includes(ratio)) return false;
  const only = model.capabilities.ratioResolutions?.[ratio];
  return !only || only.includes(resolution);
}

/** The supported ratio closest to an image's shape, for Auto with a reference image. */
export function nearestRatio(
  model: { capabilities: { ratios: readonly string[]; ratioResolutions?: Readonly<Record<string, readonly string[]>> } },
  width: number,
  height: number,
  resolution: string,
) {
  const target = Math.log(width / height);
  let best = "1:1";
  let bestDiff = Infinity;
  for (const r of model.capabilities.ratios) {
    if (r === "auto" || !ratioAllowed(model, r, resolution)) continue;
    const [w, h] = r.split(":").map(Number);
    if (!w || !h) continue;
    const diff = Math.abs(Math.log(w / h) - target);
    if (diff < bestDiff) {
      best = r;
      bestDiff = diff;
    }
  }
  return best;
}
