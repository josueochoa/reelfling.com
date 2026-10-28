import { createReadStream, promises as fs } from "node:fs";
import { Readable } from "node:stream";
import { ensureLocalVideo, getGeneration, videoPath } from "@/lib/store";

/** Streams the locally cached MP4, with Range support so the player can seek. */
export async function GET(request: Request, ctx: RouteContext<"/api/generations/[id]/video">) {
  const { id } = await ctx.params;
  const gen = await getGeneration(id);
  if (!gen) return new Response("Not found", { status: 404 });

  const file = videoPath(id);
  let stat = await fs.stat(file).catch(() => null);
  if (!stat && gen.status === "succeeded") {
    // Not cached yet — download it now (shared with any in-flight poll).
    await ensureLocalVideo(gen).catch(() => {});
    stat = await fs.stat(file).catch(() => null);
  }
  if (!stat) return new Response("Video not ready", { status: 404 });

  const download = new URL(request.url).searchParams.has("download");
  const headers: Record<string, string> = {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=31536000, immutable",
    ...(download && { "Content-Disposition": `attachment; filename="seedance-${id.slice(0, 8)}.mp4"` }),
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
      headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${stat.size}`, "Content-Length": String(end - start + 1) },
    });
  }

  const stream = Readable.toWeb(createReadStream(file)) as ReadableStream;
  return new Response(stream, { headers: { ...headers, "Content-Length": String(stat.size) } });
}
