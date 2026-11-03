import type { ImageResolution } from "./types";

/** GPT Image takes exact pixel sizes instead of a ratio and a resolution. */
const GPT_SIZES: Record<string, readonly [string, string, string]> = {
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

const ORDER: ImageResolution[] = ["1k", "2k", "4k"];

export function gptSize(ratio: string, resolution: string) {
  const index = ORDER.indexOf(resolution as ImageResolution);
  return index < 0 ? undefined : GPT_SIZES[ratio]?.[index];
}
