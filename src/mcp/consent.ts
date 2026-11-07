// "Allow Claude to use ReelFling?" Served on the app's own host, behind Cloudflare Access,
// so whoever can sign in to ReelFling can connect, and nobody else.

import {
  AuthorizationError,
  CimdFetchError,
  type ConsentDescription,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import type { BrowserUser } from "./app";
import { SCOPE_GENERATE, SCOPE_READ } from "./tools";

const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const SCOPE_TEXT: Record<string, string> = {
  [SCOPE_READ]: "See your models, files and jobs",
  [SCOPE_GENERATE]: "Start videos and images on your keys, up to $20 a day, and save files to your library",
};

function page(title: string, body: string) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${escape(title)}</title>
<style>
:root{color-scheme:dark;--bg:#0b0b0c;--panel:#141416;--line:#26262a;--fg:#f4f4f5;--muted:#a1a1aa;--accent:#c6f432}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,sans-serif;padding:16px}
main{width:100%;max-width:440px;background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:28px}
h1{font-size:20px;margin:0 0 8px}p{color:var(--muted);margin:0 0 16px}strong{color:var(--fg)}
label{display:flex;gap:10px;align-items:flex-start;padding:10px 0;border-top:1px solid var(--line)}input[type=checkbox]{margin-top:4px;accent-color:var(--accent)}
.warn{color:#fbbf24}.row{display:flex;gap:8px;margin-top:20px}
button{flex:1;border:0;border-radius:999px;padding:11px 16px;font:inherit;font-weight:600;cursor:pointer}
.allow{background:var(--accent);color:#0b0b0c}.deny{background:#26262a;color:var(--fg)}
.logo{display:inline-grid;place-items:center;width:32px;height:32px;border-radius:999px;background:var(--accent);color:#0b0b0c;font-weight:800;margin-bottom:16px}
</style></head><body><main><div class="logo">R</div>${body}</main></body></html>`;
}

export function consentPage(details: ConsentDescription, handle: string, user: BrowserUser): string {
  const name = escape(details.clientName || "An app");
  const origin = details.clientDomain
    ? `Published by <strong>${escape(details.clientDomain)}</strong>.`
    : "This app registered itself, so its name isn't verified.";
  // Read is always part of a connection; generate is the user's choice.
  const scopes = [SCOPE_READ, SCOPE_GENERATE]
    .map(
      (scope) =>
        `<label><input type="checkbox" name="scope" value="${scope}" checked${scope === SCOPE_READ ? " disabled" : ""}>` +
        `<span>${escape(SCOPE_TEXT[scope])}</span></label>`,
    )
    .join("");
  return page(
    `Connect ${details.clientName || "an app"} to ReelFling`,
    `<h1>Allow ${name} to use ReelFling?</h1>
<p>${origin} Access goes to <strong>${escape(details.redirectHost)}</strong>, for <strong>${escape(user.email)}</strong>.</p>
${details.redirectIsLoopback ? '<p class="warn">This sends access to an app on your computer. Continue only if you just started connecting from it.</p>' : ""}
<form method="post">
<input type="hidden" name="handle" value="${escape(handle)}">
<input type="hidden" name="scope" value="${SCOPE_READ}">
${scopes}
<div class="row"><button class="deny" name="decision" value="deny">Deny</button><button class="allow" name="decision" value="approve">Allow</button></div>
</form>
<p style="margin:16px 0 0;font-size:13px">You can disconnect any time in ReelFling under API keys → Connected apps.</p>`,
  );
}

const message = (status: number, title: string, text: string) =>
  new Response(page(title, `<h1>${escape(title)}</h1><p>${escape(text)}</p>`), {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "x-frame-options": "DENY", "cache-control": "no-store" },
  });

export async function handleConsent(request: Request, oauth: OAuthHelpers, user: BrowserUser | undefined): Promise<Response> {
  if (!user) return message(401, "Sign in to ReelFling first", "Open ReelFling, sign in, then start connecting again.");
  try {
    if (request.method === "GET") {
      const authRequest = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(authRequest); // first: a failed lookup leaves nothing stored
      const consent = await oauth.beginConsent(authRequest);
      consent.headers.set("content-type", "text/html; charset=utf-8");
      consent.headers.set("cache-control", "no-store");
      return new Response(consentPage(details, consent.handle, user), { headers: consent.headers });
    }
    if (request.method !== "POST") return message(405, "Not allowed", "Start connecting again from Claude.");
    const form = await request.formData();
    const handle = String(form.get("handle") ?? "");
    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const scope = [...new Set([SCOPE_READ, ...form.getAll("scope").map(String)])].filter(
      (value) => value === SCOPE_READ || value === SCOPE_GENERATE,
    );
    const approved = await oauth.approveConsent(request, handle, { scope });
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: user.id,
      metadata: { email: user.email, connectedAt: Date.now() },
      scope: approved.request.scope,
      props: { userId: user.id },
    });
    approved.headers.set("location", redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError)
      return message(400, "This link expired", `${error.description ?? "The request is no longer valid."} Start connecting again from Claude.`);
    if (error instanceof CimdFetchError) return message(400, "This app couldn't be verified", "Start connecting again from Claude.");
    throw error;
  }
}
