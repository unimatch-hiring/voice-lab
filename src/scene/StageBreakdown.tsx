import { slowestStage } from "../lib/stageTiming";
import { STAGE_ORDER, type TurnMetrics } from "../lib/types";
import { StageShares } from "./StageShares";

/**
 * What the finished turn actually cost, per stage.
 *
 * The waterfall above scrolls a 6-second window, so a completed run slides out of
 * it within seconds and the screen goes blank again. For a product whose whole
 * claim is honest per-stage timings, the numbers have to survive the run — this is
 * where they land.
 *
 * Bars are shares of the turn's wall-clock time, not absolute milliseconds: the interesting
 * thing is which stage dominates a turn, and that reads instantly from width. Stages overlap,
 * so the shares can add up to more than 100%.
 */
export function StageBreakdown({ metrics }: { metrics: TurnMetrics | null }) {
  if (!metrics) {
    return (
      <p className="breakdown-empty">
        Say something and the per-stage timings land here.
      </p>
    );
  }

  const slowest = slowestStage(metrics.stages, STAGE_ORDER);

  // totalMs is not the sum of the stages: they overlap, and the sum counts that time twice.
  return (
    <StageShares label="this turn" stages={metrics.stages} totalMs={metrics.totalMs} order={STAGE_ORDER}>
      {slowest} dominated this turn. {metrics.llmTokens} tokens generated, {metrics.ttsChars}{" "}
      characters spoken.
    </StageShares>
  );
}
