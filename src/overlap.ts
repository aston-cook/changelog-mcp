export interface OverlapCandidate {
  annotationId: number;
  date: string;
}

const DAY_MS = 86_400_000;

/**
 * Two logged changes overlap when their evaluation windows intersect AND they resolve to the
 * same metric. When they do, neither can be graded: whatever the metric did, there is no way
 * to attribute it to one change rather than the other. Both are refused.
 *
 * Changes on different metrics in the same week do not overlap — they are independently
 * gradeable, which is the main reason the metric ladder resolves per change.
 */
export function findOverlaps(
  changes: OverlapCandidate[],
  metricByChangeId: Map<number, string>,
  windowDays: number,
): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const c of changes) out.set(c.annotationId, []);

  for (let i = 0; i < changes.length; i++) {
    for (let j = i + 1; j < changes.length; j++) {
      const a = changes[i]!;
      const b = changes[j]!;

      const metricA = metricByChangeId.get(a.annotationId);
      const metricB = metricByChangeId.get(b.annotationId);
      if (!metricA || !metricB || metricA !== metricB) continue;

      const gapDays = Math.abs(Date.parse(a.date) - Date.parse(b.date)) / DAY_MS;
      if (gapDays >= windowDays) continue;

      out.get(a.annotationId)!.push(b.annotationId);
      out.get(b.annotationId)!.push(a.annotationId);
    }
  }

  return out;
}
