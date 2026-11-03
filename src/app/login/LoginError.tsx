"use client";

import { useSearchParams } from "next/navigation";

const MESSAGES: Record<string, string> = {
  not_configured: "Google sign-in isn't configured yet. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.",
  cancelled: "Sign-in was cancelled.",
  expired: "Sign-in took too long. Please try again.",
  state_mismatch: "Sign-in couldn't be verified. Please try again.",
  unverified_email: "Your Google email address isn't verified.",
  google_error: "Google sign-in failed. Please try again.",
  not_invited: "ReelFling is invite-only. Ask a team admin to invite your email address.",
};

export function LoginError() {
  const error = useSearchParams().get("error");
  if (!error) return null;
  return (
    <p className="mt-4 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">
      {MESSAGES[error] ?? "Something went wrong. Please try again."}
    </p>
  );
}
