import { errorResponse, requireUser } from "@/lib/auth";
import { createTeam, listTeams } from "@/lib/teams";

export async function GET() {
  try {
    const user = await requireUser();
    return Response.json(await listTeams(user.id));
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const body = (await request.json()) as { name?: unknown };
    return Response.json(await createTeam(user.id, body.name), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
