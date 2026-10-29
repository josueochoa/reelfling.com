// Where users' assets live. With R2 configured, every user gets their own bucket in
// the app's Cloudflare account; otherwise files go to $DATA_DIR on local disk.
// The `assets` table indexes every stored object, and storage usage is summed from it.

import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { AwsClient } from "aws4fetch";
import { DATA_DIR, db } from "./db";

export type Driver = "local" | "r2";

export interface Asset {
  userId: string;
  key: string;
  driver: Driver;
  bucket: string | null;
  bytes: number;
  contentType: string;
  generationId: string | null;
  createdAt: number;
}

interface AssetRow {
  user_id: string;
  key: string;
  driver: Driver;
  bucket: string | null;
  bytes: number;
  content_type: string;
  generation_id: string | null;
  created_at: number;
}

const toAsset = (r: AssetRow): Asset => ({
  userId: r.user_id,
  key: r.key,
  driver: r.driver,
  bucket: r.bucket,
  bytes: r.bytes,
  contentType: r.content_type,
  generationId: r.generation_id,
  createdAt: r.created_at,
});

export class StorageError extends Error {
  constructor(
    message: string,
    public status = 502,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------- R2 config

interface R2Config {
  endpoint: string;
  prefix: string;
  client: AwsClient;
}

let r2Cache: R2Config | null | undefined;

/** R2 is on when the account ID and S3 credentials are all set. */
function r2(): R2Config | null {
  if (r2Cache !== undefined) return r2Cache;
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT, R2_BUCKET_PREFIX } = process.env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) return (r2Cache = null);
  const prefix = (R2_BUCKET_PREFIX || "seedance").toLowerCase();
  // Bucket names: 3–63 chars of [a-z0-9-]. The prefix plus a 36-char user ID must fit.
  if (!/^[a-z0-9][a-z0-9-]{0,20}$/.test(prefix))
    throw new Error("R2_BUCKET_PREFIX must be 1–21 chars of a-z, 0-9 and '-', starting with a letter or digit.");
  r2Cache = {
    endpoint: (R2_ENDPOINT || `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`).replace(/\/+$/, ""),
    prefix,
    client: new AwsClient({
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
      service: "s3",
      region: "auto",
    }),
  };
  return r2Cache;
}

export const activeDriver = (): Driver => (r2() ? "r2" : "local");

/** Path-style URL; keys are made of safe characters (see assetKey) so no escaping is needed. */
const objectUrl = (cfg: R2Config, bucket: string, key = "") => `${cfg.endpoint}/${bucket}${key && `/${key}`}`;

async function s3(cfg: R2Config, url: string, init: RequestInit & { headers?: Record<string, string> } = {}) {
  const res = await cfg.client.fetch(url, {
    ...init,
    // Videos are large; skip hashing the body (R2 accepts unsigned payloads).
    headers: { "x-amz-content-sha256": "UNSIGNED-PAYLOAD", ...init.headers },
  });
  if (res.ok) return res;
  const xml = await res.text().catch(() => "");
  const code = xml.match(/<Code>([^<]+)<\/Code>/)?.[1];
  const msg = xml.match(/<Message>([^<]+)<\/Message>/)?.[1];
  throw Object.assign(new StorageError(`R2 ${res.status}${code ? ` ${code}` : ""}: ${msg ?? res.statusText}`), {
    code,
    upstreamStatus: res.status,
  });
}

// ---------------------------------------------------------------- buckets

export const bucketName = (userId: string) => `${r2()!.prefix}-${userId.toLowerCase()}`;

export function getBucket(userId: string): string | undefined {
  const row = db.prepare("SELECT name FROM buckets WHERE user_id = ?").get(userId) as { name: string } | undefined;
  return row?.name;
}

const creating = new Map<string, Promise<string>>();

/** Creates the user's bucket on first use (idempotent; concurrent callers share one request). */
export function ensureBucket(userId: string): Promise<string> {
  const cfg = r2();
  if (!cfg) return Promise.reject(new StorageError("R2 isn't configured", 500));
  const existing = getBucket(userId);
  if (existing) return Promise.resolve(existing);

  if (!creating.has(userId)) {
    const job = (async () => {
      const name = bucketName(userId);
      try {
        await s3(cfg, objectUrl(cfg, name), { method: "PUT" });
      } catch (e) {
        // Already ours from an earlier attempt that didn't get recorded.
        if ((e as { code?: string }).code !== "BucketAlreadyOwnedByYou") throw e;
      }
      db.prepare("INSERT OR IGNORE INTO buckets (user_id, name, created_at) VALUES (?, ?, ?)").run(
        userId,
        name,
        Date.now(),
      );
      return name;
    })().finally(() => creating.delete(userId));
    creating.set(userId, job);
  }
  return creating.get(userId)!;
}

// ---------------------------------------------------------------- assets

export const videoKey = (generationId: string) => `videos/${generationId.replace(/[^a-zA-Z0-9_-]/g, "")}.mp4`;

const localPath = (key: string) => path.join(DATA_DIR, key);

export function getAsset(userId: string, key: string): Asset | undefined {
  const row = db.prepare("SELECT * FROM assets WHERE user_id = ? AND key = ?").get(userId, key) as
    AssetRow | undefined;
  return row && toAsset(row);
}

function recordAsset(a: Asset) {
  db.prepare(
    `INSERT INTO assets (user_id, key, driver, bucket, bytes, content_type, generation_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, key) DO UPDATE SET
       driver = excluded.driver, bucket = excluded.bucket, bytes = excluded.bytes,
       content_type = excluded.content_type, created_at = excluded.created_at`,
  ).run(a.userId, a.key, a.driver, a.bucket, a.bytes, a.contentType, a.generationId, a.createdAt);
  return a;
}

/** Writes an object to the active driver and indexes it. */
export async function putAsset(
  userId: string,
  { key, body, contentType, generationId = null }: { key: string; body: Buffer; contentType: string; generationId?: string | null },
): Promise<Asset> {
  const cfg = r2();
  let bucket: string | null = null;
  if (cfg) {
    bucket = await ensureBucket(userId);
    await s3(cfg, objectUrl(cfg, bucket, key), {
      method: "PUT",
      body: new Uint8Array(body),
      headers: { "Content-Type": contentType, "Content-Length": String(body.length) },
    });
  } else {
    const file = localPath(key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(`${file}.part`, body);
    await fs.rename(`${file}.part`, file);
  }
  return recordAsset({
    userId,
    key,
    driver: cfg ? "r2" : "local",
    bucket,
    bytes: body.length,
    contentType,
    generationId,
    createdAt: Date.now(),
  });
}

export async function deleteAsset(asset: Asset) {
  if (asset.driver === "r2") {
    const cfg = r2();
    if (!cfg) throw new StorageError("Can't delete from R2: it isn't configured anymore", 500);
    await s3(cfg, objectUrl(cfg, asset.bucket!, asset.key), { method: "DELETE" }).catch((e) => {
      if ((e as { upstreamStatus?: number }).upstreamStatus !== 404) throw e;
    });
  } else {
    await fs.rm(localPath(asset.key), { force: true });
  }
  db.prepare("DELETE FROM assets WHERE user_id = ? AND key = ?").run(asset.userId, asset.key);
}

export async function deleteGenerationAssets(userId: string, generationId: string) {
  const rows = db.prepare("SELECT * FROM assets WHERE user_id = ? AND generation_id = ?").all(userId, generationId);
  for (const row of rows as unknown as AssetRow[]) await deleteAsset(toAsset(row));
}

/**
 * Indexes a file that was written to local disk before the assets table existed.
 * Returns undefined if there's no such file.
 */
export async function adoptLegacyFile(userId: string, key: string, generationId: string, contentType: string) {
  const stat = await fs.stat(localPath(key)).catch(() => null);
  if (!stat) return undefined;
  return recordAsset({
    userId,
    key,
    driver: "local",
    bucket: null,
    bytes: stat.size,
    contentType,
    generationId,
    createdAt: stat.mtimeMs,
  });
}

/** Moves a local asset into the user's bucket once R2 is switched on. */
export async function migrateToR2(asset: Asset): Promise<Asset> {
  if (asset.driver === "r2" || !r2()) return asset;
  const body = await fs.readFile(localPath(asset.key));
  const moved = await putAsset(asset.userId, { ...asset, body });
  await fs.rm(localPath(asset.key), { force: true });
  return moved;
}

export function storageUsage(userId: string) {
  const row = db.prepare("SELECT COUNT(*) AS objects, COALESCE(SUM(bytes), 0) AS bytes FROM assets WHERE user_id = ?").get(
    userId,
  ) as { objects: number; bytes: number };
  return { driver: activeDriver(), bucket: r2() ? (getBucket(userId) ?? null) : null, ...row };
}

// ---------------------------------------------------------------- serving

const SIGNED_URL_TTL_S = 3600;

/**
 * R2: redirects to a short-lived signed URL, so bytes (and Range requests) go straight
 * from Cloudflare to the browser. Local: streams the file with Range support.
 */
export async function serveAsset(asset: Asset, request: Request, opts: { downloadName?: string } = {}) {
  const disposition = opts.downloadName && `attachment; filename="${opts.downloadName}"`;

  if (asset.driver === "r2") {
    const cfg = r2();
    if (!cfg) return new Response("Storage unavailable", { status: 503 });
    const url = new URL(objectUrl(cfg, asset.bucket!, asset.key));
    url.searchParams.set("X-Amz-Expires", String(SIGNED_URL_TTL_S));
    if (disposition) url.searchParams.set("response-content-disposition", disposition);
    const signed = await cfg.client.sign(new Request(url, { method: "GET" }), { aws: { signQuery: true } });
    return new Response(null, {
      status: 302,
      // Cache the redirect for well under the signature's lifetime.
      headers: { Location: signed.url, "Cache-Control": "private, max-age=600" },
    });
  }

  const file = localPath(asset.key);
  const stat = await fs.stat(file).catch(() => null);
  if (!stat) return new Response("Not found", { status: 404 });
  const headers: Record<string, string> = {
    "Content-Type": asset.contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=31536000, immutable",
    ...(disposition && { "Content-Disposition": disposition }),
  };

  const range = request.headers.get("range")?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
    if (start >= stat.size || start > end)
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${stat.size}` } });
    const stream = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream;
    return new Response(stream, {
      status: 206,
      headers: {
        ...headers,
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Content-Length": String(end - start + 1),
      },
    });
  }

  const stream = Readable.toWeb(createReadStream(file)) as ReadableStream;
  return new Response(stream, { headers: { ...headers, "Content-Length": String(stat.size) } });
}
