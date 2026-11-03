import { errorResponse, requireUser } from "@/lib/auth";
import { declineInvite, findInvite } from "@/lib/workspaces";

/** Decline an email invite addressed to you. */
export async function DELETE(_request: Request, ctx: RouteContext<"/api/invites/[inviteId]">) {
  try {
    const user = await requireUser();
    const invite = await findInvite({ id: (await ctx.params).inviteId, email: user.email });
    if (invite) await declineInvite(invite);
    return new Response(null, { status: 204 });
  } catch (e) {
    return errorResponse(e);
  }
}
