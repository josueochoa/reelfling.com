import { errorResponse, requireUser } from "@/lib/auth";
import { openRouterPickerModels } from "@/lib/registry/generated";

/** Slim OpenRouter video models for the picker. The catalog JSON stays on the server. */
export async function GET() {
  try {
    await requireUser();
    return Response.json({ models: openRouterPickerModels() });
  } catch (e) {
    return errorResponse(e);
  }
}
