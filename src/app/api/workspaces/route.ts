import { errorResponse, requireUser } from "@/lib/auth";
import { createTeam } from "@/lib/workspaces";

/** { name } — create a team; the creator is its owner. */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const name = String(((await request.json()) as { name?: string }).name ?? "")
      .trim()
      .slice(0, 60);
    if (!name) return Response.json({ error: "Give the team a name" }, { status: 400 });
    return Response.json(await createTeam(user, name), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
