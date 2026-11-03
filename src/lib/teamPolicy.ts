// Who may see a teammate's work, and which user a generation belongs to.
// Pure: no database, no keys, no storage. The routes call these and nothing else
// decides membership or which key a generation uses.

import { isAssetKey, uploadKindOf, type UploadKind } from "./uploads";

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

export interface TeamGeneration {
  id: string;
  ownerId: string;
  kind: "video" | "image" | "fal";
  prompt: string;
  model: string;
  status: string;
  stored: boolean;
  createdAt: number;
  author: TeamAuthor;
}

export interface TeamAsset {
  ownerId: string;
  key: string;
  kind: UploadKind;
  name: string;
  contentType: string;
  bytes: number;
  createdAt: number;
  hasThumb: boolean;
  author: TeamAuthor;
}

export function cleanTeamName(name: unknown): string {
  if (typeof name !== "string") throw new Error("Name the team");
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 60) throw new Error("Team name must be 1–60 characters");
  return trimmed;
}

/**
 * A generation always uses the signed-in caller's own key and own bucket.
 * A team id, or any other user id, on the request is ignored.
 */
export function personalGenerationScope(
  callerId: string,
  request?: unknown,
): { keyUserId: string; storageUserId: string } {
  void request;
  if (!callerId) throw new Error("Missing caller");
  return { keyUserId: callerId, storageUserId: callerId };
}

/**
 * Read access exists only while both people are current members.
 * A non-member, or a member who was removed, is not in `memberIds`.
 */
export function visibleTeamItems<T extends { ownerId: string }>(
  memberIds: readonly string[],
  viewerId: string,
  items: readonly T[],
): T[] {
  if (!viewerId || !memberIds.includes(viewerId)) return [];
  const members = new Set(memberIds);
  return items.filter((item) => item.ownerId && members.has(item.ownerId));
}

export function canReadTeamItem(memberIds: readonly string[], viewerId: string, ownerId: string): boolean {
  return visibleTeamItems(memberIds, viewerId, [{ ownerId }]).length === 1;
}

export function publicAuthor(author: TeamAuthor): TeamAuthor {
  return { id: author.id, name: author.name, email: author.email };
}

function stringField(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  return typeof value === "string" ? value : "";
}

function promptOf(data: Record<string, unknown>): string {
  const direct = stringField(data, "prompt");
  if (direct) return direct;
  const request = data.request;
  if (!request || typeof request !== "object") return "";
  return stringField(request as Record<string, unknown>, "prompt");
}

/** Fields a teammate may see. Provider URLs and key material on the stored JSON are dropped. */
export function publicTeamGeneration(input: {
  id: string;
  ownerId: string;
  kind: TeamGeneration["kind"];
  createdAt: number;
  data: unknown;
  author: TeamAuthor;
}): TeamGeneration {
  const data = input.data && typeof input.data === "object" ? (input.data as Record<string, unknown>) : {};
  const images = Array.isArray(data.images) ? data.images.length : 0;
  const outputs = Array.isArray(data.outputs) ? data.outputs.length : 0;
  return {
    id: input.id,
    ownerId: input.ownerId,
    kind: input.kind,
    prompt: promptOf(data),
    model: stringField(data, "model") || stringField(data, "endpointId"),
    status: stringField(data, "status"),
    stored: data.stored === true || images > 0 || outputs > 0,
    createdAt: input.createdAt,
    author: publicAuthor(input.author),
  };
}

function assetKind(contentType: string): UploadKind | undefined {
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

/** One asset row for the team view. Anything that isn't a library file is omitted. */
export function publicTeamAsset(input: {
  ownerId: string;
  key: string;
  name: string | null;
  contentType: string;
  bytes: number;
  createdAt: number;
  hasThumb: boolean;
  author: TeamAuthor;
}): TeamAsset | undefined {
  const kind = assetKind(input.contentType);
  if (!kind || !isAssetKey(input.key)) return undefined;
  return {
    ownerId: input.ownerId,
    key: input.key,
    kind,
    name: input.name?.trim() || input.key.split("/").pop() || "Untitled",
    contentType: input.contentType,
    bytes: input.bytes,
    createdAt: input.createdAt,
    hasThumb: input.hasThumb,
    author: publicAuthor(input.author),
  };
}

/** Same-origin media URL. The server checks membership; this carries no signature and no key. */
export function teamMediaUrl(teamId: string, ownerId: string, key: string, thumb = false): string {
  const params = new URLSearchParams({ owner: ownerId, key });
  if (thumb) params.set("thumb", "1");
  return `/api/teams/${encodeURIComponent(teamId)}/media?${params}`;
}

/**
 * Headers for a proxied object. No redirect, no signed URL, and no shared cache:
 * the bytes were authorized for this request only.
 */
export function teamMediaHeaders(upstream: {
  contentType?: string | null;
  contentLength?: string | null;
  contentRange?: string | null;
}): Headers {
  const headers = new Headers();
  headers.set("Content-Type", upstream.contentType || "application/octet-stream");
  headers.set("Cache-Control", "private, no-store");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Accept-Ranges", "bytes");
  if (upstream.contentLength) headers.set("Content-Length", upstream.contentLength);
  if (upstream.contentRange) headers.set("Content-Range", upstream.contentRange);
  return headers;
}
