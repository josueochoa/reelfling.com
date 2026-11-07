// What a teammate may see of someone's work. Pure: no database, no keys, no storage.

import type { FalJobView } from "./falTypes";
import type { ImageGeneration } from "./images";
import type { Generation } from "./types";
import { uploadKindOf, type AssetItem, type UploadKind } from "./uploads";

export type TeamRole = "owner" | "member";

export interface TeamAuthor {
  id: string;
  name: string | null;
  email: string;
}

export interface TeamSummary {
  id: string;
  name: string;
  role: TeamRole;
  createdAt: number;
}

export interface TeamMember {
  id: string;
  name: string | null;
  email: string;
  role: TeamRole;
  joinedAt: number;
}

export function cleanTeamName(name: unknown): string {
  if (typeof name !== "string") throw new Error("Name the team");
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 60) throw new Error("Team name must be 1–60 characters");
  return trimmed;
}

export function publicAuthor(author: TeamAuthor): TeamAuthor {
  return { id: author.id, name: author.name, email: author.email };
}

/** A teammate's video generation. The provider task id and its URLs stay with the owner. */
export function teammateGeneration(gen: Generation, owner: TeamAuthor): Generation {
  const view: Generation = { ...gen, taskId: "", owner: publicAuthor(owner) };
  delete view.remoteVideoUrl;
  delete view.falStatusUrl;
  delete view.falResponseUrl;
  delete view.falCancelUrl;
  return view;
}

export function teammateImage(gen: ImageGeneration, owner: TeamAuthor): ImageGeneration {
  return { ...gen, owner: publicAuthor(owner) };
}

/** Takes the public view, which already has no fal URLs or raw request. */
export function teammateFalJob(job: FalJobView, owner: TeamAuthor): FalJobView {
  return { ...job, owner: publicAuthor(owner) };
}

export function teammateAsset(item: AssetItem, owner: TeamAuthor): AssetItem {
  return { ...item, owner: publicAuthor(owner) };
}

export function assetKind(contentType: string): UploadKind | undefined {
  return (
    uploadKindOf(contentType) ??
    (contentType.startsWith("image/")
      ? "image"
      : contentType.startsWith("video/")
        ? "video"
        : contentType.startsWith("audio/")
          ? "audio"
          : undefined)
  );
}

/** image/*, video/*, or audio/* with no parameters. Anything else is not served to a teammate. */
export function teamMediaContentType(contentType: string | null | undefined): string | undefined {
  if (!contentType) return undefined;
  const mime = contentType.split(";")[0].trim().toLowerCase();
  if (!assetKind(mime) || !/^(image|video|audio)\/[\w.+-]+$/.test(mime)) return undefined;
  return mime;
}

/**
 * Headers for a teammate's file. No redirect, no signed URL, and no shared cache:
 * the bytes were authorized for this request only.
 */
export function teamMediaHeaders(upstream: {
  contentType?: string | null;
  contentLength?: string | null;
  contentRange?: string | null;
  downloadName?: string;
}): Headers {
  const headers = new Headers();
  headers.set("Content-Type", upstream.contentType || "application/octet-stream");
  headers.set("Cache-Control", "private, no-store");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  // A teammate's file is rendered on this origin. Sandbox it if a browser treats the response as a document.
  headers.set("Content-Security-Policy", "sandbox");
  headers.set("Accept-Ranges", "bytes");
  if (upstream.contentLength) headers.set("Content-Length", upstream.contentLength);
  if (upstream.contentRange) headers.set("Content-Range", upstream.contentRange);
  if (upstream.downloadName)
    headers.set("Content-Disposition", `attachment; filename="${upstream.downloadName.replace(/["\\\r\n]/g, "_")}"`);
  return headers;
}
