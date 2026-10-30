// Image models (the Image tab), all through ArgoLink's OpenAI-style images API.
// Docs: https://argolink.io/en/models/nano-banana-2.1, https://argolink.io/en/models/gpt-image-2.5-sunburst

export type ImageResolution = "1k" | "2k" | "4k";
export type ImageQuality = "auto" | "low" | "medium" | "high";

export interface ImageModelSpec {
  id: string;
  label: string;
  brand: "google" | "openai";
  description: string;
  /** "auto" follows the first reference image (or the model's default without one). */
  ratios: string[];
  resolutions: ImageResolution[];
  /** Only GPT Image takes a quality setting. */
  qualities?: ImageQuality[];
  maxImages: number;
  maxReferences: number;
  /** USD per returned image. */
  price: Record<ImageResolution, number>;
}

export const IMAGE_MODELS: ImageModelSpec[] = [
  {
    id: "nano-banana-2.1",
    label: "Nano Banana 2.1",
    brand: "google",
    description: "Google's image model. Thinks before drawing; great at edits that keep faces and details.",
    ratios: [
      "auto",
      "1:1",
      "16:9",
      "9:16",
      "4:3",
      "3:4",
      "3:2",
      "2:3",
      "5:4",
      "4:5",
      "21:9",
      "1:4",
      "4:1",
      "1:8",
      "8:1",
    ],
    resolutions: ["1k", "2k", "4k"],
    maxImages: 4,
    maxReferences: 14,
    price: { "1k": 0.02, "2k": 0.02, "4k": 0.025 },
  },
  {
    id: "gpt-image-2.5-sunburst",
    label: "GPT Image 2.5 Sunburst",
    brand: "openai",
    description: "OpenAI's image model for precise generation and editing.",
    ratios: ["auto", "1:1", "3:4", "4:3", "2:3", "3:2", "9:16", "16:9", "21:9", "5:2"],
    resolutions: ["1k", "2k", "4k"],
    qualities: ["auto", "low", "medium", "high"],
    maxImages: 4,
    maxReferences: 16,
    price: { "1k": 0.015, "2k": 0.015, "4k": 0.02 },
  },
];

export const getImageModel = (id: string) => IMAGE_MODELS.find((m) => m.id === id);

/** Nano Banana's extreme ratios exist at 1K only. */
export const ratioAllowed = (model: ImageModelSpec, ratio: string, resolution: ImageResolution) =>
  model.ratios.includes(ratio) &&
  !(model.id.startsWith("nano-banana") && /^(1:4|4:1|1:8|8:1)$/.test(ratio) && resolution !== "1k");

/** GPT Image takes exact pixel sizes instead of a ratio and resolution. */
const GPT_SIZES: Record<string, [string, string, string]> = {
  "1:1": ["1024x1024", "1440x1440", "2160x2160"],
  "3:4": ["768x1024", "1440x1920", "2160x2880"],
  "4:3": ["1024x768", "1920x1440", "2880x2160"],
  "2:3": ["682x1024", "1152x1728", "2160x3240"],
  "3:2": ["1024x682", "1728x1152", "3240x2160"],
  "9:16": ["576x1024", "1152x2048", "2160x3840"],
  "16:9": ["1024x576", "2048x1152", "3840x2160"],
  "21:9": ["1024x439", "2048x878", "3840x1646"],
  "5:2": ["1024x410", "2048x819", "3840x1536"],
};
export const gptSize = (ratio: string, resolution: ImageResolution) =>
  GPT_SIZES[ratio]?.[["1k", "2k", "4k"].indexOf(resolution)];

export const estimateImageCost = (model: ImageModelSpec, resolution: ImageResolution, n: number) =>
  model.price[resolution] * n;

/** The supported ratio closest to an image's shape, for "auto" with a reference image. */
export function nearestRatio(model: ImageModelSpec, width: number, height: number, resolution: ImageResolution) {
  const target = Math.log(width / height);
  let best = "1:1";
  let bestDiff = Infinity;
  for (const r of model.ratios) {
    if (r === "auto" || !ratioAllowed(model, r, resolution)) continue;
    const [w, h] = r.split(":").map(Number);
    const diff = Math.abs(Math.log(w / h) - target);
    if (diff < bestDiff) [best, bestDiff] = [r, diff];
  }
  return best;
}
