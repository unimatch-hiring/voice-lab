import type { Engine } from "./pipeline/session";

/** The thinking move a training question should exercise. */
export type QuestionSkill = "replacement" | "homogeneous" | "any";

/** Whose level the questions are drawn for: one pack pool each in the Worker. */
export type QuestionAudience = "school" | "students";

/** A question from gotquestions.online, as the Worker picked it. */
export interface TrainingQuestion {
  id: number;
  text: string;
  answer: string;
  zachet: string | null;
  comment: string | null;
  /** Share of teams that took it, or null when it has not been played. */
  takePercent: number | null;
  url: string;
}

export interface TransportConfig {
  workerUrl: string;
  vibeToken: string;
}

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface Transport {
  /** Session token for ElevenLabs Agents; the API key stays in the Worker. */
  agentToken(): Promise<{ token: string; agentId: string }>;
  /** Short-lived Deepgram grant; it only has to be valid while the socket opens. */
  deepgramToken(): Promise<{ token: string }>;
  /** Which engine this key was set to in the admin page. */
  engine(): Promise<Engine>;
  /**
   * One question per skill for the audience, null where none of the packs tried fits. A
   * Worker without the route answers 404 and throws, rather than passing for an empty draw.
   */
  trainingQuestions(request: { skills: QuestionSkill[]; audience: QuestionAudience }): Promise<(TrainingQuestion | null)[]>;
}

type FetchLike = typeof fetch;

/** The Worker answered, but not with 2xx: the status says whose fault it was. */
export class WorkerError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
  ) {
    super(`token-minter ${path} failed: ${status}`);
    this.name = "WorkerError";
  }
}

export function createTransport(cfg: TransportConfig, fetchImpl: FetchLike = fetch): Transport {
  const post = async (path: string, body?: unknown): Promise<Response> => {
    const r = await fetchImpl(`${cfg.workerUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-vibe-token": cfg.vibeToken },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok) throw new WorkerError(path, r.status);
    return r;
  };


  return {
    /** Session token for ElevenLabs Agents, minted by the Worker. */
    agentToken: async () => {
      const r = await post("/agent/token");
      return (await r.json()) as { token: string; agentId: string };
    },

    deepgramToken: async () => {
      const r = await post("/deepgram-token");
      return (await r.json()) as { token: string };
    },

    engine: async () => {
      const r = await post("/engine");
      const { engine } = (await r.json()) as { engine?: string };
      return engine === "deepgram" ? "deepgram" : "elevenlabs";
    },

    trainingQuestions: async (request) => {
      const r = await post("/questions", request);
      return (await r.json()) as (TrainingQuestion | null)[];
    },
  };
}
