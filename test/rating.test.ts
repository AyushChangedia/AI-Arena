import { describe, expect, it } from "vitest";
import { EloRatingSystem, ratingSystem } from "@/lib/rating/elo";

describe("EloRatingSystem", () => {
  const elo = new EloRatingSystem(32);

  it("gives even odds to equal ratings", () => {
    expect(elo.expected(1200, 1200)).toBeCloseTo(0.5, 10);
  });

  it("favours the higher-rated side", () => {
    expect(elo.expected(1400, 1200)).toBeGreaterThan(0.5);
    expect(elo.expected(1200, 1400)).toBeLessThan(0.5);
  });

  it("treats a 400-point gap as roughly ten-to-one", () => {
    expect(elo.expected(1600, 1200)).toBeCloseTo(10 / 11, 3);
  });

  it("moves both ratings in opposition on a win", () => {
    const { a, b } = elo.update(1200, 1200, "win");
    expect(a.delta).toBe(16);
    expect(b.delta).toBe(-16);
    expect(a.after).toBe(1216);
    expect(b.after).toBe(1184);
  });

  it("is zero-sum", () => {
    for (const [ra, rb] of [
      [1200, 1200],
      [1500, 1100],
      [1000, 1900],
    ] as const) {
      for (const outcome of ["win", "loss", "draw"] as const) {
        const { a, b } = elo.update(ra, rb, outcome);
        expect(Math.abs(a.delta + b.delta), `${ra}/${rb}/${outcome}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it("barely moves a heavy favourite that wins", () => {
    const { a } = elo.update(1900, 1100, "win");
    expect(a.delta).toBeLessThanOrEqual(1);
  });

  it("moves an underdog a long way when it wins", () => {
    const { a } = elo.update(1100, 1900, "win");
    expect(a.delta).toBeGreaterThan(28);
  });

  it("penalises a favourite that draws with an underdog", () => {
    const { a, b } = elo.update(1600, 1200, "draw");
    expect(a.delta).toBeLessThan(0);
    expect(b.delta).toBeGreaterThan(0);
  });

  it("leaves equal ratings unchanged on a draw", () => {
    const { a, b } = elo.update(1300, 1300, "draw");
    expect(a.delta).toBe(0);
    expect(b.delta).toBe(0);
  });

  it("respects the K factor", () => {
    const gentle = new EloRatingSystem(8).update(1200, 1200, "win");
    expect(gentle.a.delta).toBe(4);
  });

  it("returns integers so stored ratings never drift into floats", () => {
    const { a, b } = elo.update(1237, 1411, "win");
    expect(Number.isInteger(a.after)).toBe(true);
    expect(Number.isInteger(b.after)).toBe(true);
  });

  it("exposes a stable process-wide instance seeded at 1200", () => {
    expect(ratingSystem().initialRating).toBe(1200);
    expect(ratingSystem()).toBe(ratingSystem());
  });

  it("converges toward a true skill gap over repeated matches", () => {
    // A consistently stronger agent should pull away, and the gap should
    // stabilise rather than grow without bound.
    let strong = 1200;
    let weak = 1200;
    for (let i = 0; i < 60; i++) {
      const { a, b } = elo.update(strong, weak, "win");
      strong = a.after;
      weak = b.after;
    }
    expect(strong).toBeGreaterThan(weak);
    const gapAfter60 = strong - weak;

    for (let i = 0; i < 60; i++) {
      const { a, b } = elo.update(strong, weak, "win");
      strong = a.after;
      weak = b.after;
    }
    // Growth decelerates sharply once the expectation is near 1.
    expect(strong - weak - gapAfter60).toBeLessThan(gapAfter60);
  });
});
