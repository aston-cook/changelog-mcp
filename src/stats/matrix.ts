export class SingularMatrixError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SingularMatrixError';
  }
}

/**
 * Gauss-Jordan inversion with partial pivoting.
 *
 * Throws SingularMatrixError rather than returning NaN so the caller can degrade to
 * "cannot tell yet". A singular design matrix here means the series does not identify the
 * model — for example a window too short to see every day of the week — and the honest
 * response is to refuse a verdict, not to print a number built from NaN.
 */
export function invert(A: number[][]): number[][] {
  const n = A.length;
  if (n === 0) throw new SingularMatrixError('empty matrix');

  let scale = 0;
  for (const row of A) {
    for (const v of row) scale = Math.max(scale, Math.abs(v));
  }
  if (scale === 0) throw new SingularMatrixError('all-zero matrix');
  const tol = 1e-10 * scale;

  const M: number[][] = A.map((row, i) => [
    ...row,
    ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  ]);

  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r]![col]!) > Math.abs(M[piv]![col]!)) piv = r;
    }
    if (Math.abs(M[piv]![col]!) < tol) {
      throw new SingularMatrixError(
        `design matrix is rank deficient at column ${col} — the series does not identify the model`,
      );
    }
    [M[col], M[piv]] = [M[piv]!, M[col]!];

    const p = M[col]![col]!;
    for (let j = 0; j < 2 * n; j++) M[col]![j]! /= p;

    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r]![col]!;
      if (f === 0) continue;
      for (let j = 0; j < 2 * n; j++) M[r]![j]! -= f * M[col]![j]!;
    }
  }

  return M.map((row) => row.slice(n));
}

export function matVec(A: number[][], v: number[]): number[] {
  return A.map((row) => row.reduce((s, x, k) => s + x * v[k]!, 0));
}
