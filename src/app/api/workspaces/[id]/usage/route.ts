import { errorResponse, requireUser } from "@/lib/auth";
import { formatUsd } from "@/lib/spend";
import { spendByMember } from "@/lib/spend";
import { ForbiddenError, getWorkspace, listMembers, NotFoundError, permit } from "@/lib/workspaces";

function csvCell(value: string) {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** Estimated team-key spend per member for 7 or 30 days. Owners and admins. */
export async function GET(request: Request, ctx: RouteContext<"/api/workspaces/[id]/usage">) {
  try {
    const user = await requireUser();
    const ws = await getWorkspace(user.id, (await ctx.params).id);
    if (!ws || ws.kind !== "team") throw new NotFoundError("Team not found");
    if (!permit(ws.role, "viewUsage")) throw new ForbiddenError("Only the team's owner and admins can view usage.");
    const params = new URL(request.url).searchParams;
    const days = params.get("days") === "7" ? 7 : 30;
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    const [members, spend] = await Promise.all([listMembers(ws.id), spendByMember(ws.id, since)]);
    const byUser = new Map(spend.map((row) => [row.userId, row]));
    const rows = members.map((member) => {
      const hit = byUser.get(member.userId);
      return {
        userId: member.userId,
        email: member.email,
        name: member.name,
        role: member.role,
        usd: hit?.usd ?? 0,
        generations: hit?.generations ?? 0,
      };
    });
    if (params.get("format") === "csv") {
      const lines = [
        "email,name,role,estimated_usd,generations",
        ...rows.map((row) =>
          [row.email, row.name ?? "", row.role, formatUsd(row.usd), String(row.generations)].map(csvCell).join(","),
        ),
      ];
      return new Response(lines.join("\n") + "\n", {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="usage-${days}d.csv"`,
        },
      });
    }
    return Response.json({
      days,
      estimate: true,
      note: "Estimated spend on the team key. A provider-reported cost replaces the catalog estimate when the provider sends one. Generations on a member's own key are not included.",
      rows,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
