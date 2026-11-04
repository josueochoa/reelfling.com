import { errorResponse, requireUser } from "@/lib/auth";
import { removeMember } from "@/lib/teams";

export async function DELETE(_req: Request, ctx: RouteContext<"/api/teams/[id]/members/[userId]">) {
  try {
    const user = await requireUser();
    const { id, userId } = await ctx.params;
    await removeMember(id, user.id, userId);
    return new Response(null, { status: 204 });
  } catch (e) {
    return errorResponse(e);
  }
}
