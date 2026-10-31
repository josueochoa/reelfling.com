import { AuthError, currentIdentity, errorResponse, upsertUser } from "@/lib/auth";
import { acceptInvite, findInvite, NotFoundError } from "@/lib/workspaces";

/**
 * { token } (an invite link) or { inviteId } (an email invite to the signed-in address).
 * A valid invite also creates the account if the person doesn't have one yet.
 */
export async function POST(request: Request) {
  try {
    const identity = await currentIdentity();
    if (!identity) throw new AuthError();
    const body = (await request.json()) as { token?: string; inviteId?: string };
    const invite = body.token
      ? await findInvite({ token: body.token })
      : body.inviteId
        ? await findInvite({ id: body.inviteId, email: identity.email })
        : undefined;
    if (!invite) throw new NotFoundError("This invite has expired or was revoked. Ask for a new one.");
    const user = await upsertUser(identity, { admit: true });
    await acceptInvite(invite, user);
    return Response.json({ workspaceId: invite.workspaceId, workspaceName: invite.workspaceName });
  } catch (e) {
    return errorResponse(e);
  }
}
