// Which catalog entries can run as tools. The generated catalog is imported here, on the server.

import { catalogModel } from "./registry/generated";
import { buildToolBody, formFor, TOOL_FORMS } from "./registry/tool-forms";
import type { ModelEntry } from "./registry/types";
import type { ToolAccepts, ToolView } from "./toolTypes";

/** The asset kind a tool catalog entry reads. Other groups are not tools. */
export function catalogAccepts(model: ModelEntry): ToolAccepts | undefined {
  if (model.group !== "tool") return undefined;
  const accepts = model.capabilities.accepts;
  return accepts === "image" || accepts === "video" ? accepts : undefined;
}

export interface RunnableTool extends ToolView {
  endpoint: string;
  mapper: "fal.queue";
  inputKey: string;
}

/**
 * A tool is runnable when the catalog and a form schema agree on the asset kind
 * and the route is the generic fal queue.
 */
export function runnableTools(): RunnableTool[] {
  const tools: RunnableTool[] = [];
  for (const form of TOOL_FORMS) {
    const model = catalogModel(form.id);
    if (!model) continue;
    const accepts = catalogAccepts(model);
    if (!accepts || accepts !== form.accepts) continue;
    const route = model.routes.find((item) => item.provider === "fal" && item.mapper === "fal.queue");
    if (!route || route.endpoint !== form.id.slice("fal:".length)) continue;
    tools.push({
      id: model.id,
      name: model.name,
      description: model.description,
      accepts,
      fields: form.fields.map((field) => ({ ...field })),
      ...(form.menu ? { menu: form.menu } : {}),
      ...(form.quote ? { quote: { ...form.quote } } : {}),
      endpoint: route.endpoint,
      mapper: "fal.queue",
      inputKey: form.inputKey,
    });
  }
  return tools;
}

/** Slim list for the Tools menu. No endpoint ids. */
export function publicTools(): ToolView[] {
  return runnableTools().map(({ id, name, description, accepts, fields, menu, quote }) => ({
    id,
    name,
    description,
    accepts,
    fields,
    ...(menu ? { menu } : {}),
    ...(quote ? { quote } : {}),
  }));
}

export function prepareToolInput(toolId: string, assetKey: string, params: unknown) {
  const tool = runnableTools().find((item) => item.id === toolId);
  if (!tool) return undefined;
  const form = formFor(tool.id);
  if (!form) return undefined;
  return {
    tool,
    body: buildToolBody(form, params, `upload:${assetKey}`),
  };
}
