import { errorResponse } from "@/lib/auth";
import { createFalJob, listFalJobs, publicFalJob } from "@/lib/falJobs";
import { openGenerationKey, runWithCap } from "@/lib/generationKey";
import { FalValidationError } from "@/lib/providers/fal";
import { catalogModel } from "@/lib/registry/generated";
import { estimateCost } from "@/lib/registry";
import type { KeySource } from "@/lib/scope";
import { assertStorageAvailable } from "@/lib/storage";
import { requireWorkspace } from "@/lib/workspaces";

/** The user's fal jobs, newest first. Does not call fal — the open tab polls each one. */
export async function GET(request: Request) {
  try {
    const { workspace } = await requireWorkspace(request);
    return Response.json((await listFalJobs(workspace.id)).map(publicFalJob));
  } catch (e) {
    return errorResponse(e);
  }
}

/** { endpointId, input } — any fal endpoint. `upload:<key>` strings become signed R2 URLs. */
export async function POST(request: Request) {
  try {
    const { user, workspace } = await requireWorkspace(request);
    const body = (await request.json()) as { endpointId?: string; input?: unknown; keySource?: KeySource };
    const endpointId = body.endpointId?.trim() ?? "";
    if (!endpointId) return Response.json({ error: "Enter an endpoint id" }, { status: 400 });
    if (!body.input || typeof body.input !== "object" || Array.isArray(body.input))
      return Response.json({ error: "Input must be a JSON object" }, { status: 400 });
    await assertStorageAvailable(workspace.id);
    const model = catalogModel(endpointId);
    const estimate = model ? (estimateCost(model, {}) ?? 0) : 0;
    const requested = workspace.kind === "team" && body.keySource === "member" ? "member" : workspace.kind === "team" ? "team" : "member";
    const opened = await openGenerationKey({
      workspace,
      userId: user.id,
      provider: "fal",
      requested,
      estimate,
    });
    const job = await runWithCap(opened, () =>
      createFalJob(workspace.id, endpointId, body.input, opened.creds.apiKey, user.id, {
        keySource: opened.source,
        keyWorkspaceId: opened.keyWorkspaceId,
        estimatedCost: estimate,
        route: "fal",
      }),
    );
    return Response.json(publicFalJob(job), { status: 201 });
  } catch (e) {
    if (e instanceof FalValidationError)
      return Response.json({ error: e.message, fields: e.fields }, { status: 422 });
    return errorResponse(e);
  }
}
