import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { authMode } from "@/lib/auth";
import { LoginError } from "./LoginError";

export const metadata: Metadata = { title: "Sign in · ReelFling" };

export default function LoginPage() {
  return (
    <main className="grid min-h-dvh place-items-center bg-ink px-4 text-zinc-100">
      <div className="w-full max-w-sm rounded-2xl border border-white/5 bg-panel p-8">
        <div className="mb-8 flex items-center gap-2">
          <div className="grid size-8 place-items-center rounded-lg bg-accent font-black text-ink">R</div>
          <span className="text-lg font-semibold tracking-tight">ReelFling</span>
        </div>
        <Suspense>
          <SignIn />
        </Suspense>
      </div>
    </main>
  );
}

/** Read per request: the sign-in method is a runtime setting (AUTH_MODE). */
async function SignIn() {
  await connection();

  if (authMode() === "access") {
    // Access sits in front of every page, so landing here means its token didn't verify.
    return (
      <>
        <h1 className="text-xl font-semibold">Couldn&apos;t verify your sign-in</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Your Cloudflare Access session may have expired, or the app&apos;s Access settings don&apos;t match.
        </p>
        <div className="mt-6 flex gap-2">
          {/* A full page load, so Access can step in and sign the user in again. */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a
            href="/"
            className="flex-1 rounded-xl bg-white py-3 text-center text-sm font-medium text-zinc-900 hover:bg-zinc-200"
          >
            Try again
          </a>
          <a
            href="/cdn-cgi/access/logout"
            className="flex-1 rounded-xl border border-white/10 py-3 text-center text-sm text-zinc-300 hover:bg-white/5"
          >
            Sign out
          </a>
        </div>
      </>
    );
  }

  return (
    <>
      <h1 className="text-xl font-semibold">Sign in</h1>
      <p className="mt-1 text-sm text-zinc-400">Generate videos and images using your own API key.</p>
      <LoginError />
      <a
        href="/api/auth/google"
        className="mt-6 flex w-full items-center justify-center gap-3 rounded-xl bg-white py-3 text-sm font-medium text-zinc-900 transition hover:bg-zinc-200"
      >
        <svg viewBox="0 0 48 48" className="size-5" aria-hidden>
          <path
            fill="#FFC107"
            d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"
          />
          <path
            fill="#FF3D00"
            d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"
          />
          <path
            fill="#4CAF50"
            d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"
          />
          <path
            fill="#1976D2"
            d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"
          />
        </svg>
        Continue with Google
      </a>
    </>
  );
}
