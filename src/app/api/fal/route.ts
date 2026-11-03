import { errorResponse, requireUser } from "@/lib/auth";
import { createFalJob, listFalJobs, publicFalJob } from "@/lib/falJobs";
import { getCredentials, listKeys } from "@/lib/keys";
import { FalValidationError } from "@/lib/providers/fal";
import { availabilityError, availabilityFor } from "@/lib/registry/availability";
import { assertStorageAvailable } from "@/lib/storage";

/** The user's fal jobs, newest first. Does not call fal — the open tab polls each one. */
export async function GET() {
  try {
    const user = await requireUser();
    return Response.json((await listFalJobs(user.id)).map(publicFalJob));
  } catch (e) {
    return errorResponse(e);
  }
}

/** { endpointId, input } — any fal endpoint. `upload:<key>` strings become signed R2 URLs. */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const body = (await request.json()) as { endpointId?: string; input?: unknown };
    const endpointId = body.endpointId?.trim() ?? "";
    if (!endpointId) return Response.json({ error: "Enter an endpoint id" }, { status: 400 });
    if (!body.input || typeof body.input !== "object" || Array.isArray(body.input))
      return Response.json({ error: "Input must be a JSON object" }, { status: 400 });
    const keyed = new Set((await listKeys(user.id)).map((key) => key.provider));
    const gate = availabilityFor(["fal"], keyed);
    if (!gate.available) return Response.json({ error: availabilityError(gate.needs) }, { status: 400 });
    const creds = await getCredentials(user.id, "fal");
    if (!creds) return Response.json({ error: availabilityError(["fal"]) }, { status: 400 });
    await assertStorageAvailable(user.id);
    const job = await createFalJob(user.id, endpointId, body.input, creds.apiKey);
    return Response.json(publicFalJob(job), { status: 201 });
  } catch (e) {
    if (e instanceof FalValidationError)
      return Response.json({ error: e.message, fields: e.fields }, { status: 422 });
    return errorResponse(e);
  }
}
