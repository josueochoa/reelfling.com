import { registerHooks } from "node:module";

// node --test does not resolve the app's extensionless TypeScript imports.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !/\.(?:[cm]?[jt]s|json|node)$/.test(specifier)
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

await import("../src/lib/inputs.suite.ts");
