import "server-only";
import type { ArenaStore } from "./types";
import { FileStore } from "./file-store";
import { PostgresStore } from "./postgres-store";
import { seedIfEmpty } from "./seed";

/**
 * Process-wide store. Held on globalThis so a dev hot-reload does not orphan a
 * running match's data mid-flight.
 *
 * Which driver runs is decided by one environment variable. With `DATABASE_URL`
 * set, state is shared across every instance and survives restarts; without it,
 * the file driver keeps the zero-setup first run working. Nothing above this
 * module knows the difference.
 */

const KEY = "__arena_store__";
type Holder = { [KEY]?: { store: ArenaStore & Persistable; ready: Promise<void> } };

interface Persistable {
  readonly isPersistent: boolean;
  readonly location: string;
}

function holder(): Holder {
  return globalThis as unknown as Holder;
}

function createStore(): ArenaStore & Persistable {
  const url = process.env.DATABASE_URL?.trim();
  if (url) return new PostgresStore(url);
  return new FileStore();
}

export async function getStore(): Promise<ArenaStore> {
  const h = holder();
  if (!h[KEY]) {
    const store = createStore();
    h[KEY] = { store, ready: seedIfEmpty(store) };
  }
  await h[KEY].ready;
  return h[KEY].store;
}

/** Diagnostics for the system status endpoint. Never exposes secrets. */
export async function storeStatus(): Promise<{
  persistent: boolean;
  location: string;
  driver: "postgres" | "file";
  shared: boolean;
}> {
  await getStore();
  const store = holder()[KEY]!.store;
  const driver = store.location.startsWith("postgres") ? "postgres" : "file";
  return {
    persistent: store.isPersistent,
    location: store.location,
    driver,
    // Whether a second instance would see the same data. The file driver is
    // correct on one long-lived process and per-instance anywhere else.
    shared: driver === "postgres",
  };
}

/**
 * Vote storage is optional: the file driver implements it in memory, the
 * Postgres driver in a table. Narrowed here so callers do not reach into a
 * concrete driver.
 */
export interface VoteStore {
  castVote(matchId: string, voterId: string, side: "A" | "B"): Promise<void>;
  getVotes(matchId: string, voterId?: string): Promise<{ A: number; B: number; mine: "A" | "B" | null }>;
}

export async function getVoteStore(): Promise<VoteStore> {
  return (await getStore()) as unknown as VoteStore;
}

export type { ArenaStore } from "./types";
