import { connection } from "next/server";
import { activeProviderId, getProvider } from "@/lib/providers";

/** Tells the UI which provider (and therefore which models) is active. */
export async function GET() {
  await connection();
  const provider = getProvider(activeProviderId());
  return Response.json({ provider: provider.id, label: provider.label });
}
