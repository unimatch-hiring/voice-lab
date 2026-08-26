import { useEffect, useRef } from "react";
import { STAGE_ORDER, type StageName } from "../lib/types";
import type { EventBus } from "../lib/events";
import { TurnModel } from "./turnModel";

const WINDOW_MS = 6000;
const ROW_H = 26;
const ROW_GAP = 6;
const LABEL_W = 78;

const COLOR: Record<StageName, string> = {
  capture: "#4cc9f0",
  vad: "#4895ef",
  stt: "#4361ee",
  llm: "#7209b7",
  tts: "#b5179e",
  playback: "#f72585",
  gate: "#f9c74f",
  recall: "#f8961e",
  archive: "#43aa8b",
};

export function Waterfall({ bus }: { bus: EventBus }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const levelRef = useRef<HTMLDivElement>(null);
  const tokensRef = useRef<HTMLSpanElement>(null);
  const modelRef = useRef(new TurnModel());

  useEffect(() => bus.on((e) => modelRef.current.apply(e)), [bus]);

  useEffect(() => {
    const canvas = canvasRef.current!;
    // A 2D context is not guaranteed: jsdom has none, and a browser can refuse one when
    // too many canvases are live. Asserting it away threw inside the animation frame,
    // where nothing catches it — the run failed with tests green.
    //
    // So under test this effect returns here and the loop never runs: assert on
    // `TurnModel`, which the subscription above feeds either way, not on the canvas.
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;
    const model = modelRef.current;
    let raf = 0;
    let smooth = 0;
    let lastTokens = -1;

    // Canvas cannot use CSS variables, so read the resolved tokens once per frame
    // batch — otherwise the plot stays light-themed on a dark page.
    const css = getComputedStyle(canvas);
    const token = (name: string, fallback: string) =>
      css.getPropertyValue(name).trim() || fallback;

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const now = performance.now();
      model.prune(now, WINDOW_MS);

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = canvas.clientWidth;
      const h = STAGE_ORDER.length * (ROW_H + ROW_GAP) + 8;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        canvas.style.height = `${h}px`;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = token("--rack", "#151b24");
      ctx.fillRect(0, 0, w, h);

      const plotX = LABEL_W;
      const plotW = Math.max(1, w - LABEL_W - 8);
      const t0 = now - WINDOW_MS;
      const xOf = (t: number) => plotX + ((t - t0) / WINDOW_MS) * plotW;

      ctx.font = "11px ui-monospace, Menlo, monospace";
      ctx.textBaseline = "middle";
      const active = model.activeStage;
      STAGE_ORDER.forEach((stage, i) => {
        const y = i * (ROW_H + ROW_GAP) + 4;
        ctx.fillStyle = token("--rack-sunken", "#0f141b");
        ctx.fillRect(plotX, y, plotW, ROW_H);
        ctx.fillStyle = stage === active ? COLOR[stage] : token("--rack-dim", "#8b95a5");
        ctx.fillText(stage, 8, y + ROW_H / 2);
      });

      for (const span of model.visible(now, WINDOW_MS)) {
        const i = STAGE_ORDER.indexOf(span.stage);
        const y = i * (ROW_H + ROW_GAP) + 4;
        const x1 = Math.max(plotX, xOf(span.start));
        const x2 = Math.min(plotX + plotW, xOf(span.end ?? now));
        if (x2 <= plotX) continue;
        ctx.fillStyle = COLOR[span.stage];
        ctx.globalAlpha = span.end === null ? 1 : 0.5;
        ctx.fillRect(x1, y + 3, Math.max(2, x2 - x1), ROW_H - 6);
        ctx.globalAlpha = 1;
      }

      // The "now" cursor — the right edge of the window.
      ctx.strokeStyle = token("--rack-edge", "#263041");
      ctx.beginPath();
      ctx.moveTo(Math.round(xOf(now)) + 0.5, 0);
      ctx.lineTo(Math.round(xOf(now)) + 0.5, h);
      ctx.stroke();

      // Level and counter are written straight to the DOM, bypassing React.
      const level = model.level;
      smooth += (level - smooth) * (level > smooth ? 0.5 : 0.12);
      if (levelRef.current) levelRef.current.style.transform = `scaleX(${smooth.toFixed(4)})`;
      if (tokensRef.current && model.tokens !== lastTokens) {
        lastTokens = model.tokens;
        tokensRef.current.textContent = String(model.tokens);
      }
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="wf-plot">
      <div className="wf-meta">
        <span>input</span>
        <span className="wf-level"><span ref={levelRef} className="wf-level-fill" /></span>
        <span>tokens <b className="readout" ref={tokensRef}>0</b></span>
      </div>
      <canvas ref={canvasRef} className="wf-canvas" />
    </div>
  );
}
