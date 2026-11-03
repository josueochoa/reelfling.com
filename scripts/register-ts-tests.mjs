// Lets `node --test` load the app's extensionless TypeScript imports.
// The filename must not match node's test globs (`test-*`, `*.test.*`).
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./resolve-ts.mjs", pathToFileURL("./scripts/"));
