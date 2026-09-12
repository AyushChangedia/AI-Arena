import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { FileStore } from "@/lib/store/file-store";
import { PostgresStore } from "@/lib/store/postgres-store";
import type { ArenaStore } from "@/lib/store/types";
import type { Agent, Match, Rating, Season } from "@/lib/arena/types";
import { SEED_CONFIGS } from "@/lib/store/seed";

/**
 * One suite, run against every driver.
 *
 * A second store implementation is only safe if it is indistinguishable from
 * the first through the interface, so these assertions are written once and
 * applied to both. Anything that passes here can be swapped in without the
 * engine, the queries or the UI knowing.
 *
 * The Postgres driver is skipped unless TEST_DATABASE_URL points at a real
 * database — CI without Postgres runs the file driver and says so, rather than
 * silently testing nothing.
 */

interface VoteCapable {
  castVote(matchId: string, voterId: string, side: "A" | "B"): Promise<void>;
  getVotes(matchId: string, voterId?: string): Promise<{ A: number; B: number; mine: "A" | "B" | null }>;
}

const PG_URL = process.env.TEST_DATABASE_URL;

function season(n: number, status: Season["status"]): Season {
  return {
    id: `season_${n}`,
    number: n,
    name: `Season ${n}`,
    startsAt: 1_700_000_000_000 + n,
    endsAt: 1_800_000_000_000 + n,
    status,
    awards: [],
  };
}

function agent(handle: string, ownerId: string, updatedAt: number): Agent {
  const template = SEED_CONFIGS[0]!;
  return {
    id: `agent_${handle}`,
    ownerId,
    visibility: "public",
    config: { ...template, handle, name: handle },
    configHash: `hash_${handle}`,
    createdAt: updatedAt - 1000,
    updatedAt,
    origin: "user",
  };
}

function match(id: string, number: number, agentIds: [string, string], createdAt: number): Match {
  return {
    id,
    number,
    taskId: "task_rate_limiter",
    seasonId: "season_1",
    mode: "demo",
    status: "complete",
    result: "A",
    createdAt,
    startedAt: createdAt,
    endedAt: createdAt + 500,
    seed: 42,
    envHash: "abc",
    participants: agentIds.map((agentId, i) => ({
      side: i === 0 ? "A" : "B",
      agentId,
      configHash: `hash_${agentId}`,
      configSnapshot: { handle: agentId, name: agentId, tools: [] },
      executionId: null,
      scoreTotal: null,
      ratingBefore: 1200,
      ratingAfter: null,
    })),
  } as unknown as Match;
}

function suite(
  name: string,
  make: () => ArenaStore,
  options: { reset?: () => Promise<void>; cleanup?: () => Promise<void> } = {},
) {
  describe(`${name} driver`, () => {
    const store = make();

    // Assertions below are about exact contents, so the suite has to own the
    // store it runs against rather than inherit a previous run's rows.
    beforeAll(async () => {
      await options.reset?.();
    });

    afterAll(async () => {
      await options.cleanup?.();
    });

    it("round-trips an agent without mangling its numbers", async () => {
      const a = agent("alpha", "owner_1", 1_770_000_000_123);
      await store.createAgent(a);
      const read = await store.getAgent(a.id);

      expect(read).not.toBeNull();
      // The trap a jsonb/bigint split exists to avoid: a millisecond timestamp
      // coming back as a string silently breaks every sort and comparison.
      expect(typeof read!.updatedAt).toBe("number");
      expect(read!.updatedAt).toBe(1_770_000_000_123);
      expect(read).toEqual(a);
    });

    it("finds an agent by handle", async () => {
      await store.createAgent(agent("bravo", "owner_1", 1_770_000_000_200));
      const found = await store.getAgentByHandle("bravo");
      expect(found?.id).toBe("agent_bravo");
      expect(await store.getAgentByHandle("nope")).toBeNull();
    });

    it("lists agents newest-updated first, and filters by owner", async () => {
      await store.createAgent(agent("charlie", "owner_2", 1_770_000_000_900));
      const all = await store.listAgents();
      const handles = all.map((a) => a.config.handle);
      expect(handles[0]).toBe("charlie");

      const mine = await store.listAgents({ ownerId: "owner_2" });
      expect(mine.map((a) => a.config.handle)).toEqual(["charlie"]);
    });

    it("versions an agent and returns newest first", async () => {
      for (const v of [1, 2, 3]) {
        await store.createAgentVersion({
          id: `ver_alpha_${v}`,
          agentId: "agent_alpha",
          version: v,
          config: {} as Agent["config"],
          configHash: `h${v}`,
          createdAt: 1_770_000_000_000 + v,
        });
      }
      const versions = await store.listAgentVersions("agent_alpha");
      expect(versions.map((v) => v.version)).toEqual([3, 2, 1]);
    });

    it("deletes an agent and reports whether anything went", async () => {
      await store.createAgent(agent("doomed", "owner_3", 1));
      expect(await store.deleteAgent("agent_doomed")).toBe(true);
      expect(await store.deleteAgent("agent_doomed")).toBe(false);
      expect(await store.getAgent("agent_doomed")).toBeNull();
    });

    it("issues strictly increasing match numbers", async () => {
      const numbers = await Promise.all([
        store.nextMatchNumber(),
        store.nextMatchNumber(),
        store.nextMatchNumber(),
      ]);
      expect(new Set(numbers).size, `collided: ${numbers.join(",")}`).toBe(3);
      expect(Math.min(...numbers)).toBeGreaterThan(1000);
    });

    it("lists matches newest first and filters by participant", async () => {
      await store.saveSeason(season(1, "active"));
      await store.createMatch(match("match_1", 1001, ["agent_alpha", "agent_bravo"], 100));
      await store.createMatch(match("match_2", 1002, ["agent_alpha", "agent_charlie"], 200));
      await store.createMatch(match("match_3", 1003, ["agent_bravo", "agent_charlie"], 300));

      const all = await store.listMatches();
      expect(all.map((m) => m.id)).toEqual(["match_3", "match_2", "match_1"]);

      const alphas = await store.listMatches({ agentId: "agent_alpha" });
      expect(alphas.map((m) => m.id).sort()).toEqual(["match_1", "match_2"]);

      expect((await store.listMatches({ limit: 2 })).length).toBe(2);
      expect((await store.listMatches({ status: "pending" })).length).toBe(0);
      expect((await store.listMatches({ taskId: "task_rate_limiter" })).length).toBe(3);
    });

    it("stores events in sequence order", async () => {
      const events = [3, 1, 2].map((seq) => ({
        id: `e${seq}`,
        seq,
        t: seq * 10,
        type: "agent.message",
        step: 0,
        label: `event ${seq}`,
      })) as Parameters<ArenaStore["saveEvents"]>[1];

      await store.saveEvents("match_1", events);
      const read = await store.getEvents("match_1");
      expect(read.map((e) => e.seq)).toEqual([1, 2, 3]);
      expect(typeof read[0]!.t).toBe("number");
    });

    it("appends more events without losing the earlier ones", async () => {
      await store.saveEvents("match_1", [
        { id: "e4", seq: 4, t: 40, type: "match.completed", step: 0, label: "done" },
      ] as Parameters<ArenaStore["saveEvents"]>[1]);
      const read = await store.getEvents("match_1");
      expect(read.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    });

    it("orders a rating board by rating descending", async () => {
      const rating = (agentId: string, value: number): Rating => ({
        agentId,
        seasonId: "season_1",
        scope: "overall",
        rating: value,
        games: 4,
        wins: 2,
        losses: 1,
        draws: 1,
        peak: value,
        updatedAt: 1_770_000_000_000,
      });
      const ratings = [
        rating("agent_alpha", 1180),
        rating("agent_bravo", 1320),
        rating("agent_charlie", 1240),
      ];
      for (const r of ratings) await store.saveRating(r);

      const board = await store.listRatings("season_1", "overall");
      expect(board.map((r) => r.agentId)).toEqual(["agent_bravo", "agent_charlie", "agent_alpha"]);
      expect(typeof board[0]!.rating).toBe("number");

      // Saving again must update in place, not duplicate the row.
      await store.saveRating({ ...ratings[0]!, rating: 1400 });
      const after = await store.listRatings("season_1", "overall");
      expect(after.length).toBe(3);
      expect(after[0]!.agentId).toBe("agent_alpha");
    });

    it("prefers the active season, and falls back to the newest", async () => {
      expect((await store.activeSeason()).id).toBe("season_1");
      await store.saveSeason(season(2, "upcoming"));
      expect((await store.activeSeason()).id).toBe("season_1");

      await store.saveSeason(season(1, "closed"));
      expect((await store.activeSeason()).id).toBe("season_2");
    });

    it("keeps one vote per viewer and lets them change it", async () => {
      const votes = store as unknown as VoteCapable;
      await votes.castVote("match_1", "viewer_1", "A");
      await votes.castVote("match_1", "viewer_2", "A");
      await votes.castVote("match_1", "viewer_1", "B"); // changed their mind

      const tally = await votes.getVotes("match_1", "viewer_1");
      expect(tally).toEqual({ A: 1, B: 1, mine: "B" });

      const anonymous = await votes.getVotes("match_1");
      expect(anonymous.mine).toBeNull();
      expect(await votes.getVotes("match_never_voted")).toEqual({ A: 0, B: 0, mine: null });
    });
  });
}

rmSync(".data-store-test", { recursive: true, force: true });
suite("file", () => new FileStore(".data-store-test"));

if (PG_URL) {
  const pg = new PostgresStore(PG_URL);
  suite("postgres", () => pg, {
    reset: async () => {
      await pg.truncateAll();
    },
    cleanup: async () => {
      await pg.close();
    },
  });
} else {
  describe.skip("postgres driver (set TEST_DATABASE_URL to run)", () => {
    it("skipped", () => {});
  });
}
