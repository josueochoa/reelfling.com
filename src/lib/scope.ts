// Rows are scoped by workspace_id. Personal rows written before that column was
// filled still have it NULL and are found by user_id, which for a personal
// workspace is the same id.

/** SQL fragment. Bind the workspace id twice. */
export const byWorkspace = (prefix = "") =>
  `(${prefix}workspace_id = ? OR (${prefix}workspace_id IS NULL AND ${prefix}user_id = ?))`;

export const wsArgs = (workspaceId: string) => [workspaceId, workspaceId] as const;

export type KeySource = "team" | "member";

const EPHEMERAL = new Set(["createdBy", "creator"]);

/** Who made a row lives in its own column, not in the JSON document. */
export function persistJson(value: object) {
  return JSON.stringify(value, (key, val) => (EPHEMERAL.has(key) ? undefined : val));
}
