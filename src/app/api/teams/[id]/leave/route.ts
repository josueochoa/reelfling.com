import { errorResponse, requireUser } from "@/lib/auth";
import { leaveTeam } from "@/lib/teams";

export async function POST(_req: Request, ctx: RouteContext<"/api/teams/[id]/leave">) {
  try {
    const user = await requireUser();
    await leaveTeam((await ctx.params).id, user.id);
    return new Response(null, { status: 204 });
  } catch (e) {
    return errorResponse(e);
  }
}
