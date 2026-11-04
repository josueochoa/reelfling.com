import { errorResponse, requireUser } from "@/lib/auth";
import { createInvite } from "@/lib/teams";

export async function POST(request: Request, ctx: RouteContext<"/api/teams/[id]/invites">) {
  try {
    const user = await requireUser();
    const origin = new URL(request.url).origin;
    return Response.json(await createInvite((await ctx.params).id, user.id, origin), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
