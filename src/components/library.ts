// The user's assets on the client: uploads plus generated videos and images. Prepares and
// uploads new files straight to the user's bucket, and makes thumbnails for generated
// assets the first time they're shown.

import { useCallback, useEffect, useRef, useState } from "react";
import { assetFileUrl, UPLOAD_RULES, uploadKindOf, type AssetItem, type UploadKind } from "@/lib/uploads";
import { apiJson, withWorkspace } from "./api";

export interface LibraryItem extends Omit<AssetItem, "key"> {
  /** Stable for the item's life in this tab: the key, or a temporary id for new uploads. */
  id: string;
  /** Set once the server has reserved it. */
  key?: string;
  status: "uploading" | "ready" | "error";
  /** 0–1 while uploading. */
  progress: number;
  error?: string;
  /** Local preview of a thumbnail made in this tab (object URL). */
  localThumb?: string;
  /** Local copy of the file while it uploads (object URL). */
  localFile?: string;
}

/** Small preview image: the thumbnail, or the image itself. */
export function thumbSrc(item: LibraryItem) {
  if (item.localThumb) return item.localThumb;
  if (!item.key) return item.kind === "image" ? item.localFile : undefined;
  if (item.hasThumb) return withWorkspace(assetFileUrl(item.key, { thumb: true }));
  return item.kind === "image" ? withWorkspace(assetFileUrl(item.key)) : undefined;
}

/** The playable file, for audio and video. */
export const fileSrc = (item: LibraryItem) =>
  item.localFile ?? (item.key ? withWorkspace(assetFileUrl(item.key)) : undefined);

// ---------------------------------------------------------------- preparing files

/** All file types the library takes, for <input accept>. */
export const ACCEPT = [
  "image/*",
  ...Object.keys(UPLOAD_RULES.video.types),
  ...Object.keys(UPLOAD_RULES.audio.types),
].join(",");

/** The file's MIME type, falling back to its extension (some systems report none). */
function typeOf(file: File) {
  if (file.type) return file.type;
  const ext = file.name.split(".").pop()?.toLowerCase();
  for (const rule of Object.values(UPLOAD_RULES))
    for (const [type, e] of Object.entries(rule.types)) if (e === ext) return type;
  return "";
}

function mediaDuration(url: string, kind: "video" | "audio"): Promise<number> {
  return new Promise((resolve) => {
    const el = document.createElement(kind);
    el.preload = "metadata";
    el.onloadedmetadata = () => resolve(el.duration);
    // Some browsers can't read MOV/WAV metadata; let the provider judge those.
    el.onerror = () => resolve(NaN);
    el.src = url;
  });
}

const canvasToJpeg = (canvas: HTMLCanvasElement, quality: number) =>
  new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't encode image"))), "image/jpeg", quality),
  );

function drawScaled(source: CanvasImageSource, width: number, height: number, maxSide: number) {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  canvas.getContext("2d")!.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** Providers take JPEG/PNG only, so other images (WebP, GIF, AVIF…) are converted to JPEG. */
async function normalizeImage(file: File, type: string): Promise<File> {
  if (UPLOAD_RULES.image.types[type]) return file;
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error(`Can't read ${file.name}. Use ${UPLOAD_RULES.image.label}.`);
  });
  const blob = await canvasToJpeg(drawScaled(bitmap, bitmap.width, bitmap.height, Infinity), 0.92);
  return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" });
}

const THUMB_SIDE = 480;

async function imageThumb(file: File) {
  const bitmap = await createImageBitmap(file);
  return canvasToJpeg(drawScaled(bitmap, bitmap.width, bitmap.height, THUMB_SIDE), 0.8);
}

function videoThumb(url: string): Promise<Blob | undefined> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    video.onloadeddata = () => (video.currentTime = Math.min(0.1, video.duration / 2 || 0));
    video.onseeked = () =>
      canvasToJpeg(drawScaled(video, video.videoWidth, video.videoHeight, THUMB_SIDE), 0.8).then(resolve, () =>
        resolve(undefined),
      );
    video.onerror = () => resolve(undefined);
    video.src = url;
  });
}

/** Bar heights (0–100) for a waveform preview. */
async function audioPeaks(file: File, bars = 48): Promise<number[] | undefined> {
  const ctx = new AudioContext();
  try {
    const audio = await ctx.decodeAudioData(await file.arrayBuffer());
    const data = audio.getChannelData(0);
    const step = Math.max(1, Math.floor(data.length / bars));
    const peaks = Array.from({ length: bars }, (_, i) => {
      let max = 0;
      for (let j = i * step; j < Math.min(data.length, (i + 1) * step); j++) max = Math.max(max, Math.abs(data[j]));
      return max;
    });
    const top = Math.max(...peaks) || 1;
    return peaks.map((p) => Math.round((p / top) * 100));
  } catch {
    return undefined;
  } finally {
    void ctx.close();
  }
}

interface Prepared {
  file: File;
  kind: UploadKind;
  duration?: number;
  peaks?: number[];
  thumb?: Blob;
}

/** Checks a file against the upload rules and works out its previews. Throws a readable error. */
async function prepare(original: File): Promise<Prepared> {
  let type = typeOf(original);
  const kind = uploadKindOf(type) ?? (type.startsWith("image/") ? "image" : undefined);
  if (!kind)
    throw new Error(
      `${original.name}: unsupported type. Use images (JPEG, PNG), video (MP4, MOV) or audio (MP3, WAV).`,
    );
  const rules = UPLOAD_RULES[kind];
  const file = kind === "image" ? await normalizeImage(original, type) : original;
  type = file.type || type;
  if (file.size > rules.maxBytes) throw new Error(`${original.name} is too large. Use ${rules.label}.`);

  if (kind === "image") return { file, kind, thumb: await imageThumb(file).catch(() => undefined) };

  const url = URL.createObjectURL(file);
  try {
    const duration = await mediaDuration(url, kind);
    if (rules.seconds && Number.isFinite(duration) && (duration < rules.seconds.min || duration > rules.seconds.max))
      throw new Error(`${original.name} is ${duration.toFixed(1)} s long. Use ${rules.label}.`);
    const d = Number.isFinite(duration) ? duration : undefined;
    if (kind === "video") return { file, kind, duration: d, thumb: await videoThumb(url) };
    return { file, kind, duration: d, peaks: await audioPeaks(file) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------------------------------------------------------------- uploading

function put(url: string, body: Blob, onProgress: (f: number) => void, signal: AbortSignal) {
  // XHR rather than fetch: fetch can't report upload progress.
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", body.type);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(`Upload failed (${xhr.status})`)));
    xhr.onerror = () => reject(new Error("Upload failed. Check your connection and try again."));
    xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
    signal.addEventListener("abort", () => xhr.abort());
    xhr.send(body);
  });
}

const fromServer = (u: AssetItem): LibraryItem => ({ ...u, id: u.key, status: "ready", progress: 1 });

/** Draws a small JPEG of a generated image or a video's first frame (needs CORS on the bucket). */
function thumbFromUrl(url: string, kind: "image" | "video"): Promise<Blob | undefined> {
  return new Promise((resolve) => {
    const done = (source: CanvasImageSource, w: number, h: number) =>
      canvasToJpeg(drawScaled(source, w, h, THUMB_SIDE), 0.8).then(resolve, () => resolve(undefined));
    if (kind === "image") {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => done(img, img.naturalWidth, img.naturalHeight);
      img.onerror = () => resolve(undefined);
      img.src = url;
      return;
    }
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.preload = "auto";
    video.onloadeddata = () => (video.currentTime = Math.min(0.1, video.duration / 2 || 0));
    video.onseeked = () => done(video, video.videoWidth, video.videoHeight);
    video.onerror = () => resolve(undefined);
    video.src = url;
  });
}

export interface Library {
  items: LibraryItem[];
  loaded: boolean;
  /** Refetches the list (e.g. after generations finished elsewhere). */
  reload: () => Promise<void>;
  /** Makes and saves a thumbnail for a generated image or video that has none. */
  ensureThumb: (item: LibraryItem) => void;
  removeMany: (ids: string[]) => Promise<void>;
  /** Prepares and starts uploading files. Resolves once they're listed (uploads continue). */
  add: (files: File[]) => Promise<{ items: LibraryItem[]; errors: string[] }>;
  rename: (id: string, name: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

/** Local-only fields worth keeping when the list is refetched. */
const pick = (i?: LibraryItem) => (i?.localThumb ? { localThumb: i.localThumb } : {});

export function useLibrary(): Library {
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const aborts = useRef(new Map<string, AbortController>());
  const objectUrls = useRef(new Set<string>());

  const patch = useCallback(
    (id: string, p: Partial<LibraryItem>) => setItems((v) => v.map((i) => (i.id === id ? { ...i, ...p } : i))),
    [],
  );

  const fetchList = useCallback(
    () =>
      apiJson<AssetItem[]>("/api/assets").then((list) => {
        setItems((local) => {
          // Uploads still in flight in this tab stay on top; finished ones keep their local previews.
          const byKey = new Map(local.filter((i) => i.key).map((i) => [i.key, i]));
          const inFlight = local.filter((i) => i.status !== "ready");
          const keys = new Set(inFlight.map((i) => i.key));
          return [
            ...inFlight,
            ...list.filter((u) => !keys.has(u.key)).map((u) => ({ ...fromServer(u), ...pick(byKey.get(u.key)) })),
          ];
        });
        setLoaded(true);
      }),
    [],
  );
  const reload = useCallback(() => fetchList().catch(() => {}), [fetchList]);

  useEffect(() => {
    fetchList().catch(() => setLoaded(true));
    const urls = objectUrls.current;
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [fetchList]);

  const objectUrl = (blob: Blob) => {
    const url = URL.createObjectURL(blob);
    objectUrls.current.add(url);
    return url;
  };
  const revoke = (url?: string) => {
    if (!url) return;
    URL.revokeObjectURL(url);
    objectUrls.current.delete(url);
  };

  async function upload(id: string, p: Prepared, name: string, localFile: string) {
    const abort = new AbortController();
    aborts.current.set(id, abort);
    try {
      const r = await apiJson<{ key: string; uploadUrl: string; thumbKey?: string; thumbUploadUrl?: string }>(
        "/api/uploads",
        {
          method: "POST",
          body: JSON.stringify({ kind: p.kind, contentType: p.file.type, size: p.file.size, thumb: !!p.thumb }),
        },
      );
      patch(id, { key: r.key });
      if (p.thumb && r.thumbUploadUrl) await put(r.thumbUploadUrl, p.thumb, () => {}, abort.signal);
      await put(r.uploadUrl, p.file, (progress) => patch(id, { progress }), abort.signal);
      if (abort.signal.aborted) return;
      await apiJson("/api/uploads/complete", {
        method: "POST",
        body: JSON.stringify({ key: r.key, name, duration: p.duration, peaks: p.peaks, thumb: !!r.thumbUploadUrl }),
      });
      // The uploaded copy is served from the bucket from now on.
      revoke(localFile);
      patch(id, { status: "ready", progress: 1, localFile: undefined });
    } catch (e) {
      if (!abort.signal.aborted) patch(id, { status: "error", error: (e as Error).message });
    } finally {
      aborts.current.delete(id);
    }
  }

  async function add(files: File[]) {
    const added: LibraryItem[] = [];
    const errors: string[] = [];
    for (const original of files) {
      try {
        const p = await prepare(original);
        const id = crypto.randomUUID();
        const localFile = objectUrl(p.file);
        const item: LibraryItem = {
          id,
          source: "upload",
          kind: p.kind,
          name: original.name,
          contentType: p.file.type,
          bytes: p.file.size,
          duration: p.duration,
          peaks: p.peaks,
          hasThumb: !!p.thumb,
          createdAt: Date.now(),
          status: "uploading",
          progress: 0,
          localFile,
          localThumb: p.thumb && objectUrl(p.thumb),
        };
        setItems((v) => [item, ...v]);
        added.push(item);
        void upload(id, p, original.name, localFile);
      } catch (e) {
        errors.push((e as Error).message);
      }
    }
    return { items: added, errors };
  }

  // Thumbnails for generated assets: two at a time, each tried once per page load.
  const thumbTried = useRef(new Set<string>());
  const thumbQueue = useRef<LibraryItem[]>([]);
  const thumbsRunning = useRef(0);
  function ensureThumb(item: LibraryItem) {
    if (item.source !== "generated" || item.hasThumb || !item.key || thumbTried.current.has(item.key)) return;
    if (item.kind !== "image" && item.kind !== "video") return;
    thumbTried.current.add(item.key);
    thumbQueue.current.push(item);
    pumpThumbs();
  }
  function pumpThumbs() {
    while (thumbsRunning.current < 2 && thumbQueue.current.length) {
      const item = thumbQueue.current.shift()!;
      thumbsRunning.current++;
      void makeThumb(item).finally(() => {
        thumbsRunning.current--;
        pumpThumbs();
      });
    }
  }
  async function makeThumb(item: LibraryItem) {
    const key = item.key!;
    try {
      const r = await apiJson<{ uploadUrl?: string; done?: boolean }>("/api/assets/thumb", {
        method: "POST",
        body: JSON.stringify({ key }),
      });
      if (r.done) return patch(item.id, { hasThumb: true });
      const blob =
        r.uploadUrl && (await thumbFromUrl(withWorkspace(assetFileUrl(key)), item.kind as "image" | "video"));
      if (!blob) return;
      const put = await fetch(r.uploadUrl!, { method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: blob });
      if (!put.ok) return;
      const { ok } = await apiJson<{ ok: boolean }>("/api/assets/thumb", {
        method: "PUT",
        body: JSON.stringify({ key }),
      });
      if (ok) patch(item.id, { hasThumb: true, localThumb: objectUrl(blob) });
    } catch {
      // A missing thumbnail only means the full file is shown instead.
    }
  }

  async function rename(id: string, name: string) {
    const item = items.find((i) => i.id === id);
    const clean = name.trim();
    if (!item?.key || !clean || clean === item.name) return;
    patch(id, { name: clean });
    await apiJson("/api/uploads", { method: "PATCH", body: JSON.stringify({ key: item.key, name: clean }) });
  }

  async function removeMany(ids: string[]) {
    const gone = items.filter((i) => ids.includes(i.id));
    for (const item of gone) {
      aborts.current.get(item.id)?.abort();
      revoke(item.localFile);
      revoke(item.localThumb);
    }
    setItems((v) => v.filter((i) => !ids.includes(i.id)));
    const keys = gone.flatMap((i) => (i.key ? [i.key] : []));
    if (keys.length) await apiJson("/api/assets", { method: "DELETE", body: JSON.stringify({ keys }) });
  }
  const remove = (id: string) => removeMany([id]);

  return { items, loaded, reload, ensureThumb, add, rename, remove, removeMany };
}
