import type { Metadata } from "next";
import { connection } from "next/server";
import { JoinTeam } from "./JoinTeam";

export const metadata: Metadata = { title: "Join team · ReelFling" };

export default async function InvitePage({ params }: PageProps<"/invite/[token]">) {
  await connection();
  const { token } = await params;
  return <JoinTeam token={token} />;
}
