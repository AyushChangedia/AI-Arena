import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { isViewerId, mintViewerId, owns } from "@/lib/server/identity";

/**
 * The viewer id is a bearer capability: whoever holds it acts as that viewer.
 * That makes two properties load-bearing — it has to be unguessable, and a
 * caller must never be able to pass something that merely looks like one.
 */

describe("viewer identity", () => {
  it("mints ids that validate", () => {
    for (let i = 0; i < 50; i++) expect(isViewerId(mintViewerId())).toBe(true);
  });

  it("mints a distinct id every time", () => {
    const ids = new Set(Array.from({ length: 500 }, mintViewerId));
    expect(ids.size).toBe(500);
  });

  it("carries enough entropy to be unguessable", () => {
    // 32 hex characters is 128 bits. Anything shorter and a viewer id becomes
    // something an attacker can enumerate rather than something they must steal.
    const id = mintViewerId();
    expect(id).toMatch(/^v_[0-9a-f]{32}$/);
    expect(id.length - 2).toBe(32);
  });

  it("rejects anything that is not a minted id", () => {
    const attempts = [
      undefined,
      null,
      "",
      "v_",
      "user_local",
      "v_short",
      `v_${"g".repeat(32)}`, // not hex
      `v_${"a".repeat(31)}`, // too short
      `v_${"a".repeat(33)}`, // too long
      `V_${"a".repeat(32)}`, // wrong case prefix
      ` v_${"a".repeat(32)}`,
      `v_${"a".repeat(32)}\n`,
      `v_${"a".repeat(32)}; admin`,
    ];
    for (const value of attempts) {
      expect(isViewerId(value), String(value)).toBe(false);
    }
  });

  it("grants access only to the exact owner", () => {
    const mine = mintViewerId();
    const theirs = mintViewerId();
    expect(owns(mine, mine)).toBe(true);
    expect(owns(mine, theirs)).toBe(false);
  });

  it("never grants access to a request with no identity", () => {
    // The gap that matters: an unidentified caller must not inherit ownership
    // of anything, including a record whose owner is somehow empty.
    expect(owns("anyone", null)).toBe(false);
    expect(owns("", null)).toBe(false);
  });
});

describe("agent mutations are authorised", () => {
  const route = readFileSync("src/app/api/agents/[id]/route.ts", "utf8");

  it("checks ownership before editing or deleting", () => {
    const handlers = route.split(/export async function /).filter((s) => /^(PATCH|DELETE)/.test(s));
    expect(handlers).toHaveLength(2);
    for (const handler of handlers) {
      const name = handler.slice(0, handler.indexOf("("));
      expect(handler, `${name} must check ownership`).toMatch(/owns\(\s*agent\.ownerId/);
      expect(handler, `${name} must reject non-owners`).toMatch(/fail\("forbidden"/);
    }
  });

  it("never writes a shared hardcoded owner onto a new agent", () => {
    // Everything used to be created under one constant, which meant every
    // visitor could edit every other visitor's agents.
    const create = readFileSync("src/app/api/agents/route.ts", "utf8");
    expect(create).not.toMatch(/ownerId:\s*OWNER_ID/);
    expect(create).toMatch(/ownerId:\s*owner/);
    expect(create).toMatch(/viewerId\(\)/);
  });

  it("mints identity in the proxy, not in a route that could be bypassed", () => {
    const proxy = readFileSync("src/proxy.ts", "utf8");
    expect(proxy).toMatch(/mintViewerId\(\)/);
    // httpOnly keeps the capability out of reach of any script on the page.
    expect(proxy).toMatch(/httpOnly:\s*true/);
    expect(proxy).toMatch(/sameSite:\s*"lax"/);
    expect(proxy).toMatch(/secure:\s*process\.env\.NODE_ENV === "production"/);
  });
});
