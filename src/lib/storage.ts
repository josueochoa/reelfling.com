// Assets in Cloudflare R2, over its S3 API (presigned URLs need it). Every workspace's files
// live in one bucket (R2_BUCKET) under "<workspace id>/". Files from before that are still
// in their workspace's old bucket until scripts/migrate-r2-buckets.mjs moves them; each
// asset row says which bucket it's in. The `assets` table indexes every stored object;
// usage and quotas are summed from it.

import { AwsClient } from "aws4fetch";
import { effectivePlanSql, PlanRequiredError } from "./billing";
import { all, env, first, run } from "./db";
import { GB, planOf } from "./plans";
import { thumbKeyFor, uploadKindOf, type AssetItem, type Creator } from "./uploads";
import type { Workspace } from "./workspaces";

export interface Asset {
  workspaceId: string;
  key: string;
  bucket: string;
  bytes: number;
  contentType: string;
  generationId: string | null;
  createdAt: number;
  /** Library uploads: display name. */
  name?: string | null;
  meta?: AssetMeta | null;
  /** User who added it (uploaded, or ran the generation). */
  createdBy?: string | null;
}

/** Library details, stored as JSON. */
export interface AssetMeta {
  duration?: number;
  peaks?: number[];
  /** Key of a small JPEG preview, for images and videos. */
  thumb?: string;
}

interface AssetRow {
  workspace_id: string;
  key: string;
  bucket: string;
  bytes: number;
  content_type: string;
  generation_id: string | null;
  created_at: number;
  name: string | null;
  meta: string | null;
  created_by: string | null;
}

const toAsset = (r: AssetRow): Asset => ({
  workspaceId: r.workspace_id,
  key: r.key,
  bucket: r.bucket,
  bytes: r.bytes,
  contentType: r.content_type,
  generationId: r.generation_id,
  createdAt: r.created_at,
  name: r.name,
  meta: r.meta ? (JSON.parse(r.meta) as AssetMeta) : null,
  createdBy: r.created_by,
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
  /** The shared bucket. */
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

/** A new object: the shared bucket, under the workspace's folder. */
const newLocation = (cfg: R2Config, workspaceId: string, key: string): Location => ({
  bucket: cfg.bucket,
  path: `${workspaceId}/${key}`,
});

/**
 * Where an asset's file (or its thumbnail, `key`) is. Assets still in a workspace's old
 * bucket (from before the shared one) are at their bare key there.
 */
const locate = (cfg: R2Config, asset: Asset, key = asset.key): Location =>
  asset.bucket === cfg.bucket ? newLocation(cfg, asset.workspaceId, key) : { bucket: asset.bucket, path: key };

const urlOf = (cfg: R2Config, loc: Location) => objectUrl(cfg, loc.bucket, loc.path);

// ---------------------------------------------------------------- assets

export const videoKey = (generationId: string) => `videos/${generationId.replace(/[^a-zA-Z0-9_-]/g, "")}.mp4`;

export async function getAsset(workspaceId: string, key: string): Promise<Asset | undefined> {
  const row = await first<AssetRow>("SELECT * FROM assets WHERE workspace_id = ? AND key = ?", workspaceId, key);
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
  const { body, bytes } = await uploadBody(source);
  await s3(cfg, urlOf(cfg, newLocation(cfg, workspaceId, key)), {
    method: "PUT",
    body,
    // Content-Length comes from the body: a byte array or a FixedLengthStream.
    headers: { "Content-Type": contentType },
  });
  return recordAsset({
    workspaceId,
    key,
    bucket: cfg.bucket,
    bytes,
    contentType,
    generationId,
    createdBy,
    createdAt: Date.now(),
  });
}

async function recordAsset(asset: Asset): Promise<Asset> {
  const { workspaceId, key, bucket, bytes, contentType, generationId } = asset;
  await run(
    `INSERT INTO assets (workspace_id, key, bucket, bytes, content_type, generation_id, created_at, name, meta, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (workspace_id, key) DO UPDATE SET
       bucket = excluded.bucket, bytes = excluded.bytes, content_type = excluded.content_type,
       created_at = excluded.created_at, name = excluded.name, meta = excluded.meta`,
    workspaceId,
    key,
    bucket,
    bytes,
    contentType,
    generationId,
    asset.createdAt,
    asset.name ?? null,
    asset.meta ? JSON.stringify(asset.meta) : null,
    asset.createdBy ?? null,
  );
  return asset;
}

export async function deleteAsset(asset: Asset) {
  const cfg = r2();
  if (asset.meta?.thumb) await deleteObject(cfg, locate(cfg, asset, asset.meta.thumb));
  await deleteObject(cfg, locate(cfg, asset));
  await run("DELETE FROM assets WHERE workspace_id = ? AND key = ?", asset.workspaceId, asset.key);
}

async function deleteObject(cfg: R2Config, loc: Location) {
  await s3(cfg, urlOf(cfg, loc), { method: "DELETE" }).catch((e) => {
    if ((e as { upstreamStatus?: number }).upstreamStatus !== 404) throw e;
  });
}

export async function deleteGenerationAssets(workspaceId: string, generationId: string) {
  const rows = await all<AssetRow>(
    "SELECT * FROM assets WHERE workspace_id = ? AND generation_id = ?",
    workspaceId,
    generationId,
  );
  for (const row of rows) await deleteAsset(toAsset(row));
}

// ---------------------------------------------------------------- browser uploads

const UPLOAD_URL_TTL_S = 15 * 60;

/**
 * Signed URLs the browser PUTs files to, straight into the bucket. The bucket's CORS rule
 * (r2-cors.json, set once at setup) lets browsers do that.
 */
export async function createUpload(workspaceId: string, keys: string[]) {
  const cfg = r2();
  return Promise.all(keys.map((key) => presign(cfg, "PUT", newLocation(cfg, workspaceId, key), UPLOAD_URL_TTL_S)));
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
export async function completeUpload(
  workspaceId: string,
  key: string,
  { name, meta, createdBy }: { name: string; meta: AssetMeta; createdBy: string },
) {
  const cfg = r2();
  const file = await headObject(cfg, newLocation(cfg, workspaceId, key));
  if (!file) return undefined;
  const thumb = meta.thumb ? await headObject(cfg, newLocation(cfg, workspaceId, meta.thumb)) : undefined;
  return recordAsset({
    workspaceId,
    key,
    bucket: cfg.bucket,
    // The thumbnail counts toward the quota too.
    bytes: file.bytes + (thumb?.bytes ?? 0),
    contentType: file.contentType,
    generationId: null,
    createdAt: Date.now(),
    name,
    meta: { ...meta, thumb: thumb ? meta.thumb : undefined },
    createdBy,
  });
}

/**
 * Every asset the user would want to see, newest first: uploads, generated videos and
 * generated images, with the prompt and model of the generation that made them.
 */
/** The users who created rows of a table in a workspace, by id. */
export async function creatorsIn(table: "assets" | "generations" | "image_generations", workspaceId: string) {
  const rows = await all<Creator>(
    `SELECT id, email, name, avatar_url AS avatarUrl FROM users
     WHERE id IN (SELECT DISTINCT created_by FROM ${table} WHERE workspace_id = ?)`,
    workspaceId,
  );
  return new Map(rows.map((c) => [c.id, c]));
}

export async function listAssets(workspaceId: string): Promise<AssetItem[]> {
  const [rows, videoGens, imageGens, creators] = await Promise.all([
    all<AssetRow>(
      `SELECT * FROM assets WHERE workspace_id = ? AND (key LIKE 'uploads/%' OR key LIKE 'videos/%' OR key LIKE 'images/%')
       ORDER BY created_at DESC LIMIT 2000`,
      workspaceId,
    ),
    all<{ id: string; model: string; prompt: string; duration: number }>(
      `SELECT id, json_extract(data, '$.model') AS model, json_extract(data, '$.prompt') AS prompt,
              json_extract(data, '$.duration') AS duration FROM generations WHERE workspace_id = ?`,
      workspaceId,
    ),
    all<{ id: string; model: string; prompt: string }>(
      `SELECT id, json_extract(data, '$.model') AS model, json_extract(data, '$.prompt') AS prompt
       FROM image_generations WHERE workspace_id = ?`,
      workspaceId,
    ),
    creatorsIn("assets", workspaceId),
  ]);
  const videos = new Map(videoGens.map((g) => [g.id, g]));
  const images = new Map(imageGens.map((g) => [g.id, g]));

  return rows.flatMap((row): AssetItem[] => {
    const a = toAsset(row);
    const kind = uploadKindOf(a.contentType) ?? (a.contentType.startsWith("image/") ? "image" : undefined);
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

export async function renameAsset(workspaceId: string, key: string, name: string) {
  await run("UPDATE assets SET name = ? WHERE workspace_id = ? AND key = ?", name, workspaceId, key);
}

/** Removes an uploaded object that never got indexed (e.g. it failed validation). */
export async function discardUpload(workspaceId: string, key: string) {
  const cfg = r2();
  await deleteObject(cfg, newLocation(cfg, workspaceId, key));
}

/**
 * Pre-library reference uploads (`refs/`) that never made it into a generation. Library
 * uploads (`uploads/`) are kept until the user deletes them.
 */
export async function deleteOrphanUploads(prefix: string, olderThanMs: number) {
  const rows = await all<AssetRow>(
    "SELECT * FROM assets WHERE generation_id IS NULL AND key LIKE ? AND created_at < ? LIMIT 50",
    `${prefix}%`,
    Date.now() - olderThanMs,
  );
  for (const row of rows) await deleteAsset(toAsset(row));
  return rows.length;
}

// ---------------------------------------------------------------- usage & quota

/**
 * Files that count against a person: the ones they made in workspaces they're still in,
 * plus, in workspaces they own, files nobody there owns any more (made by someone who left).
 * ?1 is the user id; `a` is assets.
 */
const COUNTS_AGAINST = `
  (a.created_by = ?1 AND EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = a.workspace_id AND m.user_id = ?1))
  OR (a.workspace_id IN (SELECT id FROM workspaces WHERE owner_id = ?1)
      AND (a.created_by IS NULL OR NOT EXISTS (
        SELECT 1 FROM workspace_members m WHERE m.workspace_id = a.workspace_id AND m.user_id = a.created_by)))`;

export interface StorageUsage {
  objects: number;
  bytes: number;
  quotaBytes: number;
}

/** A person's storage: everything that counts against them, across workspaces, and their plan's allowance. */
export async function storageUsage(userId: string): Promise<StorageUsage> {
  const [row, user] = await Promise.all([
    first<{ objects: number; bytes: number }>(
      `SELECT COUNT(*) AS objects, COALESCE(SUM(a.bytes), 0) AS bytes FROM assets a WHERE ${COUNTS_AGAINST}`,
      userId,
    ),
    first<{ plan: string }>(`SELECT ${effectivePlanSql("u")} AS plan FROM users u WHERE u.id = ?`, userId),
  ]);
  return {
    objects: row?.objects ?? 0,
    bytes: row?.bytes ?? 0,
    quotaBytes: planOf(user?.plan).storageGb * GB,
  };
}

/** A team's files, and its room: every member brings their own plan's storage. */
export async function teamStorage(workspaceId: string) {
  const [row, members] = await Promise.all([
    first<{ objects: number; bytes: number }>(
      "SELECT COUNT(*) AS objects, COALESCE(SUM(bytes), 0) AS bytes FROM assets WHERE workspace_id = ?",
      workspaceId,
    ),
    all<{ plan: string }>(
      `SELECT ${effectivePlanSql("u")} AS plan FROM workspace_members m JOIN users u ON u.id = m.user_id
       WHERE m.workspace_id = ?`,
      workspaceId,
    ),
  ]);
  return {
    objects: row?.objects ?? 0,
    bytes: row?.bytes ?? 0,
    capacityBytes: members.reduce((sum, m) => sum + planOf(m.plan).storageGb * GB, 0),
  };
}

const full = (u: StorageUsage, extraBytes: number) => u.bytes + extraBytes > u.quotaBytes || u.bytes >= u.quotaBytes;

/**
 * Before a generation or upload by `userId` in `workspace`: the team must be active (its
 * owner on a plan with Teams), and the new file must fit in the person's own storage.
 */
export async function assertStorageAvailable(userId: string, workspace: Workspace, extraBytes = 0) {
  if (workspace.paused)
    throw new PlanRequiredError(
      "This team is paused: its owner's plan doesn't include Teams. You can still view and download its files.",
    );
  const usage = await storageUsage(userId);
  if (full(usage, extraBytes)) {
    const gb = +(usage.quotaBytes / GB).toFixed(1);
    throw new PlanRequiredError(
      `Your storage is full (${gb} GB, across all your workspaces). Delete something or upgrade your plan.`,
    );
  }
}

/** After an upload landed: is the person now over? (A signed URL can't limit the size.) */
export async function isOverQuota(userId: string) {
  const usage = await storageUsage(userId);
  return usage.bytes > usage.quotaBytes;
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
export function providerUrl(asset: Asset) {
  const cfg = r2();
  return presign(cfg, "GET", locate(cfg, asset), PROVIDER_URL_TTL_S);
}

/**
 * Redirects to a short-lived signed URL, so the bytes (and the player's Range
 * requests) go straight from R2 to the browser. R2 doesn't charge for egress.
 */
export async function serveAsset(asset: Asset, opts: { downloadName?: string; thumb?: boolean } = {}) {
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
