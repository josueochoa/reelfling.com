import { errorResponse, requireUser } from "@/lib/auth";
import { teamFeed } from "@/lib/teams";

/** Read-only generations and assets of everyone currently on the team. */
export async function GET(_req: Request, ctx: RouteContext<"/api/teams/[id]/feed">) {
  try {
    const user = await requireUser();
    return Response.json(await teamFeed((await ctx.params).id, user.id));
  } catch (e) {
    return errorResponse(e);
  }
}
