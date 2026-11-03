// Lets `node --test` load the app's extensionless TypeScript imports.
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./resolve-ts.mjs", pathToFileURL("./scripts/"));
