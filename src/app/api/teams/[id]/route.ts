import { errorResponse, requireUser } from "@/lib/auth";
import { deleteTeam, teamDetail } from "@/lib/teams";

export async function GET(_req: Request, ctx: RouteContext<"/api/teams/[id]">) {
  try {
    const user = await requireUser();
    return Response.json(await teamDetail((await ctx.params).id, user.id));
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(_req: Request, ctx: RouteContext<"/api/teams/[id]">) {
  try {
    const user = await requireUser();
    await deleteTeam((await ctx.params).id, user.id);
    return new Response(null, { status: 204 });
  } catch (e) {
    return errorResponse(e);
  }
}
