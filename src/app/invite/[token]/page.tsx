"use client";

// Opening an invite link: join the team (creating the account if needed), then go to it.

import { use, useEffect, useState } from "react";
import { setWorkspace } from "@/components/api";

export default function InvitePage({ params }: PageProps<"/invite/[token]">) {
  const { token } = use(params);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/invites/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as { workspaceId?: string; error?: string };
        if (!res.ok || !body.workspaceId) throw new Error(body.error ?? `Couldn't join (${res.status})`);
        setWorkspace(body.workspaceId);
        window.location.replace("/#video");
      })
      .catch((e: Error) => setError(e.message));
  }, [token]);

  return (
    <main className="grid min-h-dvh place-items-center bg-ink px-4 text-zinc-100">
      <div className="w-full max-w-sm rounded-2xl border border-white/5 bg-panel p-8 text-center">
        {error ? (
          <>
            <h1 className="text-lg font-semibold">This invite didn&apos;t work</h1>
            <p className="mt-2 text-sm text-zinc-400">{error}</p>
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a href="/" className="mt-6 inline-block text-sm text-accent hover:underline">
              Go to ReelFling
            </a>
          </>
        ) : (
          <p className="text-sm text-zinc-400">Joining the team…</p>
        )}
      </div>
    </main>
  );
}
