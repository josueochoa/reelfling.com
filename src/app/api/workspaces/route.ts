import { errorResponse, requireUser } from "@/lib/auth";
import { getBilling, PlanRequiredError } from "@/lib/billing";
import { planOf, TEAM_PLANS_LABEL } from "@/lib/plans";
import { createTeam } from "@/lib/workspaces";

/** { name } — create a team; the creator is its owner. Needs a plan with Teams. */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    if (!planOf((await getBilling(user.id)).plan).teams)
      throw new PlanRequiredError(`Teams are part of the ${TEAM_PLANS_LABEL} plans. Upgrade to create one.`);
    const name = String(((await request.json()) as { name?: string }).name ?? "")
      .trim()
      .slice(0, 60);
    if (!name) return Response.json({ error: "Give the team a name" }, { status: 400 });
    return Response.json(await createTeam(user, name), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
