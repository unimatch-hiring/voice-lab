import { useEffect, useMemo, useRef, useState } from "react";
import { EventBus } from "./lib/events";
import { Orchestrator } from "./lib/pipeline/orchestrator";
import { PlaybackQueue } from "./lib/pipeline/playback";
import { Recorder } from "./lib/pipeline/capture";
import { createTransport } from "./lib/transport";
import { transcribe } from "./lib/pipeline/stt";
import { respond } from "./lib/pipeline/llm";
import { synthesize } from "./lib/pipeline/tts";
import { FIXTURES, offlineStages } from "./lib/fixtures";
import { loadConfig } from "./lib/config";
import { Waterfall } from "./scene/Waterfall";
import { Mouth } from "./scene/Mouth";
import "./scene/tokens.css";

export function App() {
  const config = useMemo(loadConfig, []);
  const bus = useMemo(() => new EventBus(), []);
  const playback = useMemo(
    () => new PlaybackQueue(new AudioContext() as never),
    [],
  );
  const recorder = useMemo(() => new Recorder(), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const orch = useMemo(() => {
    if (config.offline) {
      return new Orchestrator({ bus, playback, ...offlineStages(FIXTURES[0]) });
    }
    const transport = createTransport({
      workerUrl: config.workerUrl,
      vibeToken: config.vibeToken,
    });
    return new Orchestrator({
      bus,
      playback,
      transcribe: (audio) => transcribe(audio, { transport }),
      respond: (text, opts) => respond(text, { transport, history: opts.history }),
      synthesize: (text) => synthesize(text, { transport }),
    });
  }, [bus, playback, config]);

  const holding = useRef(false);

  const start = async () => {
    if (holding.current) return;
    holding.current = true;
    setError(null);
    // Оффлайн-турн не запускаем здесь: setBusy(true) до mouseup успевает
    // выставить disabled на кнопке, и браузер съедает mouseup — держать
    // не отпустить. Турн запускается из stop(), как и в живом режиме.
    if (!config.offline) {
      try {
        await recorder.start();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        holding.current = false;
      }
    }
  };

  const stop = async () => {
    if (!holding.current) return;
    holding.current = false;
    setBusy(true);
    try {
      const audio = config.offline ? new Blob([]) : await recorder.stop();
      await orch.runTurn(audio);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => () => playback.stop(), [playback]);

  return (
    <main style={{ maxWidth: 860, margin: "0 auto", padding: "32px 20px" }}>
      <h1 style={{ fontSize: 20, margin: "0 0 4px" }}>voice-lab</h1>
      <p style={{ color: "rgba(16,21,28,0.6)", marginTop: 0 }}>
        Скажи фразу и посмотри, как она течёт по конвейеру голосового агента.
        {config.offline && " Сейчас офлайн-режим: играют записанные фикстуры."}
      </p>

      <button
        onMouseDown={start}
        onMouseUp={stop}
        onMouseLeave={stop}
        disabled={busy}
        style={{ padding: "10px 18px", fontSize: 15, borderRadius: 8, cursor: "pointer" }}
      >
        {busy ? "обработка…" : config.offline ? "прогнать фикстуру" : "держи и говори"}
      </button>

      {error && (
        <p style={{ color: "var(--fail)", fontSize: 13 }}>
          {error} — конвейер переключён на фикстуры, собес продолжается.
        </p>
      )}

      <div style={{ marginTop: 24 }}>
        <Waterfall bus={bus} />
      </div>

      <div style={{ marginTop: 20, display: "flex", justifyContent: "center" }}>
        <Mouth timeline={orch.timeline} playback={playback} />
      </div>
    </main>
  );
}
