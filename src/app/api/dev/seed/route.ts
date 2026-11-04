// Development fixture data so the viewer can open a video and an image without R2.
// Returns 404 outside `next dev`. Placeholder keys are stored encrypted and are
// never written to the response.

import { errorResponse, requireUser } from "@/lib/auth";
import { run } from "@/lib/db";
import { LOCAL_BUCKET } from "@/lib/localBucket";
import { readFixture, writeLocal } from "@/lib/localMedia";
import { saveKey } from "@/lib/keys";
import { createTeam, listTeams } from "@/lib/teams";

const FAL_PLACEHOLDER = "dev-placeholder-not-a-real-key-0002";
const ARGO_PLACEHOLDER = "dev-placeholder-not-a-real-key-0001";

async function putFile(userId: string, key: string, fixture: string) {
  const bytes = await readFixture(fixture);
  await writeLocal(userId, key, bytes);
  return bytes.byteLength;
}

async function putAsset(
  userId: string,
  key: string,
  bytes: number,
  contentType: string,
  generationId: string | null,
  name: string,
  createdAt: number,
) {
  await run(
    `INSERT INTO assets (user_id, key, bucket, bytes, content_type, generation_id, created_at, name, meta, parent_id, tool)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
     ON CONFLICT(user_id, key) DO UPDATE SET
       bucket = excluded.bucket, bytes = excluded.bytes, content_type = excluded.content_type,
       generation_id = excluded.generation_id, name = excluded.name, created_at = excluded.created_at`,
    userId,
    key,
    LOCAL_BUCKET,
    bytes,
    contentType,
    generationId,
    createdAt,
    name,
  );
}

export async function POST() {
  if (process.env.NODE_ENV !== "development") return new Response("Not found", { status: 404 });
  try {
    const user = await requireUser();
    const now = Date.now();
    const stillKey = "uploads/dev-still.png";
    const imageKey = "images/dev-image-harbor.png";
    const videoKey = "videos/dev-video-harbor.mp4";
    const spareKey = "videos/dev-video-spare.mp4";
    const stillBytes = await putFile(user.id, stillKey, "still.png");
    const imageBytes = await putFile(user.id, imageKey, "still.png");
    const videoBytes = await putFile(user.id, videoKey, "clip.mp4");
    const spareBytes = await putFile(user.id, spareKey, "clip.mp4");

    const videoId = "dev-video-harbor";
    const spareId = "dev-video-spare";
    const imageId = "dev-image-harbor";
    const prompt = "A quiet harbor at dusk.\nThe water is still.\nA small light moves along the pier.\nNo one is on the dock.\nThe sky stays dark.";
    const imagePrompt = "A quiet harbor at dusk, @Image 1 on the water";

    const video = {
      id: videoId,
      provider: "argolink",
      taskId: "dev-seed-harbor",
      status: "succeeded",
      model: "seedance-2.5",
      prompt,
      mode: "frames",
      ratio: "16:9",
      resolution: "720p",
      duration: 4,
      generateAudio: false,
      seed: 7,
      inputs: {
        firstFrame: true,
        lastFrame: false,
        images: 0,
        videos: 0,
        audios: 0,
        firstFrameKey: stillKey,
        firstFrameName: "Harbor still",
      },
      stored: true,
      lastFrameUrl: `/api/assets/file?key=${encodeURIComponent(stillKey)}`,
      createdAt: now - 120_000,
      updatedAt: now - 60_000,
      completedAt: now - 60_000,
      // Present only on this fixture so the inspector can show it. The type is unchanged.
      route: "argolink",
    };
    const spare = {
      ...video,
      id: spareId,
      taskId: "dev-seed-spare",
      prompt: "A spare clip",
      seed: undefined,
      lastFrameUrl: undefined,
      route: undefined,
      inputs: { firstFrame: false, lastFrame: false, images: 0, videos: 0, audios: 0 },
      createdAt: now - 30_000,
    };
    const image = {
      id: imageId,
      provider: "argolink",
      model: "nano-banana-2.1",
      prompt: imagePrompt,
      status: "succeeded",
      ratio: "16:9",
      aspect: "16:9",
      resolution: "2k",
      count: 1,
      references: [stillKey],
      images: [{ key: imageKey, contentType: "image/png" }],
      cost: 0.04,
      createdAt: now - 90_000,
      updatedAt: now - 90_000,
      completedAt: now - 90_000,
    };

    await run(
      `INSERT INTO generations (id, user_id, created_at, data) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET data = excluded.data, created_at = excluded.created_at`,
      videoId,
      user.id,
      video.createdAt,
      JSON.stringify(video),
    );
    await run(
      `INSERT INTO generations (id, user_id, created_at, data) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET data = excluded.data, created_at = excluded.created_at`,
      spareId,
      user.id,
      spare.createdAt,
      JSON.stringify(spare),
    );
    await run(
      `INSERT INTO image_generations (id, user_id, created_at, data) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET data = excluded.data, created_at = excluded.created_at`,
      imageId,
      user.id,
      image.createdAt,
      JSON.stringify(image),
    );

    await putAsset(user.id, stillKey, stillBytes, "image/png", null, "Harbor still", now - 180_000);
    await putAsset(user.id, imageKey, imageBytes, "image/png", imageId, "Harbor", now - 90_000);
    await putAsset(user.id, videoKey, videoBytes, "video/mp4", videoId, "Harbor clip", now - 60_000);
    await putAsset(user.id, spareKey, spareBytes, "video/mp4", spareId, "Spare clip", now - 30_000);

    await saveKey(user.id, "fal", FAL_PLACEHOLDER);
    await saveKey(user.id, "argolink", ARGO_PLACEHOLDER);

    const existing = (await listTeams(user.id)).find((team) => team.name === "Studio");
    const team = existing ?? (await createTeam(user.id, "Studio"));

    return Response.json({ ok: true, videoId, imageId, teamId: team.id });
  } catch (e) {
    return errorResponse(e);
  }
}
