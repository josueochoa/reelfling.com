import { cookies } from "next/headers";

/** Development only: switch the local signed-in email. Production returns 404. */
export async function POST(request: Request) {
  if (process.env.NODE_ENV !== "development") return new Response("Not found", { status: 404 });
  const email = String(((await request.json()) as { email?: string }).email ?? "")
    .trim()
    .toLowerCase();
  if (!email.includes("@")) return Response.json({ error: "Email required" }, { status: 400 });
  (await cookies()).set("dev_email", email, { httpOnly: true, sameSite: "lax", path: "/", secure: false });
  return Response.json({ ok: true });
}
