import { errorResponse, requireUser } from "@/lib/auth";
import { acceptInvite } from "@/lib/teams";

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const body = (await request.json()) as { token?: unknown };
    const detail = await acceptInvite(user.id, body.token);
    return Response.json({ team: detail.team });
  } catch (e) {
    return errorResponse(e);
  }
}
