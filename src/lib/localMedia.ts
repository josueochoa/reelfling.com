// Disk copies of dev fixture media. Only called for bucket "local" in development.
// Paths stay under data/dev-media/<user id>/. Keys are the same shape as R2 keys.

import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { isAssetKey } from "./uploads";

const ROOT = path.join(process.cwd(), "data", "dev-media");

function safeKey(key: string): boolean {
  if (key.includes("..") || path.isAbsolute(key)) return false;
  return isAssetKey(key) || /^[\w./-]+\.thumb\.jpe?g$/.test(key);
}

/** Absolute path for one object. Throws when the key could leave the dev folder. */
export function localMediaPath(userId: string, key: string): string {
  if (!/^[\w-]+$/.test(userId) || !safeKey(key)) throw new Error("Not a dev media key");
  const root = path.resolve(ROOT, userId);
  const full = path.resolve(root, key);
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error("Not a dev media key");
  return full;
}

export async function writeLocal(userId: string, key: string, bytes: Uint8Array): Promise<void> {
  const full = localMediaPath(userId, key);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, bytes);
}

export async function removeLocal(userId: string, key: string): Promise<void> {
  await rm(localMediaPath(userId, key), { force: true });
}

export interface LocalFile {
  status: number;
  body: ReadableStream<Uint8Array> | null;
  contentLength: string;
  contentRange?: string;
  size: number;
}

/** Reads a fixture, honoring a single `bytes=` range so the player can seek. */
export async function readLocal(userId: string, key: string, range: string | null): Promise<LocalFile> {
  const full = localMediaPath(userId, key);
  let size: number;
  try {
    size = (await stat(full)).size;
  } catch {
    return { status: 404, body: null, contentLength: "0", size: 0 };
  }
  let start = 0;
  let end = size - 1;
  let status = 200;
  const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (match && size > 0) {
    if (match[1] === "") {
      const suffix = Number(match[2]);
      start = Number.isFinite(suffix) ? Math.max(0, size - suffix) : 0;
    } else {
      start = Number(match[1]);
      end = match[2] ? Number(match[2]) : size - 1;
    }
    if (!Number.isFinite(start) || start < 0 || start >= size) {
      return { status: 416, body: null, contentLength: "0", size };
    }
    end = Math.min(end, size - 1);
    status = 206;
  }
  const length = Math.max(0, end - start + 1);
  const node = createReadStream(full, { start, end });
  const body = Readable.toWeb(node) as ReadableStream<Uint8Array>;
  return {
    status,
    body,
    contentLength: String(length),
    size,
    ...(status === 206 ? { contentRange: `bytes ${start}-${end}/${size}` } : {}),
  };
}

export async function readFixture(name: string): Promise<Uint8Array> {
  if (!/^[\w.-]+$/.test(name)) throw new Error("Not a fixture");
  return readFile(path.join(process.cwd(), "dev-fixtures", name));
}
