import { STAGE_ORDER, type StageName, type TurnMetrics } from "../lib/types";

/**
 * What the finished turn actually cost, per stage.
 *
 * The waterfall above scrolls a 6-second window, so a completed run slides out of
 * it within seconds and the screen goes blank again. For a product whose whole
 * claim is honest per-stage timings, the numbers have to survive the run — this is
 * where they land.
 *
 * Bars are shares of the total, not absolute milliseconds: the interesting thing is
 * which stage dominates a turn, and that reads instantly from width.
 */
export function StageBreakdown({ metrics }: { metrics: TurnMetrics | null }) {
  if (!metrics) {
    return (
      <p className="breakdown-empty">
        Say something and the per-stage timings land here.
      </p>
    );
  }

  const measured = STAGE_ORDER.filter((s) => metrics.stages[s] !== undefined);
  const total = measured.reduce((sum, s) => sum + (metrics.stages[s] ?? 0), 0);
  const slowest = measured.reduce<StageName | null>(
    (worst, s) =>
      worst === null || (metrics.stages[s] ?? 0) > (metrics.stages[worst] ?? 0) ? s : worst,
    null,
  );

  return (
    <div className="breakdown">
      <div className="breakdown-head">
        <span>this turn</span>
        <span className="spacer" />
        <span className="breakdown-total">
          <b className="readout">{Math.round(total)}</b> ms end to end
        </span>
      </div>

      <ol className="breakdown-rows">
        {measured.map((stage) => {
          const ms = metrics.stages[stage] ?? 0;
          const share = total > 0 ? ms / total : 0;
          return (
            <li key={stage} data-slowest={stage === slowest}>
              <span className="breakdown-name">{stage}</span>
              <span className="breakdown-track">
                <span
                  className="breakdown-bar"
                  style={{
                    width: `${(share * 100).toFixed(2)}%`,
                    background: `var(--stage-${stage})`,
                  }}
                />
              </span>
              <span className="breakdown-ms readout">{Math.round(ms)}</span>
              <span className="breakdown-share readout">{Math.round(share * 100)}%</span>
            </li>
          );
        })}
      </ol>

      <p className="breakdown-foot">
        {slowest} dominated this turn. {metrics.llmTokens} tokens generated,{" "}
        {metrics.ttsChars} characters spoken.
      </p>
    </div>
  );
}
