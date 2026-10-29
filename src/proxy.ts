import { NextResponse, type NextRequest } from "next/server";

// Optimistic check only (cookie present?). The API routes do the real session check.
export function proxy(request: NextRequest) {
  if (!request.cookies.has("sid")) return NextResponse.redirect(new URL("/login", request.url));
}

export const config = { matcher: ["/"] };
