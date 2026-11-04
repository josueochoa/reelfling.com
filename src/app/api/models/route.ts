import { errorResponse, requireUser } from "@/lib/auth";
import { catalogPickerModels, toolMenu } from "@/lib/registry/generated";

/** Slim OpenRouter video models and tool providers for the picker. The catalog JSON stays on the server. */
export async function GET() {
  try {
    await requireUser();
    return Response.json({ models: catalogPickerModels(), tools: toolMenu() });
  } catch (e) {
    return errorResponse(e);
  }
}
