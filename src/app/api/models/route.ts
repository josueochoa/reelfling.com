import { errorResponse, requireUser } from "@/lib/auth";
import { catalogImageModels, catalogPickerModels, toolMenu } from "@/lib/registry/generated";

/** Slim video and image models, plus tool providers, for the pickers. The catalog JSON stays on the server. */
export async function GET() {
  try {
    await requireUser();
    return Response.json({ models: catalogPickerModels(), images: catalogImageModels(), tools: toolMenu() });
  } catch (e) {
    return errorResponse(e);
  }
}
