import { failStaleImageJobs } from "@/lib/images";
import { deleteOrphanUploads } from "@/lib/storage";
import { syncGeneration, unfinishedGenerations } from "@/lib/store";

const BATCH = 25;
const CONCURRENCY = 5;
// Provider video URLs expire after about a day; past that there's nothing left to fetch.
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
// Reference uploads that never made it into a generation.
const ORPHAN_UPLOAD_AGE_MS = 24 * 60 * 60 * 1000;

declare global {
  var __sweepTokens: Set<string> | undefined;
}

/**
 * Called every minute by the Worker's cron handler (worker.ts), in-process. Finishes
 * generations nobody is watching: syncs their status and copies finished videos to R2.
 * Also deletes reference uploads that were never used.
 * The one-off token is only known inside this isolate, so the route can't be called from outside.
 */
export async function POST(request: Request) {
  const token = request.headers.get("x-sweep-token");
  if (!token || !globalThis.__sweepTokens?.has(token)) return new Response("Not found", { status: 404 });

  const pending = await unfinishedGenerations(BATCH, MAX_AGE_MS);
  let failed = 0;
  for (let i = 0; i < pending.length; i += CONCURRENCY) {
    await Promise.all(
      pending.slice(i, i + CONCURRENCY).map((g) =>
        syncGeneration(g.workspace_id, g.id).catch((e) => {
          failed++;
          console.error(`[sweep ${g.id}]`, e);
        }),
      ),
    );
  }
  const orphansDeleted = await deleteOrphanUploads("refs/", ORPHAN_UPLOAD_AGE_MS).catch((e) => {
    console.error("[sweep orphans]", e);
    return 0;
  });
  const staleImageJobs = await failStaleImageJobs().catch((e) => {
    console.error("[sweep image jobs]", e);
    return 0;
  });
  return Response.json({ checked: pending.length, failed, orphansDeleted, staleImageJobs });
}
