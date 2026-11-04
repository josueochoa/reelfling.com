"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

// Survives the development remount, so a one-time invite is only submitted once.
const joining = new Set<string>();

export function JoinTeam({ token }: { token: string }) {
  const router = useRouter();
  const [message, setMessage] = useState("Joining team…");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (joining.has(token)) return;
    joining.add(token);
    (async () => {
      const res = await fetch("/api/teams/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (res.status === 401) {
        joining.delete(token);
        setFailed(true);
        setMessage("Sign in, then open this invite link again.");
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string; team?: { id: string } };
      if (!res.ok || !body.team) {
        joining.delete(token);
        setFailed(true);
        setMessage(body.error ?? "Invite is invalid or expired");
        return;
      }
      sessionStorage.setItem("reelfling.team", body.team.id);
      router.push("/#team");
    })().catch(() => {
      joining.delete(token);
      setFailed(true);
      setMessage("Couldn't join the team.");
    });
  }, [token, router]);

  return (
    <main className="grid min-h-dvh place-items-center bg-ink px-4 text-zinc-100">
      <div className="w-full max-w-sm rounded-2xl border border-white/5 bg-panel p-8">
        <div className="mb-6 flex items-center gap-2">
          <div className="grid size-8 place-items-center rounded-lg bg-accent font-black text-ink">R</div>
          <span className="text-lg font-semibold tracking-tight">ReelFling</span>
        </div>
        <h1 className="text-xl font-semibold">Join team</h1>
        <p className="mt-2 text-sm text-zinc-400" data-testid="join-status">
          {message}
        </p>
        {failed && (
          <Link href="/" className="mt-6 block rounded-xl bg-white py-3 text-center text-sm font-medium text-zinc-900">
            Back to ReelFling
          </Link>
        )}
      </div>
    </main>
  );
}
