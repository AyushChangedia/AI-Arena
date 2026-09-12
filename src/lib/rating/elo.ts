import type { Outcome, RatingSystem, RatingUpdate } from "./types";

/**
 * Elo. K = 32, seeded at 1200.
 *
 *   expectedA = 1 / (1 + 10^((ratingB − ratingA) / 400))
 *   ratingA'  = ratingA + K × (scoreA − expectedA)
 */
export class EloRatingSystem implements RatingSystem {
  readonly id = "elo";
  readonly label = "Elo";
  readonly initialRating = 1200;

  constructor(private k = 32) {}

  expected(ratingA: number, ratingB: number): number {
    return 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
  }

  update(ratingA: number, ratingB: number, outcome: Outcome): { a: RatingUpdate; b: RatingUpdate } {
    const scoreA = outcome === "win" ? 1 : outcome === "draw" ? 0.5 : 0;
    const expectedA = this.expected(ratingA, ratingB);
    const expectedB = 1 - expectedA;

    const afterA = Math.round(ratingA + this.k * (scoreA - expectedA));
    const afterB = Math.round(ratingB + this.k * (1 - scoreA - expectedB));

    return {
      a: { before: ratingA, after: afterA, delta: afterA - ratingA },
      b: { before: ratingB, after: afterB, delta: afterB - ratingB },
    };
  }
}

let cached: RatingSystem | null = null;

export function ratingSystem(): RatingSystem {
  cached ??= new EloRatingSystem();
  return cached;
}
