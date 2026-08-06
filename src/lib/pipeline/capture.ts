/** Запись с микрофона. Отдаёт webm-блоб, который принимает Scribe. */
export class Recorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stream: MediaStream | null = null;

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
  }

  async stop(): Promise<Blob> {
    const recorder = this.recorder;
    if (!recorder) throw new Error("recorder is not running");

    const blob = await new Promise<Blob>((resolve) => {
      recorder.onstop = () => resolve(new Blob(this.chunks, { type: "audio/webm" }));
      recorder.stop();
    });

    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.recorder = null;
    this.stream = null;
    return blob;
  }
}
