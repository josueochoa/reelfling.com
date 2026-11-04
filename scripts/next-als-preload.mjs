// Next's request store is a real AsyncLocalStorage only when this global exists
// at module load. Node does not set it. Route tests import this first.
import { AsyncLocalStorage } from "node:async_hooks";

if (!globalThis.AsyncLocalStorage) globalThis.AsyncLocalStorage = AsyncLocalStorage;
