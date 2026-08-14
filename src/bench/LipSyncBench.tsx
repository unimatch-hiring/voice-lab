import { useCallback, useEffect, useRef, useState } from "react";
import { Mouth } from "../scene/Mouth";
import { Desmoother, mouthLevel, resampleToSdkLayout } from "../lib/mouthLevel";
import { shapeOf } from "../lib/mouthShape";
import "../scene/tokens.css";
import "./bench.css";

/**
 * A microphone-free bench for the mouth: recorded speech replayed through the same
 * path the live session uses.
 *
 * Lip sync is the one thing here that cannot be judged from an assertion — it
 * either reads as speech or it does not. Before this, checking a change meant
 * holding a conversation and trusting the memory of the last one, which is why
 * every defect arrived as "sometimes". Here the input is a file, so two runs differ
 * only by the code between them.
 *
 * `?bench` — dev only, not linked from the instrument.
 */

interface Fixture {
  text: string;
  audio: string;
}

const FIXTURES = [
  { id: "ru-long", label: "sentence with pauses" },
  { id: "ru-plosives", label: "labials: p / b / m" },
  { id: "ru-vowels", label: "held vowels" },
];

export function LipSyncBench() {
  const [fixtureId, setFixtureId] = useState(FIXTURES[0].id);
  const [fixture, setFixture] = useState<Fixture | null>(null);
  const [playing, setPlaying] = useState(false);
  /** Cuts the signal mid-word, the way a dropped connection does. */
  const [killed, setKilled] = useState(false);
  const [readout, setReadout] = useState({ level: 0, shape: "—", frame: "—", rate: 0 });

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioCtx = useRef<AudioContext | null>(null);
  const analyser = useRef<AnalyserNode | null>(null);
  const fft = useRef(new Uint8Array(new ArrayBuffer(0)));
  const live = useRef(false);
  // Same conditioning the live session applies, so the readout is the mouth's input.
  const sharpen = useRef(new Desmoother());
  /**
   * The last spectrum the mouth was handed.
   *
   * The readout reads this instead of calling the source again: the conditioning is
   * a filter with state that expects to see every frame exactly once, and a second
   * caller at 10 Hz advanced it out of step with the animation.
   */
  const lastSpectrum = useRef<Uint8Array | null>(null);
  const dead = useRef(false);
  /** Frame changes in the last second, so the articulation rate is a number. */
  const changes = useRef<number[]>([]);
  const frame = useRef("rest");

  useEffect(() => {
    let alive = true;
    fetch(`${import.meta.env.BASE_URL}fixtures/fx-${fixtureId}.json`)
      .then((r) => r.json())
      .then((f: Fixture) => alive && setFixture(f));
    return () => {
      alive = false;
    };
  }, [fixtureId]);

  // The same shape the live session hands the mouth: a spectrum, or null when there
  // is nothing playing to measure.
  const source = useCallback((): Uint8Array | null => {
    const node = analyser.current;
    const ctx = audioCtx.current;
    if (!node || !ctx || !live.current || dead.current) {
      lastSpectrum.current = null;
      return null;
    }
    node.getByteFrequencyData(fft.current);
    lastSpectrum.current = sharpen.current.apply(
      resampleToSdkLayout(fft.current, ctx.sampleRate),
    );
    return lastSpectrum.current;
  }, []);

  // Read the DOM rather than instrument the component: what is measured here is
  // exactly what a viewer sees, and the mouth stays unaware it is being watched.
  useEffect(() => {
    const id = setInterval(() => {
      const lit = [...document.querySelectorAll<HTMLImageElement>(".mouth-stack img")].find(
        (el) => Number(el.style.opacity) > 0,
      );
      const name = lit?.getAttribute("src")?.split("/").pop()?.replace(".png", "");
      const now = performance.now();
      if (name && name !== frame.current) {
        frame.current = name;
        changes.current.push(now);
      }
      changes.current = changes.current.filter((t) => now - t < 1000);
    }, 16);
    return () => clearInterval(id);
  }, []);

  // A readout at 10 Hz. Sampling per frame would be a React render per frame, which
  // is the one thing the scene may not do.
  useEffect(() => {
    const id = setInterval(() => {
      const spectrum = lastSpectrum.current;
      setReadout({
        level: spectrum ? mouthLevel(spectrum) : 0,
        shape: spectrum ? shapeOf(spectrum) : "—",
        frame: frame.current,
        rate: changes.current.length,
      });
    }, 100);
    return () => clearInterval(id);
  }, []);

  const play = async () => {
    const audio = audioRef.current;
    if (!audio || !fixture) return;

    if (!audioCtx.current) {
      const ctx = new AudioContext();
      const node = ctx.createAnalyser();
      // Matching the SDK's own analyser, so the numbers here are the numbers there.
      node.fftSize = 2048;
      node.smoothingTimeConstant = 0.8;
      ctx.createMediaElementSource(audio).connect(node);
      node.connect(ctx.destination);
      audioCtx.current = ctx;
      analyser.current = node;
      fft.current = new Uint8Array(new ArrayBuffer(node.frequencyBinCount));
    }
    await audioCtx.current.resume();

    audio.currentTime = 0;
    dead.current = false;
    setKilled(false);
    live.current = true;
    await audio.play();
    setPlaying(true);
  };

  const stop = () => {
    audioRef.current?.pause();
    live.current = false;
    setPlaying(false);
  };

  return (
    <main className="shell">
      <header className="masthead">
        <h1>lip-sync bench</h1>
        <p>
          Recorded speech instead of a microphone, down the same path as a live
          session: the spectrum of the audio playing picks the shape and how far the
          mouth opens. Same input every run, so “it sometimes jitters” becomes
          reproducible.
        </p>
      </header>

      <section className="panel">
        <div className="panel-head">
          <span className="mode" data-live={playing && !killed}>
            {killed ? "signal cut" : playing ? "playing" : "idle"}
          </span>
          <span className="spacer" />
          <span>fixture replay</span>
        </div>

        <div className="panel-body">
          <div className="transport">
            <button className="talk" onClick={playing ? stop : play} disabled={!fixture}>
              {playing ? "Stop" : "Play"}
            </button>

            <label className="bench-field">
              <span>fixture</span>
              <select value={fixtureId} onChange={(e) => setFixtureId(e.target.value)}>
                {FIXTURES.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="button"
              className="bench-cut"
              onClick={() => {
                dead.current = !dead.current;
                setKilled(dead.current);
              }}
            >
              {killed ? "restore signal" : "cut the signal"}
            </button>

            <span className="hint">
              Cutting it mid-word is what a dropped connection does — the mouth has to
              shut, not freeze.
            </span>
          </div>

          <div className="run">
            <div className="run-left">
              <dl className="bench-readout">
                <dt>level</dt>
                <dd>
                  <div className="bench-meter">
                    <i style={{ width: `${Math.min(100, readout.level * 100)}%` }} />
                  </div>
                  <code>{readout.level.toFixed(3)}</code>
                </dd>

                <dt>shape</dt>
                <dd>
                  <code>{readout.shape}</code>
                </dd>

                <dt>frame</dt>
                <dd>
                  <code>{readout.frame}</code>
                </dd>

                <dt>rate</dt>
                <dd>
                  <code>{readout.rate}</code>
                  <span className="hint">changes/s — speech articulates at ~8–14</span>
                </dd>
              </dl>

              <p className="bench-phrase">{fixture?.text}</p>
            </div>

            <Mouth source={source} />
          </div>
        </div>
      </section>

      <audio
        ref={audioRef}
        src={fixture ? `${import.meta.env.BASE_URL}fixtures/${fixture.audio}` : undefined}
        onEnded={stop}
        preload="auto"
      />
    </main>
  );
}
