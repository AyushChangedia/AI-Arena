import "server-only";
import type { ArenaStore } from "./types";
import { FileStore } from "./file-store";
import { seedIfEmpty } from "./seed";

/**
 * Process-wide store. Held on globalThis so a dev hot-reload does not orphan a
 * running match's data mid-flight.
 */

const KEY = "__arena_store__";
type Holder = { [KEY]?: { store: FileStore; ready: Promise<void> } };

function holder(): Holder {
  return globalThis as unknown as Holder;
}

export async function getStore(): Promise<ArenaStore> {
  const h = holder();
  if (!h[KEY]) {
    const store = new FileStore();
    h[KEY] = { store, ready: seedIfEmpty(store) };
  }
  await h[KEY].ready;
  return h[KEY].store;
}

/** Diagnostics for the system status endpoint. Never exposes secrets. */
export async function storeStatus(): Promise<{ persistent: boolean; location: string }> {
  await getStore();
  const h = holder();
  const store = h[KEY]!.store;
  return { persistent: store.isPersistent, location: store.location };
}

export type { ArenaStore } from "./types";
