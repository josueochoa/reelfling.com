import type { RefKind } from "../mentions";
import type { RefSyntax } from "./types";

export function mentionSyntax(style: RefSyntax): (kind: RefKind, n: number) => string {
  if (style === "brackets") return (kind, n) => `[${kind} ${n}]`;
  if (style === "at") return (kind, n) => `@${kind} ${n}`;
  return (_kind, n) => `image ${n}`;
}
