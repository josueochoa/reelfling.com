// Calls from the Claude connector (src/mcp) into the app's own routes, made in-process by
// worker.ts. Each call registers a one-off token for the signed-in connector user; the
// token never leaves the isolate, so a request from outside can't carry a valid one.

declare global {
  var __connectorUsers: Map<string, string> | undefined;
}

export const CONNECTOR_USER_HEADER = "x-connector-user-token";

export function registerConnectorCall(userId: string): { token: string; release: () => void } {
  const token = crypto.randomUUID();
  const users = (globalThis.__connectorUsers ??= new Map());
  users.set(token, userId);
  return { token, release: () => users.delete(token) };
}

export const connectorUserId = (token: string) => globalThis.__connectorUsers?.get(token);
