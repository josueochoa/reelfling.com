import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Resolve `./file` to `./file.ts` (or `./file/index.ts`) and `@/` to `src/`, so the test runner can import the app's TypeScript. JSON stays JSON. */
export async function resolve(specifier, context, nextResolve) {
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
