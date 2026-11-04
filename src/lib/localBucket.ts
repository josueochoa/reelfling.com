/** Bucket name for files kept on disk during `next dev` when R2 is not configured. */
export const LOCAL_BUCKET = "local";

/** Dev-only rows. Production always uses R2, even if a row says "local". */
export function isLocalBucket(asset: { bucket: string }): boolean {
  return process.env.NODE_ENV === "development" && asset.bucket === LOCAL_BUCKET;
}

/**
 * A URL with no credentials. Mocked providers never fetch it. A real provider
 * cannot download a dev-only file, which is the same as having no R2.
 */
export function localProviderUrl(key: string): string {
  return `https://example.invalid/dev-media/${encodeURIComponent(key)}`;
}
