export type Outcome = "win" | "loss" | "draw";

export interface RatingUpdate {
  before: number;
  after: number;
  delta: number;
}

/**
 * A ranking system takes two ratings and an outcome and returns two new
 * ratings. It touches no database and knows nothing about matches, which is
 * what makes Glicko-2 or TrueSkill additive rather than invasive.
 */
export interface RatingSystem {
  readonly id: string;
  readonly label: string;
  readonly initialRating: number;
  update(
    ratingA: number,
    ratingB: number,
    outcome: Outcome,
  ): { a: RatingUpdate; b: RatingUpdate };
}
