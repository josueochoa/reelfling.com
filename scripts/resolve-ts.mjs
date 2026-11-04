import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Resolve `./file` to `./file.ts` (or `./file/index.ts`) and `@/` to `src/`, so the test runner can import the app's TypeScript. JSON stays JSON. */
export async function resolve(specifier, context, nextResolve) {
  // Next's package entrypoints are extensionless CJS. Node's ESM loader will not
  // guess the `.js`, and route tests import handlers that call `next/headers`.
  if (specifier === "next/headers" || specifier === "next/server") {
    return nextResolve(`${specifier}.js`, context);
  }
  if (specifier.startsWith("@/")) {
    const target = join(process.cwd(), "src", specifier.slice(2));
    return resolveTs(pathToFileURL(target).href, context, nextResolve);
  }
  if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    !/\.(?:[cm]?[jt]s|json)$/.test(specifier)
  ) {
    return resolveTs(specifier, context, nextResolve);
  }
  return nextResolve(specifier, context);
}

async function resolveTs(specifier, context, nextResolve) {
  try {
    return await nextResolve(`${specifier}.ts`, context);
  } catch {
    return nextResolve(`${specifier}/index.ts`, context);
  }
}
