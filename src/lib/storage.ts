// Users' assets in Cloudflare R2: every user gets their own bucket in the app's
// Cloudflare account, managed over R2's S3 API (bindings are fixed at deploy time,
// so they can't address per-user buckets). The `assets` table indexes every stored
// object; usage and the storage quota are summed from it.

import { createHash } from "node:crypto";
import { AwsClient } from "aws4fetch";
import { all, env, first, run } from "./db";
import { candidateUserIds, referencedKeySet, withoutReferenced } from "./inputs";
import { byWorkspace, wsArgs } from "./scope";
import { thumbKeyFor, uploadKindOf, type AssetItem, type Creator } from "./uploads";

export interface Asset {
  /** Creator. Personal rows use the user id; the primary key stays (user_id, key). */
  userId: string;
  workspaceId: string;
  createdBy: string | null;
  key: string;
  bucket: string;
  bytes: number;
  contentType: string;
  generationId: string | null;
  createdAt: number;
  /** Library uploads: display name. */
  name?: string | null;
  meta?: AssetMeta | null;
}

/** Library details, stored as JSON. */
export interface AssetMeta {
  duration?: number;
  peaks?: number[];
  /** Key of a small JPEG preview, for images and videos. */
  thumb?: string;
}

interface AssetRow {
  user_id: string;
  workspace_id: string | null;
  created_by: string | null;
  key: string;
  bucket: string;
  bytes: number;
  content_type: string;
  generation_id: string | null;
  created_at: number;
  name: string | null;
  meta: string | null;
}

const toAsset = (r: AssetRow): Asset => ({
  userId: r.user_id,
  workspaceId: r.workspace_id ?? r.user_id,
  createdBy: r.created_by,
  key: r.key,
  bucket: r.bucket,
  bytes: r.bytes,
  contentType: r.content_type,
  generationId: r.generation_id,
  createdAt: r.created_at,
  name: r.name,
  meta: r.meta ? (JSON.parse(r.meta) as AssetMeta) : null,
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

function r2(): R2Config {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT, R2_BUCKET_PREFIX } = env();
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY)
    throw new StorageError(
      "Storage isn't configured: set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY",
      500,
    );
  const prefix = (R2_BUCKET_PREFIX || "seedance").toLowerCase();
  // Bucket names: 3–63 chars of [a-z0-9-]. The prefix plus a 36-char user ID must fit.
  if (!/^[a-z0-9][a-z0-9-]{0,20}$/.test(prefix))
    throw new StorageError(
      "R2_BUCKET_PREFIX must be 1–21 chars of a-z, 0-9 and '-', starting with a letter or digit",
      500,
    );
  return {
    endpoint: (R2_ENDPOINT || `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`).replace(/\/+$/, ""),
    prefix,
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

// ---------------------------------------------------------------- buckets

export async function getBucket(workspaceId: string): Promise<string | undefined> {
  return (
    await first<{ name: string }>(
      `SELECT name FROM buckets WHERE workspace_id = ? OR (user_id = ? AND workspace_id IS NULL)`,
      workspaceId,
      workspaceId,
    )
  )?.name;
}

/**
 * Creates the workspace's bucket on first use. Personal workspaces keep user_id set
 * (the bucket name stays prefix + user id). A team bucket has user_id NULL.
 */
export async function ensureBucket(workspaceId: string): Promise<string> {
  const existing = await getBucket(workspaceId);
  if (existing) return existing;
  const cfg = r2();
  const name = `${cfg.prefix}-${workspaceId.toLowerCase()}`;
  const kind = (await first<{ kind: string }>("SELECT kind FROM workspaces WHERE id = ?", workspaceId))?.kind;
  const team = kind === "team";
  try {
    await s3(cfg, objectUrl(cfg, name), { method: "PUT" });
  } catch (e) {
    // Created by a concurrent request, or by an earlier attempt that didn't get recorded.
    if ((e as { code?: string }).code !== "BucketAlreadyOwnedByYou") throw e;
  }
  if (team) {
    await run(
      "INSERT OR IGNORE INTO buckets (user_id, name, created_at, workspace_id) VALUES (NULL, ?, ?, ?)",
      name,
      Date.now(),
      workspaceId,
    );
  } else {
    await run(
      "INSERT OR IGNORE INTO buckets (user_id, name, created_at, workspace_id) VALUES (?, ?, ?, ?)",
      workspaceId,
      name,
      Date.now(),
      workspaceId,
    );
  }
  return name;
}

/**
 * Lets browsers PUT uploads straight into the bucket. Any origin is fine: every request
 * still needs a URL signed by the server, which is the actual access control.
 */
async function ensureCors(workspaceId: string, bucket: string) {
  const row = await first<{ cors: number }>(
    "SELECT cors FROM buckets WHERE workspace_id = ? OR (user_id = ? AND workspace_id IS NULL)",
    workspaceId,
    workspaceId,
  );
  if (row?.cors) return;
  const cfg = r2();
  const xml =
    "<CORSConfiguration><CORSRule>" +
    "<AllowedOrigin>*</AllowedOrigin>" +
    "<AllowedMethod>PUT</AllowedMethod><AllowedMethod>GET</AllowedMethod><AllowedMethod>HEAD</AllowedMethod>" +
    "<AllowedHeader>content-type</AllowedHeader>" +
    "<MaxAgeSeconds>3600</MaxAgeSeconds>" +
    "</CORSRule></CORSConfiguration>";
  await s3(cfg, `${objectUrl(cfg, bucket)}?cors`, {
    method: "PUT",
    body: xml,
    headers: { "Content-Type": "application/xml", "Content-MD5": createHash("md5").update(xml).digest("base64") },
  });
  await run(
    "UPDATE buckets SET cors = 1 WHERE workspace_id = ? OR (user_id = ? AND workspace_id IS NULL)",
    workspaceId,
    workspaceId,
  );
}

// ---------------------------------------------------------------- assets

export const videoKey = (generationId: string) => `videos/${generationId.replace(/[^a-zA-Z0-9_-]/g, "")}.mp4`;

export async function getAsset(workspaceId: string, key: string): Promise<Asset | undefined> {
  const row = await first<AssetRow>(`SELECT * FROM assets WHERE key = ? AND ${byWorkspace()}`, key, ...wsArgs(workspaceId));
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
  workspaceId: string,
  {
    key,
    source,
    contentType,
    generationId = null,
    createdBy = null,
  }: {
    key: string;
    source: Response;
    contentType: string;
    generationId?: string | null;
    createdBy?: string | null;
  },
): Promise<Asset> {
  const cfg = r2();
  const bucket = await ensureBucket(workspaceId);
  const { body, bytes } = await uploadBody(source);
  await s3(cfg, objectUrl(cfg, bucket, key), {
    method: "PUT",
    body,
    // Content-Length comes from the body: a byte array or a FixedLengthStream.
    headers: { "Content-Type": contentType },
  });
  return recordAsset({
    userId: createdBy ?? workspaceId,
    workspaceId,
    createdBy,
    key,
    bucket,
    bytes,
    contentType,
    generationId,
    createdAt: Date.now(),
  });
}

async function recordAsset(asset: Asset): Promise<Asset> {
  const { userId, workspaceId, key, bucket, bytes, contentType, generationId } = asset;
  await run(
    `INSERT INTO assets (user_id, key, bucket, bytes, content_type, generation_id, created_at, name, meta, workspace_id, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, key) DO UPDATE SET
       bucket = excluded.bucket, bytes = excluded.bytes, content_type = excluded.content_type,
       created_at = excluded.created_at, name = excluded.name, meta = excluded.meta,
       workspace_id = excluded.workspace_id, created_by = COALESCE(excluded.created_by, assets.created_by)`,
    userId,
    key,
    bucket,
    bytes,
    contentType,
    generationId,
    asset.createdAt,
    asset.name ?? null,
    asset.meta ? JSON.stringify(asset.meta) : null,
    workspaceId,
    asset.createdBy,
  );
  return asset;
}

export async function deleteAsset(asset: Asset) {
  const cfg = r2();
  if (asset.meta?.thumb) await deleteObject(cfg, asset.bucket, asset.meta.thumb);
  await deleteObject(cfg, asset.bucket, asset.key);
  await run(`DELETE FROM assets WHERE key = ? AND ${byWorkspace()}`, asset.key, ...wsArgs(asset.workspaceId));
}

async function deleteObject(cfg: R2Config, bucket: string, key: string) {
  await s3(cfg, objectUrl(cfg, bucket, key), { method: "DELETE" }).catch((e) => {
    if ((e as { upstreamStatus?: number }).upstreamStatus !== 404) throw e;
  });
}

export async function deleteGenerationAssets(workspaceId: string, generationId: string) {
  const rows = await all<AssetRow>(
    `SELECT * FROM assets WHERE generation_id = ? AND ${byWorkspace()}`,
    generationId,
    ...wsArgs(workspaceId),
  );
  for (const row of rows) await deleteAsset(toAsset(row));
}

/** Deletes every indexed object under a key prefix, including ones with no generation id. */
export async function deleteAssetsUnder(workspaceId: string, prefix: string) {
  const rows = await all<AssetRow>(
    `SELECT * FROM assets WHERE key LIKE ? AND ${byWorkspace()}`,
    `${prefix}%`,
    ...wsArgs(workspaceId),
  );
  for (const row of rows) await deleteAsset(toAsset(row));
}

// ---------------------------------------------------------------- browser uploads

const UPLOAD_URL_TTL_S = 15 * 60;

/** Signed URLs the browser PUTs files to, straight into the user's bucket. */
export async function createUpload(workspaceId: string, keys: string[]) {
  const cfg = r2();
  const bucket = await ensureBucket(workspaceId);
  await ensureCors(workspaceId, bucket);
  return Promise.all(keys.map((key) => presign(cfg, "PUT", bucket, key, UPLOAD_URL_TTL_S)));
}

async function headObject(cfg: R2Config, bucket: string, key: string) {
  const res = await s3(cfg, objectUrl(cfg, bucket, key), { method: "HEAD" }).catch((e) => {
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
export async function completeUpload(
  workspaceId: string,
  key: string,
  { name, meta, createdBy }: { name: string; meta: AssetMeta; createdBy: string },
) {
  const cfg = r2();
  const bucket = await ensureBucket(workspaceId);
  const file = await headObject(cfg, bucket, key);
  if (!file) return undefined;
  const thumb = meta.thumb ? await headObject(cfg, bucket, meta.thumb) : undefined;
  return recordAsset({
    userId: createdBy,
    workspaceId,
    createdBy,
    key,
    bucket,
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
/** The users who created rows of a table in a workspace, by id. */
export async function creatorsIn(
  table: "assets" | "generations" | "image_generations" | "fal_jobs",
  workspaceId: string,
) {
  const rows = await all<Creator>(
    `SELECT id, email, name, avatar_url AS avatarUrl FROM users
     WHERE id IN (SELECT DISTINCT created_by FROM ${table} WHERE ${byWorkspace()})`,
    ...wsArgs(workspaceId),
  );
  return new Map(rows.map((c) => [c.id, c]));
}

export async function listAssets(workspaceId: string): Promise<AssetItem[]> {
  const scope = wsArgs(workspaceId);
  const [rows, videoGens, imageGens, falJobs, creators] = await Promise.all([
    all<AssetRow>(
      `SELECT * FROM assets WHERE ${byWorkspace()} AND (key LIKE 'uploads/%' OR key LIKE 'videos/%' OR key LIKE 'images/%' OR key LIKE 'fal/%')
       ORDER BY created_at DESC LIMIT 2000`,
      ...scope,
    ),
    all<{ id: string; model: string; prompt: string; duration: number }>(
      `SELECT id, json_extract(data, '$.model') AS model, json_extract(data, '$.prompt') AS prompt,
              json_extract(data, '$.duration') AS duration FROM generations WHERE ${byWorkspace()}`,
      ...scope,
    ),
    all<{ id: string; model: string; prompt: string }>(
      `SELECT id, json_extract(data, '$.model') AS model, json_extract(data, '$.prompt') AS prompt
       FROM image_generations WHERE ${byWorkspace()}`,
      ...scope,
    ),
    all<{ id: string; model: string; prompt: string | null }>(
      `SELECT id, json_extract(data, '$.endpointId') AS model, json_extract(data, '$.request.prompt') AS prompt
       FROM fal_jobs WHERE ${byWorkspace()}`,
      ...scope,
    ),
    creatorsIn("assets", workspaceId),
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
      createdAt: a.createdAt,
      createdBy: (a.createdBy && creators.get(a.createdBy)) || undefined,
    };
    if (a.key.startsWith("uploads/")) return [{ ...base, source: "upload", name: a.name ?? a.key.split("/").pop()! }];
    if (a.key.startsWith("fal/")) {
      const job = a.generationId ? fal.get(a.generationId) : undefined;
      if (!job) return [];
      return [
        {
          ...base,
          source: "generated",
          name: job.prompt.slice(0, 120) || "Untitled",
          generation: { id: job.id, tab: "fal", model: job.model, prompt: job.prompt },
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
export async function createThumbUpload(workspaceId: string, asset: Asset) {
  const cfg = r2();
  await ensureCors(workspaceId, asset.bucket);
  return presign(cfg, "PUT", asset.bucket, thumbKeyFor(asset.key), UPLOAD_URL_TTL_S);
}

/** Records a thumbnail the browser uploaded, if it's there and small. */
export async function attachThumb(asset: Asset) {
  const cfg = r2();
  const key = thumbKeyFor(asset.key);
  const thumb = await headObject(cfg, asset.bucket, key);
  if (!thumb) return false;
  if (thumb.bytes > 1024 * 1024 || thumb.contentType !== "image/jpeg") {
    await deleteObject(cfg, asset.bucket, key);
    return false;
  }
  await recordAsset({ ...asset, bytes: asset.bytes + thumb.bytes, meta: { ...asset.meta, thumb: key } });
  return true;
}

export async function renameAsset(workspaceId: string, key: string, name: string) {
  await run(`UPDATE assets SET name = ? WHERE key = ? AND ${byWorkspace()}`, name, key, ...wsArgs(workspaceId));
}

/** Removes an uploaded object that never got indexed (e.g. it failed validation). */
export async function discardUpload(workspaceId: string, key: string) {
  const bucket = await getBucket(workspaceId);
  if (bucket) await deleteObject(r2(), bucket, key);
}

/**
 * Keys stored on this page of users' generations. Other users are irrelevant: an asset
 * row is only protected by a generation with the same user_id.
 */
async function referencedByRows(rows: { user_id: string; workspace_id: string | null }[]) {
  const userIds = candidateUserIds(rows);
  const workspaceIds = [...new Set(rows.map((r) => r.workspace_id).filter((id): id is string => !!id))];
  if (!userIds.length && !workspaceIds.length) return new Set<string>();
  const userMarks = userIds.map(() => "?").join(", ") || "NULL";
  const wsMarks = workspaceIds.map(() => "?").join(", ") || "NULL";
  const where = `(user_id IN (${userMarks}) OR workspace_id IN (${wsMarks}))`;
  const params = [...userIds, ...workspaceIds];
  const [videos, images] = await Promise.all([
    all<{ user_id: string; workspace_id: string | null; data: string }>(
      `SELECT user_id, workspace_id, data FROM generations WHERE ${where}`,
      ...params,
    ),
    all<{ user_id: string; workspace_id: string | null; data: string }>(
      `SELECT user_id, workspace_id, data FROM image_generations WHERE ${where}`,
      ...params,
    ),
  ]);
  return referencedKeySet(
    [...videos, ...images].map((r) => ({ userId: r.user_id, workspaceId: r.workspace_id, data: r.data })),
  );
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
    const referenced = await referencedByRows(rows);
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

export async function storageUsage(workspaceId: string) {
  const row = await first<{ objects: number; bytes: number }>(
    `SELECT COUNT(*) AS objects, COALESCE(SUM(bytes), 0) AS bytes FROM assets WHERE ${byWorkspace()}`,
    ...wsArgs(workspaceId),
  );
  // A team gets the same allowance as a person. Files count only against that workspace.
  const quotaGb = Number(env().STORAGE_QUOTA_GB) || 2;
  return { objects: row?.objects ?? 0, bytes: row?.bytes ?? 0, quotaBytes: Math.round(quotaGb * GB) };
}

/** Thrown before a generation or upload that would go over the workspace's quota. */
export async function assertStorageAvailable(workspaceId: string, extraBytes = 0) {
  const { bytes, quotaBytes } = await storageUsage(workspaceId);
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
  bucket: string,
  key: string,
  ttlSeconds: number,
  query: Record<string, string> = {},
) {
  const url = new URL(objectUrl(cfg, bucket, key));
  url.searchParams.set("X-Amz-Expires", String(ttlSeconds));
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return (await cfg.client.sign(new Request(url, { method }), { aws: { signQuery: true } })).url;
}

/** A link the video provider can download a reference from, without credentials. */
export const providerUrl = (asset: Asset) => presign(r2(), "GET", asset.bucket, asset.key, PROVIDER_URL_TTL_S);

/**
 * Redirects to a short-lived signed URL, so the bytes (and the player's Range
 * requests) go straight from R2 to the browser. R2 doesn't charge for egress.
 */
/** Empties and deletes the workspace's R2 bucket, then drops the index row. No bucket is a no-op. */
export async function deleteBucketContents(workspaceId: string) {
  const name = await getBucket(workspaceId);
  if (!name) return;
  const cfg = r2();
  let token: string | undefined;
  for (;;) {
    const url = new URL(objectUrl(cfg, name));
    url.searchParams.set("list-type", "2");
    if (token) url.searchParams.set("continuation-token", token);
    const res = await s3(cfg, url.toString(), { method: "GET" });
    const xml = await res.text();
    const keys = [...xml.matchAll(/<Key>([^<]*)<\/Key>/g)].map((m) =>
      m[1].replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">"),
    );
    for (const key of keys) await deleteObject(cfg, name, key);
    const next = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1];
    if (!next || !xml.includes("<IsTruncated>true")) break;
    token = next;
  }
  await s3(cfg, objectUrl(cfg, name), { method: "DELETE" }).catch((e) => {
    if ((e as { upstreamStatus?: number }).upstreamStatus !== 404) throw e;
  });
  await run(
    "DELETE FROM buckets WHERE workspace_id = ? OR (user_id = ? AND workspace_id IS NULL)",
    workspaceId,
    workspaceId,
  );
}

export async function serveAsset(asset: Asset, opts: { downloadName?: string; thumb?: boolean } = {}) {
  const query: Record<string, string> = opts.downloadName
    ? { "response-content-disposition": `attachment; filename="${opts.downloadName}"` }
    : {};
  // The thumbnail when asked for and there is one; otherwise the file itself.
  const key = opts.thumb && asset.meta?.thumb ? asset.meta.thumb : asset.key;
  const location = await presign(r2(), "GET", asset.bucket, key, SIGNED_URL_TTL_S, query);
  return new Response(null, {
    status: 302,
    // Cache the redirect for well under the signature's lifetime.
    headers: { Location: location, "Cache-Control": "private, max-age=600" },
  });
}
