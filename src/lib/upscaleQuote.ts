// Cost, output size, and bulk planning for upscale. No catalog and no keys:
// the browser can import this. Rates arrive on the tool view from /api/models.

import type { ToolQuote } from "./toolTypes";

const FACTOR: Record<string, number> = { "2x": 2, "4x": 4 };

/** Output pixels for a 2× or 4× target. Named resolutions (1080p, 4K) are not guessed. */
export function outputPixels(input: {
  width?: number;
  height?: number;
  target?: string;
}): { width: number; height: number } | undefined {
  const factor = input.target ? FACTOR[input.target] : undefined;
  if (!factor || !input.width || !input.height || input.width <= 0 || input.height <= 0) return undefined;
  return { width: input.width * factor, height: input.height * factor };
}

/** Named target the form already has. A scale factor is not turned into 1080p or 4K. */
function namedResolution(target: string | undefined): string | undefined {
  if (target === "1080p" || target === "4K") return target;
  return undefined;
}

/**
 * USD from a published formula. Undefined when the formula or the file's size
 * isn't enough to compute one — callers show no number. Per-frame video prices
 * are not a formula here: they need a frame rate, and the file doesn't have one.
 */
export function upscaleCost(
  quote: ToolQuote | undefined,
  input: { width?: number; height?: number; duration?: number; target?: string },
): number | undefined {
  if (!quote) return undefined;
  if (quote.type === "per_image") return quote.usd;
  if (quote.type === "per_second") {
    if (input.duration === undefined || !(input.duration > 0)) return undefined;
    const label = namedResolution(input.target);
    const rate = (label !== undefined ? quote.byResolution[label] : undefined) ?? quote.byResolution["*"];
    if (rate === undefined) return undefined;
    return rate * input.duration;
  }
  const px = outputPixels(input);
  if (!px) return undefined;
  const megapixels = (px.width * px.height) / 1_000_000;
  if (quote.type === "output_megapixel_block") {
    if (!(quote.block > 0)) return undefined;
    return Math.ceil(megapixels / quote.block) * quote.usd;
  }
  if (quote.type === "output_megapixels") return quote.usd * megapixels;
  return undefined;
}

/** "$0.25" at or above a cent. Smaller amounts keep the significant digits, so $0.004 isn't shown as $0.00. */
export function formatUpscaleCost(usd: number): string {
  if (usd >= 0.01) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(4).replace(/0+$/, "")}`;
}

function roundDim(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.round(value);
}

/**
 * Resolution to store on the new asset. Measured pixels win. Otherwise a scale
 * factor times the source size. A named target is the label fal uses (4K for 2160p).
 */
export function upscaleResolution(
  params: Record<string, string | number | boolean>,
  source?: { width?: number; height?: number },
  measured?: { width?: number; height?: number },
): { width?: number; height?: number; resolution?: string } {
  const measuredWidth = roundDim(measured?.width);
  const measuredHeight = roundDim(measured?.height);
  if (measuredWidth && measuredHeight)
    return { width: measuredWidth, height: measuredHeight, resolution: `${measuredWidth}×${measuredHeight}` };
  const factor = typeof params.upscale_factor === "number" ? params.upscale_factor : undefined;
  const sourceWidth = roundDim(source?.width);
  const sourceHeight = roundDim(source?.height);
  if (factor && factor > 0 && sourceWidth && sourceHeight) {
    const width = Math.round(sourceWidth * factor);
    const height = Math.round(sourceHeight * factor);
    return { width, height, resolution: `${width}×${height}` };
  }
  if (params.target_resolution === "2160p") return { resolution: "4K" };
  if (typeof params.target_resolution === "string" && params.target_resolution)
    return { resolution: params.target_resolution };
  if (factor && factor > 0) return { resolution: `${factor}×` };
  return {};
}

export interface PlannedToolJob {
  toolId: string;
  assetIds: [string];
  params: Record<string, string | number | boolean>;
}

/** One job per asset, same settings. A mixed selection is rejected. */
export function planBulkToolJobs(
  assets: readonly { key: string; kind: string }[],
  tool: { id: string; accepts: "image" | "video" },
  params: Record<string, string | number | boolean>,
): PlannedToolJob[] {
  if (assets.length === 0) throw new Error("Choose at least one asset.");
  if (assets.some((asset) => asset.kind !== tool.accepts))
    throw new Error(tool.accepts === "image" ? "This upscale needs images only." : "This upscale needs videos only.");
  return assets.map((asset) => ({
    toolId: tool.id,
    assetIds: [asset.key],
    params: { ...params },
  }));
}
