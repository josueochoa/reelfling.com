import { authMode, errorResponse, requireUser, signOutUrl } from "@/lib/auth";
import { getBilling } from "@/lib/billing";
import { listKeys } from "@/lib/keys";
import { catalogModel } from "@/lib/registry/generated";
import { routeChoiceError } from "@/lib/registry/routing";
import { isRouteProvider, listRoutePreferences, setRoutePreference } from "@/lib/routes";
import { listLooks } from "@/lib/savedLooks";
import { storageUsage } from "@/lib/storage";

/** The signed-in user, their saved keys (masked), the provider they generate with, plan, storage used and how to sign out. */
export async function GET() {
  try {
    const user = await requireUser();
    const [keys, storage, billing] = await Promise.all([listKeys(user.id), storageUsage(user.id), getBilling(user.id)]);
    return Response.json({
      user,
      keys,
      storage,
      billing,
      routePreferences: await listRoutePreferences(user.id),
      looks: await listLooks(user.id),
      auth: { mode: authMode(), signOutUrl: signOutUrl() },
    });
  } catch (e) {
    return errorResponse(e);
  }
}

/** { modelId, provider } — this user's route for one catalog model. */
export async function PATCH(request: Request) {
  try {
    const user = await requireUser();
    const body = (await request.json()) as { modelId?: string; provider?: string };
    const modelId = body.modelId?.trim() ?? "";
    const provider = body.provider?.trim() ?? "";
    const error = routeChoiceError(modelId ? catalogModel(modelId) : undefined, provider);
    if (error || !isRouteProvider(provider)) return Response.json({ error: error ?? "Unknown route" }, { status: 400 });
    await setRoutePreference(user.id, modelId, provider);
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
