import { errorResponse, requireUser } from "@/lib/auth";
import { createFalJob, createToolJob, listFalJobs, publicFalJob, type FalJob } from "@/lib/falJobs";
import { getCredentials } from "@/lib/keys";
import { FalValidationError } from "@/lib/providers/fal";
import { availabilityError } from "@/lib/registry/availability";
import { assertStorageAvailable } from "@/lib/storage";
import { teammateFalJob } from "@/lib/teamPolicy";
import { newestFirst, teammateRows } from "@/lib/teammates";

/** The user's fal jobs and their teammates', newest first. Does not call fal — the open tab polls its own. */
export async function GET() {
  try {
    const user = await requireUser();
    const [own, shared] = await Promise.all([listFalJobs(user.id), teammateRows<FalJob>(user.id, "fal_jobs")]);
    return Response.json(
      newestFirst(
        own.map(publicFalJob),
        shared.map((row) => teammateFalJob(publicFalJob(row.data), row.owner)),
      ),
    );
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * `{ endpointId, input }` runs any fal endpoint.
 * `{ toolId, assetIds, params }` runs a catalog tool. The endpoint stays on the server.
 * `upload:<key>` strings become signed R2 URLs.
 */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const body = (await request.json()) as {
      endpointId?: string;
      input?: unknown;
      toolId?: string;
      assetIds?: unknown;
      params?: unknown;
      audioId?: unknown;
    };
    const creds = await getCredentials(user.id, "fal");
    if (!creds) return Response.json({ error: availabilityError(["fal"]) }, { status: 400 });
    await assertStorageAvailable(user.id);
    if (body.toolId?.trim()) {
      const job = await createToolJob(
        user.id,
        { toolId: body.toolId.trim(), assetIds: body.assetIds, params: body.params, audioId: body.audioId },
        creds.apiKey,
      );
      return Response.json(publicFalJob(job), { status: 201 });
    }
    const endpointId = body.endpointId?.trim() ?? "";
    if (!endpointId) return Response.json({ error: "Enter an endpoint id" }, { status: 400 });
    if (!body.input || typeof body.input !== "object" || Array.isArray(body.input))
      return Response.json({ error: "Input must be a JSON object" }, { status: 400 });
    const job = await createFalJob(user.id, endpointId, body.input, creds.apiKey);
    return Response.json(publicFalJob(job), { status: 201 });
  } catch (e) {
    if (e instanceof FalValidationError)
      return Response.json({ error: e.message, fields: e.fields }, { status: 422 });
    return errorResponse(e);
  }
}
