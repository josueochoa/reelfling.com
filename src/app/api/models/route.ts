import { errorResponse, requireUser } from "@/lib/auth";
import { openRouterPickerModels, toolMenu } from "@/lib/registry/generated";

/** Slim OpenRouter video models and tool providers. The catalog JSON stays on the server. */
export async function GET() {
  try {
    await requireUser();
    return Response.json({ models: openRouterPickerModels(), tools: toolMenu() });
  } catch (e) {
    return errorResponse(e);
  }
}
