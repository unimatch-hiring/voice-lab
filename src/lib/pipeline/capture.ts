/** One microphone analysis frame: the window's samples and their RMS level. */
export interface CaptureFrame {
  samples: Float32Array;
  rms: number;
  at: number;
}

export interface RecorderOptions {
  /** Called about once per animation frame while recording. */
  onFrame?: (frame: CaptureFrame) => void;
}

/** Microphone recording. Returns a webm blob that Scribe accepts. */
export class Recorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private raf = 0;

  constructor(private opts: RecorderOptions = {}) {}

  get isRecording(): boolean {
    return this.recorder?.state === "recording";
  }

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream, { mimeType: "audio/webm" });
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.start(100);

    if (this.opts.onFrame) this.startAnalysis(this.stream, this.opts.onFrame);
  }

  /** Live input level: MediaRecorder only hands back a compressed blob, with no samples in it. */
  private startAnalysis(stream: MediaStream, onFrame: (f: CaptureFrame) => void): void {
    this.ctx = new AudioContext();
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 1024;
    this.ctx.createMediaStreamSource(stream).connect(analyser);

    const buf = new Float32Array(analyser.fftSize);
    const tick = () => {
      this.raf = requestAnimationFrame(tick);
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      onFrame({ samples: buf, rms: Math.sqrt(sum / buf.length), at: performance.now() });
    };
    this.raf = requestAnimationFrame(tick);
  }

  async stop(): Promise<Blob> {
    const recorder = this.recorder;
    // Reached when the press never opened the microphone — a denied permission, or a
    // click too quick for start() to finish.
    if (!recorder) throw new Error("The microphone did not start. Check the browser's permission and try again.");

    cancelAnimationFrame(this.raf);
    this.raf = 0;

    const blob = await new Promise<Blob>((resolve) => {
      recorder.onstop = () => resolve(new Blob(this.chunks, { type: "audio/webm" }));
      recorder.stop();
    });

    for (const track of this.stream?.getTracks() ?? []) track.stop();
    await this.ctx?.close().catch(() => {});
    this.recorder = null;
    this.stream = null;
    this.ctx = null;
    return blob;
  }
}
