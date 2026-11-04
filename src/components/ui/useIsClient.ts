"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};
const getClient = () => true;
const getServer = () => false;

/** True after hydration. Snapshots are stable so the store does not loop. */
export function useIsClient() {
  return useSyncExternalStore(subscribe, getClient, getServer);
}
