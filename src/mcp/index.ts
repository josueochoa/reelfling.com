// The Claude connector. Claude talks to https://mcp.reelfling.com/mcp with an OAuth token;
// people approve it on https://reelfling.com/connect/authorize, behind Cloudflare Access.
// Both hosts are this Worker: worker.ts hands a request here first and falls back to the app.

import { getOAuthApi, OAuthProvider, type OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { appAs, appOrigin, browserUser, mcpOrigin, type AppFetch, type ConnectorEnv } from "./app";
import { handleConsent } from "./consent";
import { spentToday } from "./spend";
import { connectorServer, SCOPE_GENERATE, SCOPE_READ } from "./tools";

export type { AppFetch } from "./app";

export const CONSENT_PATH = "/connect/authorize";
const GRANTS_PATH = "/api/connector/grants";
const CONNECTOR_PATHS = /^\/(mcp|oauth\/(token|register)|\.well-known\/oauth-(authorization-server|protected-resource))(\/|$)/;
const DAY_S = 24 * 60 * 60;

interface ConnectorProps {
  userId: string;
}

function options(fetchApp: AppFetch, env: ConnectorEnv): OAuthProviderOptions<ConnectorEnv> {
  const mcp = mcpOrigin(env);
  return {
    apiRoute: `${mcp}/mcp`,
    apiHandler: {
      async fetch(request, env, ctx) {
        const { props, auth } = ctx as ExecutionContext<ConnectorProps> & { auth: { scope: string[]; clientId?: string } };
        if (!props?.userId) return new Response("Unauthorized", { status: 401 });
        const app = appAs(fetchApp, env, ctx, props.userId);
        const server = connectorServer(app, env, {
          userId: props.userId,
          clientId: auth.clientId ?? "unknown",
          scope: auth.scope,
        });
        // Stateless: a server per request, answered as JSON. Jobs are polled with get_job.
        const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        await server.connect(transport);
        return transport.handleRequest(request);
      },
    },
    defaultHandler: {
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/" || url.pathname === "")
          return new Response(`ReelFling connector for Claude. In Claude, add a custom connector with the URL ${mcp}/mcp\n`, {
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
        return new Response("Not found", { status: 404 });
      },
    },
    // Full URLs: the consent page lives on the app's host, and the issuer is the token endpoint's origin.
    authorizeEndpoint: `${appOrigin(env)}${CONSENT_PATH}`,
    tokenEndpoint: `${mcp}/oauth/token`,
    clientRegistrationEndpoint: `${mcp}/oauth/register`,
    scopesSupported: [SCOPE_READ, SCOPE_GENERATE],
    requiredScopes: [SCOPE_READ],
    resourceMetadata: {
      resource: `${mcp}/mcp`,
      authorization_servers: [mcp],
      resource_name: "ReelFling",
    },
    accessTokenTTL: 60 * 60,
    refreshTokenTTL: 30 * DAY_S,
  };
}

let provider: { origin: string; instance: OAuthProvider<ConnectorEnv> } | undefined;

/** The connector's response, or undefined for everything that belongs to the app. */
export async function connectorFetch(
  fetchApp: AppFetch,
  request: Request,
  env: ConnectorEnv,
  ctx: ExecutionContext,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  // In production the connector's host is all connector. `wrangler dev` serves every request
  // as one host, so locally (APP_URL = MCP_URL) only the connector's own paths are taken.
  const ownHost = mcpOrigin(env) !== appOrigin(env);
  if (url.origin === mcpOrigin(env) && (ownHost || CONNECTOR_PATHS.test(url.pathname))) {
    if (provider?.origin !== url.origin) provider = { origin: url.origin, instance: new OAuthProvider(options(fetchApp, env)) };
    return provider.instance.fetch(request, env, ctx);
  }
  if (url.pathname === CONSENT_PATH) {
    const oauth = getOAuthApi(options(fetchApp, env), env);
    return handleConsent(request, oauth, await browserUser(fetchApp, request, env, ctx));
  }
  if (url.pathname === GRANTS_PATH) return grants(fetchApp, request, env, ctx);
  return undefined;
}

/** Connected apps for the signed-in user: GET lists them, DELETE ?id= disconnects one. */
async function grants(fetchApp: AppFetch, request: Request, env: ConnectorEnv, ctx: ExecutionContext) {
  const user = await browserUser(fetchApp, request, env, ctx);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const oauth = getOAuthApi(options(fetchApp, env), env);
  if (request.method === "DELETE") {
    const id = new URL(request.url).searchParams.get("id") ?? "";
    const { items } = await oauth.listUserGrants(user.id);
    if (!items.some((grant) => grant.id === id)) return Response.json({ error: "Not found" }, { status: 404 });
    await oauth.revokeGrant(id, user.id);
    return new Response(null, { status: 204 });
  }
  if (request.method !== "GET") return Response.json({ error: "Method not allowed" }, { status: 405 });
  const { items } = await oauth.listUserGrants(user.id);
  const list = await Promise.all(
    items.map(async (grant) => {
      const client = await oauth.lookupClient(grant.clientId).catch(() => null);
      return {
        id: grant.id,
        name: client?.clientName || "Unnamed app",
        scope: grant.scope,
        createdAt: grant.createdAt * 1000,
        spentToday: Math.round((await spentToday(env, user.id, grant.clientId)) * 100) / 100,
      };
    }),
  );
  return Response.json({ grants: list, url: `${mcpOrigin(env)}/mcp` });
}
