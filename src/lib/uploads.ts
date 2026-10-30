// The uploads library: what users can upload and use as references. Shared by the UI
// (pre-checks) and the API (enforcement). Limits follow ArgoLink's documented ones, the
// stricter of the providers: https://argolink.io/en/models/seedance-2.5

export type UploadKind = "image" | "video" | "audio";

export interface UploadRule {
  /** MIME type → file extension */
  types: Record<string, string>;
  maxBytes: number;
  /** Media length limits; images have none. */
  seconds?: { min: number; max: number };
  label: string;
}

export const UPLOAD_RULES: Record<UploadKind, UploadRule> = {
  image: {
    types: { "image/jpeg": "jpg", "image/png": "png" },
    maxBytes: 20 * 1024 * 1024,
    label: "JPEG or PNG, up to 20 MB",
  },
  video: {
    types: { "video/mp4": "mp4", "video/quicktime": "mov" },
    maxBytes: 100 * 1024 * 1024,
    seconds: { min: 2, max: 30 },
    label: "MP4 or MOV, up to 100 MB, 2–30 s",
  },
  audio: {
    types: { "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav" },
    maxBytes: 15 * 1000 * 1000,
    seconds: { min: 2, max: 30 },
    label: "MP3 or WAV, up to 15 MB, 2–30 s",
  },
};

export const uploadKindOf = (contentType: string): UploadKind | undefined =>
  (Object.keys(UPLOAD_RULES) as UploadKind[]).find((k) => UPLOAD_RULES[k].types[contentType]);

/** Library files live under this prefix in the user's bucket. */
export const LIBRARY_PREFIX = "uploads/";
export const thumbKeyFor = (key: string) => key.replace(/\.[a-z0-9]+$/, ".thumb.jpg");

/** A library item as the API returns it. */
export interface UploadItem {
  key: string;
  kind: UploadKind;
  name: string;
  contentType: string;
  bytes: number;
  duration?: number;
  /** Waveform bar heights (0–100), for audio. */
  peaks?: number[];
  hasThumb: boolean;
  createdAt: number;
}

export type AssetSource = "upload" | "generated";

/** Anything in the user's bucket they'd want to see: uploads plus generated videos and images. */
export interface AssetItem extends UploadItem {
  source: AssetSource;
  /** For generated assets: what made it. */
  generation?: { id: string; tab: "video" | "image"; model: string; prompt: string };
}

/** Keys of assets the app lists and lets users reference (not thumbnails or old `refs/`). */
export const isAssetKey = (key: string) => /^(uploads|videos|images)\/[\w./-]+$/.test(key) && !key.includes("..");

/** Stable same-origin URLs; the server redirects to a short-lived signed R2 URL. */
export const assetFileUrl = (key: string, opts: { thumb?: boolean; download?: boolean } = {}) =>
  `/api/assets/file?key=${encodeURIComponent(key)}${opts.thumb ? "&thumb=1" : ""}${opts.download ? "&download" : ""}`;

/** References are sent as `upload:<key>` for files in the user's bucket. */
export const UPLOAD_PREFIX = "upload:";
export const isUploadRef = (v: string) => v.startsWith(UPLOAD_PREFIX);
export const uploadKeyOf = (v: string) => v.slice(UPLOAD_PREFIX.length);
