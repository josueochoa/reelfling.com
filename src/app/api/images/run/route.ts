import { runImageJob } from "@/lib/images";

declare global {
  var __jobTokens: Set<string> | undefined;
}

/**
 * Runs one queued image job. Called in-process by the Worker's queue consumer (worker.ts)
 * with a one-off token that never leaves the isolate, so it can't be called from outside.
 */
export async function POST(request: Request) {
  const token = request.headers.get("x-job-token");
  if (!token || !globalThis.__jobTokens?.has(token)) return new Response("Not found", { status: 404 });
  // Messages sent before workspaces carried userId, which is that user's Personal workspace id.
  const body = (await request.json()) as { workspaceId?: string; userId?: string; id: string };
  await runImageJob((body.workspaceId ?? body.userId)!, body.id);
  return new Response(null, { status: 204 });
}
