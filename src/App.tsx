import { useEffect, useMemo, useRef, useState } from "react";
import { EventBus } from "./lib/events";
import { Orchestrator } from "./lib/pipeline/orchestrator";
import { PlaybackQueue } from "./lib/pipeline/playback";
import { Recorder } from "./lib/pipeline/capture";
import { EnergyVad } from "./lib/pipeline/vad";
import { createTransport } from "./lib/transport";
import { transcribe } from "./lib/pipeline/stt";
import { respond } from "./lib/pipeline/llm";
import { synthesize } from "./lib/pipeline/tts";
import { FIXTURES, offlineStages } from "./lib/fixtures";
import { loadConfig } from "./lib/config";
import { loadToken, saveToken } from "./lib/tokenStore";
import { Waterfall } from "./scene/Waterfall";
import { Mouth } from "./scene/Mouth";
import "./scene/tokens.css";

export function App() {
  // Токен приходит из IndexedDB, то есть асинхронно, — поэтому конфиг живёт в
  // состоянии. Первый рендер идёт в офлайне и переключается на живой режим, как
  // только токен прочитан.
  const [storedToken, setStoredToken] = useState("");
  const [tokenReady, setTokenReady] = useState(false);
  const config = useMemo(() => loadConfig(storedToken), [storedToken]);

  useEffect(() => {
    let alive = true;
    loadToken().then((t) => {
      if (!alive) return;
      setStoredToken(t);
      setTokenReady(true);
    });
    return () => {
      alive = false;
    };
  }, []);
  const bus = useMemo(() => new EventBus(), []);
  const playback = useMemo(
    () => new PlaybackQueue(new AudioContext() as never),
    [],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Живой вход: уровень идёт в сцену на каждый кадр, VAD размечает границы речи
  // как стадии capture и vad. Без этого две полосы конвейера остаются пустыми.
  const recorder = useMemo(() => {
    const vad = new EnergyVad();
    return new Recorder({
      onFrame: ({ samples, rms, at }) => {
        bus.emit({ type: "audio-level", rms, at });
        const event = vad.push(samples);
        if (event === "speech-start") {
          bus.emit({ type: "stage-start", stage: "vad", at });
        } else if (event === "speech-end") {
          bus.emit({ type: "stage-end", stage: "vad", at, ttfbMs: 0 });
        }
      },
    });
  }, [bus]);

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
        bus.emit({ type: "stage-start", stage: "capture", at: performance.now() });
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
      let audio: Blob;
      if (config.offline) {
        audio = new Blob([]);
      } else {
        audio = await recorder.stop();
        bus.emit({ type: "stage-end", stage: "capture", at: performance.now(), ttfbMs: 0 });
      }
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
        <p style={{ color: "var(--fail)", fontSize: 13 }}>{error}</p>
      )}

      {tokenReady && <TokenGate token={storedToken} onChange={setStoredToken} />}

      <div style={{ marginTop: 24 }}>
        <Waterfall bus={bus} />
      </div>

      <div style={{ marginTop: 20, display: "flex", justifyContent: "center" }}>
        <Mouth timeline={orch.timeline} playback={playback} />
      </div>
    </main>
  );
}

/**
 * Ввод клиентского токена прямо на странице. Публичная сборка приходит без
 * токена (иначе платная квота досталась бы каждому посетителю), поэтому живой
 * конвейер включается здесь — и на задеплоенном сайте, без локальной сборки.
 */
function TokenGate({
  token,
  onChange,
}: {
  token: string;
  onChange: (next: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  if (token) {
    return (
      <p style={{ fontSize: 13, color: "rgba(16,21,28,0.6)", marginTop: 12 }}>
        Живой режим включён.{" "}
        <button
          type="button"
          onClick={async () => {
            await saveToken("");
            onChange("");
          }}
          style={{
            border: 0,
            background: "none",
            padding: 0,
            font: "inherit",
            color: "var(--running)",
            cursor: "pointer",
            textDecoration: "underline",
          }}
        >
          отключить
        </button>
      </p>
    );
  }

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        const next = draft.trim();
        if (!next) return;
        setSaving(true);
        await saveToken(next);
        onChange(next);
        setSaving(false);
        setDraft("");
      }}
      style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center" }}
    >
      <input
        type="password"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="токен для живого режима"
        // Не autoComplete: это не пароль пользователя, менеджерам паролей его
        // предлагать незачем.
        autoComplete="off"
        spellCheck={false}
        style={{
          padding: "7px 10px",
          fontSize: 13,
          borderRadius: 6,
          border: "1px solid rgba(16,21,28,0.2)",
          width: 260,
        }}
      />
      <button
        type="submit"
        disabled={saving || !draft.trim()}
        style={{ padding: "7px 14px", fontSize: 13, borderRadius: 6, cursor: "pointer" }}
      >
        включить
      </button>
    </form>
  );
}
