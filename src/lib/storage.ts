// Users' assets in one Cloudflare R2 bucket (R2_BUCKET), addressed over the S3 API.
// Every object lives at "<id>/<key>": id is the row's workspace id when it has one,
// otherwise the user id. On this app those match — a personal workspace id is the
// user id. Keys stored in D1 stay bare (images/…, videos/…, uploads/…) so listing
// and isAssetKey keep working. The token can only read and write objects, so this
// module does not create buckets or set CORS. The `assets` table indexes every
// stored object; usage and the storage quota are summed from it.

import { AwsClient } from "aws4fetch";
import { all, env, first, run } from "./db";
import { candidateUserIds, referencedKeySet, withoutReferenced } from "./inputs";
import { isLocalBucket, localProviderUrl } from "./localBucket";
import { thumbKeyFor, uploadKindOf, type AssetItem } from "./uploads";

export interface Asset {
  userId: string;
  key: string;
  bucket: string;
  bytes: number;
  contentType: string;
  generationId: string | null;
  createdAt: number;
  /** Library uploads: display name. */
  name?: string | null;
  meta?: AssetMeta | null;
  /** Asset key this file was made from. The parent row is not changed. */
  parentId?: string | null;
  /** Catalog tool id, when a tool produced this file. */
  tool?: string | null;
  /**
   * Workspace id still stored on the row (0005, kept by 0008). Personal workspaces
   * use the user id. Null on rows written without one.
   */
  workspaceId?: string | null;
}

/** Library details, stored as JSON. */
export interface AssetMeta {
  duration?: number;
  peaks?: number[];
  /** Key of a small JPEG preview, for images and videos. */
  thumb?: string;
  width?: number;
  height?: number;
  /** Display label, for example "1920×1080" or "4K". */
  resolution?: string;
}

interface AssetRow {
  user_id: string;
  key: string;
  bucket: string;
  bytes: number;
  content_type: string;
  generation_id: string | null;
  created_at: number;
  name: string | null;
  meta: string | null;
  parent_id: string | null;
  tool: string | null;
  workspace_id?: string | null;
}

const toAsset = (r: AssetRow): Asset => ({
  userId: r.user_id,
  key: r.key,
  bucket: r.bucket,
  bytes: r.bytes,
  contentType: r.content_type,
  generationId: r.generation_id,
  createdAt: r.created_at,
  name: r.name,
  meta: r.meta ? (JSON.parse(r.meta) as AssetMeta) : null,
  parentId: r.parent_id,
  tool: r.tool,
  workspaceId: r.workspace_id ?? null,
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
  /** The shared bucket (R2_BUCKET). */
  bucket: string;
  client: AwsClient;
}

function r2(): R2Config {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT, R2_BUCKET } = env();
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET)
    throw new StorageError(
      "Storage isn't configured: set R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY",
      500,
    );
  return {
    endpoint: (R2_ENDPOINT || `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`).replace(/\/+$/, ""),
    bucket: R2_BUCKET,
    client: new AwsClient({
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
      service: "s3",
      region: "auto",
    }),
  };
}

/** Path-style URL; keys are made of safe characters (see videoKey) so no escaping is needed. */
const objectUrl = (cfg: R2Config, bucket: string, key = "") => `${cfg.endpoint}/${bucket}${key && `/${key}`}`;

/**
 * Signed S3 request. The payload isn't signed (aws4fetch's S3 default), so the body can be
 * a stream: it's attached after signing.
 */
async function s3(
  cfg: R2Config,
  url: string,
  { method, headers = {}, body }: { method: string; headers?: Record<string, string>; body?: BodyInit },
) {
  const signed = await cfg.client.sign(url, { method, headers });
  const res = await fetch(signed.url, {
    method,
    headers: signed.headers,
    body,
    ...(body instanceof ReadableStream && { duplex: "half" }),
  } as RequestInit);
  if (res.ok) return res;
  const xml = await res.text().catch(() => "");
  const code = xml.match(/<Code>([^<]+)<\/Code>/)?.[1];
  const msg = xml.match(/<Message>([^<]+)<\/Message>/)?.[1];
  throw Object.assign(new StorageError(`R2 ${res.status}${code ? ` ${code}` : ""}: ${msg ?? res.statusText}`), {
    code,
    upstreamStatus: res.status,
  });
}

// ---------------------------------------------------------------- where objects live

interface Location {
  bucket: string;
  path: string;
}

/** A new object: the shared bucket, under the owner's folder. */
const newLocation = (cfg: R2Config, ownerId: string, key: string): Location => ({
  bucket: cfg.bucket,
  path: `${ownerId}/${key}`,
});

/**
 * Where an asset's file (or its thumbnail, `key`) is. Folder is workspace id when
 * the row has one, otherwise the user id. Assets still recorded in some other
 * bucket stay at their bare key there.
 */
const locate = (cfg: R2Config, asset: Asset, key = asset.key): Location =>
  asset.bucket === cfg.bucket
    ? newLocation(cfg, asset.workspaceId ?? asset.userId, key)
    : { bucket: asset.bucket, path: key };

const urlOf = (cfg: R2Config, loc: Location) => objectUrl(cfg, loc.bucket, loc.path);

/** The shared bucket name. Throws if R2 isn't configured. Does not create a bucket. */
export async function ensureBucket(): Promise<string> {
  return r2().bucket;
}

// ---------------------------------------------------------------- assets

export const videoKey = (generationId: string) => `videos/${generationId.replace(/[^a-zA-Z0-9_-]/g, "")}.mp4`;

export async function getAsset(userId: string, key: string): Promise<Asset | undefined> {
  const row = await first<AssetRow>("SELECT * FROM assets WHERE user_id = ? AND key = ?", userId, key);
  return row && toAsset(row);
}

/**
 * The response body with a known length, ready to upload. Workers have 128 MB of memory,
 * so on Workers a body with a Content-Length is streamed through rather than buffered.
 */
async function uploadBody(res: Response): Promise<{ body: BodyInit; bytes: number }> {
  const length = Number(res.headers.get("content-length"));
  const FixedLength = (globalThis as { FixedLengthStream?: new (n: number) => TransformStream }).FixedLengthStream;
  if (FixedLength && res.body && length > 0) {
    const { readable, writable } = new FixedLength(length);
    // A failed read also fails the upload that consumes `readable`, which reports it.
    res.body.pipeTo(writable).catch(() => {});
    return { body: readable, bytes: length };
  }
  // Unknown length (or Node in `next dev`): buffer it.
  const buf = new Uint8Array(await res.arrayBuffer());
  return { body: buf, bytes: buf.byteLength };
}

/** Copies a fetched file (e.g. a provider's video) into the user's bucket and indexes it. */
export async function putAsset(
  userId: string,
  {
    key,
    source,
    contentType,
    generationId = null,
    parentId = null,
    tool = null,
    name = null,
    meta = null,
  }: {
    key: string;
    source: Response;
    contentType: string;
    generationId?: string | null;
    parentId?: string | null;
    tool?: string | null;
    name?: string | null;
    meta?: AssetMeta | null;
  },
): Promise<Asset> {
  const cfg = r2();
  const { body, bytes } = await uploadBody(source);
  await s3(cfg, urlOf(cfg, newLocation(cfg, userId, key)), {
    method: "PUT",
    body,
    // Content-Length comes from the body: a byte array or a FixedLengthStream.
    headers: { "Content-Type": contentType },
  });
  return recordAsset({
    userId,
    key,
    bucket: cfg.bucket,
    bytes,
    contentType,
    generationId,
    createdAt: Date.now(),
    parentId,
    tool,
    name,
    meta,
  });
}

async function recordAsset(asset: Asset): Promise<Asset> {
  const { userId, key, bucket, bytes, contentType, generationId } = asset;
  await run(
    `INSERT INTO assets (user_id, key, bucket, bytes, content_type, generation_id, created_at, name, meta, parent_id, tool)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, key) DO UPDATE SET
       bucket = excluded.bucket, bytes = excluded.bytes, content_type = excluded.content_type,
       created_at = excluded.created_at, name = excluded.name, meta = excluded.meta,
       parent_id = excluded.parent_id, tool = excluded.tool`,
    userId,
    key,
    bucket,
    bytes,
    contentType,
    generationId,
    asset.createdAt,
    asset.name ?? null,
    asset.meta ? JSON.stringify(asset.meta) : null,
    asset.parentId ?? null,
    asset.tool ?? null,
  );
  return asset;
}

export async function deleteAsset(asset: Asset) {
  if (isLocalBucket(asset)) {
    const { removeLocal } = await import("./localMedia");
    if (asset.meta?.thumb) await removeLocal(asset.userId, asset.meta.thumb).catch(() => {});
    await removeLocal(asset.userId, asset.key).catch(() => {});
    await run("DELETE FROM assets WHERE user_id = ? AND key = ?", asset.userId, asset.key);
    return;
  }
  const cfg = r2();
  if (asset.meta?.thumb) await deleteObject(cfg, locate(cfg, asset, asset.meta.thumb));
  await deleteObject(cfg, locate(cfg, asset));
  await run("DELETE FROM assets WHERE user_id = ? AND key = ?", asset.userId, asset.key);
}

async function deleteObject(cfg: R2Config, loc: Location) {
  await s3(cfg, urlOf(cfg, loc), { method: "DELETE" }).catch((e) => {
    if ((e as { upstreamStatus?: number }).upstreamStatus !== 404) throw e;
  });
}

export async function deleteGenerationAssets(userId: string, generationId: string) {
  const rows = await all<AssetRow>(
    "SELECT * FROM assets WHERE user_id = ? AND generation_id = ?",
    userId,
    generationId,
  );
  for (const row of rows) await deleteAsset(toAsset(row));
}

/** Deletes every indexed object under a key prefix, including ones with no generation id. */
export async function deleteAssetsUnder(userId: string, prefix: string) {
  const rows = await all<AssetRow>("SELECT * FROM assets WHERE user_id = ? AND key LIKE ?", userId, `${prefix}%`);
  for (const row of rows) await deleteAsset(toAsset(row));
}

// ---------------------------------------------------------------- browser uploads

const UPLOAD_URL_TTL_S = 15 * 60;

/** Signed URLs the browser PUTs files to. CORS on the shared bucket is set outside this app. */
export async function createUpload(userId: string, keys: string[]) {
  const cfg = r2();
  return Promise.all(keys.map((key) => presign(cfg, "PUT", newLocation(cfg, userId, key), UPLOAD_URL_TTL_S)));
}

async function headObject(cfg: R2Config, loc: Location) {
  const res = await s3(cfg, urlOf(cfg, loc), { method: "HEAD" }).catch((e) => {
    if ((e as { upstreamStatus?: number }).upstreamStatus === 404) return undefined;
    throw e;
  });
  return (
    res && {
      bytes: Number(res.headers.get("content-length")) || 0,
      contentType: res.headers.get("content-type") ?? "application/octet-stream",
    }
  );
}

/**
 * Indexes a file the browser uploaded, plus its thumbnail if one was sent. Size and type
 * come from what actually landed in the bucket. Returns undefined if the file isn't there.
 */
export async function completeUpload(userId: string, key: string, { name, meta }: { name: string; meta: AssetMeta }) {
  const cfg = r2();
  const file = await headObject(cfg, newLocation(cfg, userId, key));
  if (!file) return undefined;
  const thumb = meta.thumb ? await headObject(cfg, newLocation(cfg, userId, meta.thumb)) : undefined;
  return recordAsset({
    userId,
    key,
    bucket: cfg.bucket,
    // The thumbnail counts toward the quota too.
    bytes: file.bytes + (thumb?.bytes ?? 0),
    contentType: file.contentType,
    generationId: null,
    createdAt: Date.now(),
    name,
    meta: { ...meta, thumb: thumb ? meta.thumb : undefined },
  });
}

/**
 * Every asset the user would want to see, newest first: uploads, generated videos and
 * generated images, with the prompt and model of the generation that made them.
 */
export async function listAssets(userId: string): Promise<AssetItem[]> {
  const [rows, videoGens, imageGens, falJobs] = await Promise.all([
    all<AssetRow>(
      `SELECT * FROM assets WHERE user_id = ? AND (key LIKE 'uploads/%' OR key LIKE 'videos/%' OR key LIKE 'images/%' OR key LIKE 'fal/%')
       ORDER BY created_at DESC LIMIT 2000`,
      userId,
    ),
    all<{ id: string; model: string; prompt: string; duration: number }>(
      `SELECT id, json_extract(data, '$.model') AS model, json_extract(data, '$.prompt') AS prompt,
              json_extract(data, '$.duration') AS duration FROM generations WHERE user_id = ?`,
      userId,
    ),
    all<{ id: string; model: string; prompt: string }>(
      `SELECT id, json_extract(data, '$.model') AS model, json_extract(data, '$.prompt') AS prompt
       FROM image_generations WHERE user_id = ?`,
      userId,
    ),
    all<{ id: string; model: string; prompt: string | null }>(
      `SELECT id, json_extract(data, '$.endpointId') AS model, json_extract(data, '$.request.prompt') AS prompt
       FROM fal_jobs WHERE user_id = ?`,
      userId,
    ),
  ]);
  const videos = new Map(videoGens.map((g) => [g.id, g]));
  const images = new Map(imageGens.map((g) => [g.id, g]));
  const fal = new Map(falJobs.map((g) => [g.id, { ...g, prompt: g.prompt || g.model }]));

  return rows.flatMap((row): AssetItem[] => {
    const a = toAsset(row);
    const kind =
      uploadKindOf(a.contentType) ??
      (a.contentType.startsWith("image/")
        ? "image"
        : a.contentType.startsWith("video/")
          ? "video"
          : a.contentType.startsWith("audio/")
            ? "audio"
            : undefined);
    if (!kind) return [];
    const base = {
      key: a.key,
      kind,
      contentType: a.contentType,
      bytes: a.bytes,
      duration: a.meta?.duration,
      peaks: a.meta?.peaks,
      hasThumb: !!a.meta?.thumb,
      width: a.meta?.width,
      height: a.meta?.height,
      resolution: a.meta?.resolution,
      createdAt: a.createdAt,
    };
    const lineage = {
      ...(a.parentId ? { parentId: a.parentId } : {}),
      ...(a.tool ? { tool: a.tool } : {}),
    };
    if (a.key.startsWith("uploads/"))
      return [{ ...base, source: "upload", name: a.name ?? a.key.split("/").pop()! }];
    if (a.key.startsWith("fal/")) {
      const job = a.generationId ? fal.get(a.generationId) : undefined;
      if (!job) return [];
      return [
        {
          ...base,
          ...lineage,
          source: a.tool ? "processed" : "generated",
          name: (a.tool && a.name) || job.prompt.slice(0, 120) || a.name || "Untitled",
          generation: {
            id: job.id,
            tab: "fal",
            model: a.tool ?? job.model,
            prompt: a.tool ? a.name || "" : job.prompt,
          },
        },
      ];
    }
    const tab = a.key.startsWith("videos/") ? "video" : "image";
    const gen = a.generationId ? (tab === "video" ? videos : images).get(a.generationId) : undefined;
    // A file whose generation is gone shouldn't linger in the list.
    if (!gen) return [];
    return [
      {
        ...base,
        source: "generated",
        name: gen.prompt?.slice(0, 120) || "Untitled",
        duration: base.duration ?? (tab === "video" ? (videos.get(gen.id)?.duration ?? undefined) : undefined),
        generation: { id: gen.id, tab, model: gen.model, prompt: gen.prompt },
      },
    ];
  });
}

/** A signed URL for the browser to PUT a thumbnail it made for a generated image or video. */
export async function createThumbUpload(asset: Asset) {
  const cfg = r2();
  return presign(cfg, "PUT", locate(cfg, asset, thumbKeyFor(asset.key)), UPLOAD_URL_TTL_S);
}

/** Records a thumbnail the browser uploaded, if it's there and small. */
export async function attachThumb(asset: Asset) {
  const cfg = r2();
  const key = thumbKeyFor(asset.key);
  const thumb = await headObject(cfg, locate(cfg, asset, key));
  if (!thumb) return false;
  if (thumb.bytes > 1024 * 1024 || thumb.contentType !== "image/jpeg") {
    await deleteObject(cfg, locate(cfg, asset, key));
    return false;
  }
  await recordAsset({ ...asset, bytes: asset.bytes + thumb.bytes, meta: { ...asset.meta, thumb: key } });
  return true;
}

export async function renameAsset(userId: string, key: string, name: string) {
  await run("UPDATE assets SET name = ? WHERE user_id = ? AND key = ?", name, userId, key);
}

/** Removes an uploaded object that never got indexed (e.g. it failed validation). */
export async function discardUpload(userId: string, key: string) {
  const cfg = r2();
  await deleteObject(cfg, newLocation(cfg, userId, key));
}

/**
 * Keys stored on this page of users' generations. Other users are irrelevant: an asset
 * row is only protected by a generation with the same user_id.
 */
async function referencedByUsers(userIds: string[]) {
  if (!userIds.length) return new Set<string>();
  const marks = userIds.map(() => "?").join(", ");
  const [videos, images] = await Promise.all([
    all<{ user_id: string; data: string }>(
      `SELECT user_id, data FROM generations WHERE user_id IN (${marks})`,
      ...userIds,
    ),
    all<{ user_id: string; data: string }>(
      `SELECT user_id, data FROM image_generations WHERE user_id IN (${marks})`,
      ...userIds,
    ),
  ]);
  return referencedKeySet([...videos, ...images].map((r) => ({ userId: r.user_id, data: r.data })));
}

/**
 * Pre-library reference uploads (`refs/`) that never made it into a generation. Library
 * uploads (`uploads/`) are kept until the user deletes them. A `refs/` object whose key
 * is stored on one of that user's generations (start/end frame, reference block, or
 * image reference) is still in use, so it is left alone.
 */
export async function deleteOrphanUploads(prefix: string, olderThanMs: number) {
  const cutoff = Date.now() - olderThanMs;
  const doomed: AssetRow[] = [];
  let offset = 0;
  // Page past referenced rows. A protected object must not pin the LIMIT window and hide real orphans.
  while (doomed.length < 50 && offset < 500) {
    const rows = await all<AssetRow>(
      `SELECT * FROM assets WHERE generation_id IS NULL AND key LIKE ? AND created_at < ?
       ORDER BY created_at ASC, key ASC LIMIT 50 OFFSET ?`,
      `${prefix}%`,
      cutoff,
      offset,
    );
    if (!rows.length) break;
    offset += rows.length;
    // Only the users on this page. A sweep must not read every generation in the database.
    const referenced = await referencedByUsers(candidateUserIds(rows));
    for (const row of withoutReferenced(rows, referenced)) {
      doomed.push(row);
      if (doomed.length === 50) break;
    }
    if (rows.length < 50) break;
  }
  for (const row of doomed) await deleteAsset(toAsset(row));
  return doomed.length;
}

// ---------------------------------------------------------------- usage & quota

const GB = 1024 ** 3;

export async function storageUsage(userId: string) {
  const row = await first<{ objects: number; bytes: number }>(
    "SELECT COUNT(*) AS objects, COALESCE(SUM(bytes), 0) AS bytes FROM assets WHERE user_id = ?",
    userId,
  );
  const quotaGb = Number(env().STORAGE_QUOTA_GB) || 2;
  return { objects: row?.objects ?? 0, bytes: row?.bytes ?? 0, quotaBytes: Math.round(quotaGb * GB) };
}

/** Thrown before a generation or upload that would go over the user's quota. */
export async function assertStorageAvailable(userId: string, extraBytes = 0) {
  const { bytes, quotaBytes } = await storageUsage(userId);
  if (bytes + extraBytes > quotaBytes || bytes >= quotaBytes) {
    const gb = +(quotaBytes / GB).toFixed(1);
    throw new StorageError(`Your storage is full (${gb} GB). Delete some videos to keep generating.`, 403);
  }
}

// ---------------------------------------------------------------- serving

const SIGNED_URL_TTL_S = 3600;
// Providers can queue a job for minutes before fetching its references.
const PROVIDER_URL_TTL_S = 24 * 3600;

async function presign(
  cfg: R2Config,
  method: "GET" | "PUT",
  loc: Location,
  ttlSeconds: number,
  query: Record<string, string> = {},
) {
  const url = new URL(urlOf(cfg, loc));
  url.searchParams.set("X-Amz-Expires", String(ttlSeconds));
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return (await cfg.client.sign(new Request(url, { method }), { aws: { signQuery: true } })).url;
}

/** A link the video provider can download a reference from, without credentials. */
export const providerUrl = (asset: Asset) => {
  if (isLocalBucket(asset)) return Promise.resolve(localProviderUrl(asset.key));
  const cfg = r2();
  return presign(cfg, "GET", locate(cfg, asset), PROVIDER_URL_TTL_S);
};

/**
 * Redirects to a short-lived signed URL, so the bytes (and the player's Range
 * requests) go straight from R2 to the browser. R2 doesn't charge for egress.
 */
export async function serveAsset(
  asset: Asset,
  opts: { downloadName?: string; thumb?: boolean; range?: string | null } = {},
) {
  if (isLocalBucket(asset)) return serveLocal(asset, opts);
  const query: Record<string, string> = opts.downloadName
    ? { "response-content-disposition": `attachment; filename="${opts.downloadName}"` }
    : {};
  // The thumbnail when asked for and there is one; otherwise the file itself.
  const key = opts.thumb && asset.meta?.thumb ? asset.meta.thumb : asset.key;
  const cfg = r2();
  const location = await presign(cfg, "GET", locate(cfg, asset, key), SIGNED_URL_TTL_S, query);
  return new Response(null, {
    status: 302,
    // Cache the redirect for well under the signature's lifetime.
    headers: { Location: location, "Cache-Control": "private, max-age=600" },
  });
}

/**
 * Reads an object on the server. Callers that proxy bytes to a teammate use this
 * and return them directly, so the client never sees a signed URL.
 */
export async function openAsset(asset: Asset, opts: { thumb?: boolean; range?: string | null } = {}) {
  if (isLocalBucket(asset)) {
    const opened = await serveLocal(asset, opts);
    return {
      status: opened.status,
      body: opened.body,
      contentType: opened.headers.get("content-type"),
      contentLength: opened.headers.get("content-length"),
      contentRange: opened.headers.get("content-range"),
    };
  }
  const cfg = r2();
  const key = opts.thumb && asset.meta?.thumb ? asset.meta.thumb : asset.key;
  const headers: Record<string, string> = {};
  if (opts.range) headers.Range = opts.range;
  let res: Response;
  try {
    res = await s3(cfg, urlOf(cfg, locate(cfg, asset, key)), { method: "GET", headers });
  } catch (e) {
    if ((e as { upstreamStatus?: number }).upstreamStatus === 404) throw new StorageError("Not found", 404);
    throw e;
  }
  return {
    status: res.status,
    body: res.body,
    contentType: res.headers.get("content-type"),
    contentLength: res.headers.get("content-length"),
    contentRange: res.headers.get("content-range"),
  };
}

/** Dev fixture bytes. Same-origin, with Range, so a player can seek without R2. */
async function serveLocal(asset: Asset, opts: { downloadName?: string; thumb?: boolean; range?: string | null }) {
  const { readLocal } = await import("./localMedia");
  const key = opts.thumb && asset.meta?.thumb ? asset.meta.thumb : asset.key;
  const file = await readLocal(asset.userId, key, opts.range ?? null);
  if (file.status === 404) return new Response("Not found", { status: 404 });
  if (file.status === 416) {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${file.size}` } });
  }
  const headers = new Headers({
    "Content-Type": opts.thumb ? "image/jpeg" : asset.contentType,
    "Content-Length": file.contentLength,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=60",
  });
  if (file.contentRange) headers.set("Content-Range", file.contentRange);
  if (opts.downloadName) headers.set("Content-Disposition", `attachment; filename="${opts.downloadName}"`);
  return new Response(file.body, { status: file.status, headers });
}
