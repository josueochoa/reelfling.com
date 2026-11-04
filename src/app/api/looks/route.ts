import { errorResponse, requireUser } from "@/lib/auth";
import { addLook, deleteLook, listLooks } from "@/lib/savedLooks";
import type { LookChoice } from "@/lib/registry/looks";

export async function GET() {
  try {
    const user = await requireUser();
    return Response.json(await listLooks(user.id));
  } catch (e) {
    return errorResponse(e);
  }
}

/** { name, choice } — save the current chips under a name. */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const body = (await request.json()) as { name?: string; choice?: LookChoice };
    const saved = await addLook(user.id, body.name ?? "", body.choice ?? {});
    if (typeof saved === "string") return Response.json({ error: saved }, { status: 400 });
    return Response.json(saved, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}

/** ?id= — drop one saved look. */
export async function DELETE(request: Request) {
  try {
    const user = await requireUser();
    const id = new URL(request.url).searchParams.get("id")?.trim() ?? "";
    if (!id) return Response.json({ error: "Missing look" }, { status: 400 });
    return Response.json(await deleteLook(user.id, id));
  } catch (e) {
    return errorResponse(e);
  }
}
