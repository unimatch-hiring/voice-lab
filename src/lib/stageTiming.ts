import type { StageName, TurnMetrics } from "./types";

/** The stage in `order` with the largest measured time; the first wins a tie, null when none was measured. */
export function slowestStage(
  stages: TurnMetrics["stages"],
  order: readonly StageName[],
): StageName | null {
  let slowest: StageName | null = null;
  for (const stage of order) {
    const ms = stages[stage];
    if (ms === undefined) continue;
    if (slowest === null || ms > (stages[slowest] ?? 0)) slowest = stage;
  }
  return slowest;
}
