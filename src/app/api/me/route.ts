import { authMode, errorResponse, requireUser, setActiveProvider, signOutUrl } from "@/lib/auth";
import { listKeys } from "@/lib/keys";
import type { ProviderId } from "@/lib/models";
import { PROVIDERS } from "@/lib/providers";
import { storageUsage } from "@/lib/storage";

/** The signed-in user, their saved keys (masked), the provider they generate with, storage used and how to sign out. */
export async function GET() {
  try {
    const user = await requireUser();
    const [keys, storage] = await Promise.all([listKeys(user.id), storageUsage(user.id)]);
    return Response.json({ user, keys, storage, auth: { mode: authMode(), signOutUrl: signOutUrl() } });
  } catch (e) {
    return errorResponse(e);
  }
}

/** { activeProvider } — switch which of the user's keys is used. */
export async function PATCH(request: Request) {
  try {
    const user = await requireUser();
    const { activeProvider } = (await request.json()) as { activeProvider: ProviderId };
    if (!(activeProvider in PROVIDERS)) return Response.json({ error: "Unknown provider" }, { status: 400 });
    if (!(await listKeys(user.id)).some((k) => k.provider === activeProvider))
      return Response.json({ error: "Add a key for that provider first" }, { status: 400 });
    await setActiveProvider(user.id, activeProvider);
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
