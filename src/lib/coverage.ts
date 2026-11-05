/**
 * Milliseconds covered by at least one of the intervals. Stages overlap — recognition runs
 * inside capture, synthesis inside playback — so adding their durations counts the same
 * wall-clock time more than once.
 */
export function coveredMs(intervals: readonly (readonly [number, number])[]): number {
  const sorted = [...intervals].filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let total = 0;
  let reach = -Infinity;
  for (const [start, end] of sorted) {
    if (end <= reach) continue;
    total += end - Math.max(start, reach);
    reach = end;
  }
  return total;
}
