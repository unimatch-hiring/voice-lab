import type { ReactNode } from "react";
import { slowestStage } from "../lib/stageTiming";
import type { StageName, TurnMetrics } from "../lib/types";

/**
 * One turn as per-stage shares of its wall-clock time: a row per measured stage in `order`,
 * the slowest marked. Stages overlap, so a share can pass 100% — the bar stops at the end of
 * its track while the percentage keeps the real number.
 */
export function StageShares({
  label,
  stages,
  totalMs,
  order,
  className,
  children,
}: {
  label: string;
  stages: TurnMetrics["stages"];
  totalMs: number;
  order: readonly StageName[];
  className?: string;
  children: ReactNode;
}) {
  const measured = order.filter((stage) => stages[stage] !== undefined);
  const slowest = slowestStage(stages, order);

  return (
    <div className={className ? `breakdown ${className}` : "breakdown"}>
      <div className="breakdown-head">
        <span>{label}</span>
        <span className="spacer" />
        <span className="breakdown-total">
          <b className="readout">{Math.round(totalMs)}</b> ms end to end
        </span>
      </div>

      <ol className="breakdown-rows">
        {measured.map((stage) => {
          const ms = stages[stage] ?? 0;
          const share = totalMs > 0 ? ms / totalMs : 0;
          return (
            <li key={stage} data-slowest={stage === slowest}>
              <span className="breakdown-name">{stage}</span>
              <span className="breakdown-track">
                <span
                  className="breakdown-bar"
                  style={{
                    width: `${Math.min(100, share * 100).toFixed(2)}%`,
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

      <p className="breakdown-foot">{children}</p>
    </div>
  );
}
