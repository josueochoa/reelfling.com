import { errorResponse, requireUser } from "@/lib/auth";
import { extendOffers } from "@/lib/extend";
import { catalogImageModels, catalogPickerModels } from "@/lib/registry/generated";
import { publicTools } from "@/lib/toolCatalog";

/** Slim picker models and tools. The catalog JSON stays on the server. */
export async function GET() {
  try {
    await requireUser();
    return Response.json({
      models: catalogPickerModels(),
      images: catalogImageModels(),
      tools: publicTools(),
      extend: extendOffers(),
    });
  } catch (e) {
    return errorResponse(e);
  }
}
