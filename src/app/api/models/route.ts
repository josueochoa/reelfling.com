import { errorResponse, requireUser } from "@/lib/auth";
import { catalogPickerModels } from "@/lib/registry/generated";
import { publicTools } from "@/lib/toolCatalog";

/** Slim picker models and tools. The catalog JSON stays on the server. */
export async function GET() {
  try {
    await requireUser();
    return Response.json({ models: catalogPickerModels(), tools: publicTools() });
  } catch (e) {
    return errorResponse(e);
  }
}
