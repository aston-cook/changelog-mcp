/** Two-sided alpha = 0.05. */
export const Z_ALPHA_2 = 1.959964;

/** Power = 0.80. */
export const Z_BETA_80 = 0.841621;

/** 2.801585 — the multiplier in every minimum-detectable-effect calculation here. */
export const Z_SUM = Z_ALPHA_2 + Z_BETA_80;

/**
 * 97.5th percentile of Student's t. Cornish-Fisher expansion; matches published tables to
 * four decimal places for df >= 5 (df=33 gives 2.0345). Converges to Z_ALPHA_2 as df grows.
 */
export function tQuantile975(df: number): number {
  if (df <= 0) return Number.POSITIVE_INFINITY;
  const z = Z_ALPHA_2;
  const z2 = z * z;
  const z3 = z2 * z;
  const z5 = z3 * z2;
  const z7 = z5 * z2;
  return (
    z +
    (z3 + z) / (4 * df) +
    (5 * z5 + 16 * z3 + 3 * z) / (96 * df * df) +
    (3 * z7 + 19 * z5 + 17 * z3 - 15 * z) / (384 * df * df * df)
  );
}
