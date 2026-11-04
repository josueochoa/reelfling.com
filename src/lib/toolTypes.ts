// Shared by the server and the browser. No catalog JSON, no secrets.

export type ToolAccepts = "image" | "video";

export type ToolFieldView =
  | { name: string; label: string; type: "boolean"; default?: boolean }
  | { name: string; label: string; type: "enum"; options: string[]; default?: string }
  | { name: string; label: string; type: "number"; min?: number; max?: number; default?: number }
  | { name: string; label: string; type: "string"; default?: string };

/** What the Tools menu is allowed to see. The endpoint id stays on the server. */
export interface ToolView {
  id: string;
  name: string;
  description: string;
  accepts: ToolAccepts;
  fields: ToolFieldView[];
}

/** Image assets see image tools. Video assets see video tools. Anything else sees none. */
export function toolsForKind<T extends { accepts: ToolAccepts }>(tools: readonly T[], kind: string): T[] {
  if (kind !== "image" && kind !== "video") return [];
  return tools.filter((tool) => tool.accepts === kind);
}
