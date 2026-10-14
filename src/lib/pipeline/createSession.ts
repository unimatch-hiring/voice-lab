import { AgentSession } from "./agentSession";
import { DeepgramSession } from "./deepgramSession";
import type { Engine, SessionDeps, VoiceSession } from "./session";

export function createSession(engine: Engine, deps: SessionDeps): VoiceSession {
  return engine === "deepgram" ? new DeepgramSession(deps) : new AgentSession(deps);
}
