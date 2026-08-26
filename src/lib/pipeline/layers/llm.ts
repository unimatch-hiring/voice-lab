/**
 * The layer LLM port.
 *
 * The side layers get their own model calls as text-only sessions against the same agent,
 * so nothing here needs a model decision or a key we do not already have. `textOnly`
 * forces the SDK onto its WebSocket transport, which authenticates with a signed URL
 * rather than the WebRTC conversation token the voice session uses.
 */
import { Conversation } from "@elevenlabs/client";
import type { Transport } from "../../transport";

export interface LayerCall {
  layer: string;
  systemPrompt: string;
  userText: string;
}

export interface LayerLlm {
  call(call: LayerCall): Promise<{ text: string; totalMs: number }>;
  close(): void;
}

/**
 * Deterministic LLM for tests: delays are real timers, so "did B and E overlap" is a
 * question about scheduling rather than about a live datacentre.
 */
export function mockLayerLlm(
  handler: (call: LayerCall) => { text?: string; totalMs?: number; throws?: string },
): LayerLlm {
  return {
    async call(call) {
      const plan = handler(call);
      const totalMs = plan.totalMs ?? 40;
      await sleep(totalMs);
      if (plan.throws) throw new Error(plan.throws);
      return { text: plan.text ?? "", totalMs };
    },
    close() {},
  };
}

interface PooledSession {
  ask(text: string): Promise<string>;
  close(): void;
  turns: number;
}

/**
 * One pooled text session per layer.
 *
 * Pooling is not a micro-optimisation: a WebSocket handshake in front of every
 * classification dwarfs the classification. It costs history, which is wrong for a
 * stateless classifier, so a layer's session is re-opened every `resetAfter` turns.
 */
export function liveLayerLlm({
  transport,
  resetAfter = 8,
  timeoutMs = 20000,
}: {
  transport: Transport;
  resetAfter?: number;
  timeoutMs?: number;
}): LayerLlm {
  const sessions = new Map<string, PooledSession>();

  async function open(systemPrompt: string): Promise<PooledSession> {
    const { signedUrl } = await transport.signedUrl();
    let pending: ((text: string) => void) | null = null;

    const conversation = await Conversation.startSession({
      signedUrl,
      textOnly: true,
      // An agent with a greeting would otherwise speak into the middle of a classification.
      overrides: { agent: { prompt: { prompt: systemPrompt }, firstMessage: "" } },
      onMessage: ({ message, source }) => {
        if (source === "user") return;
        pending?.(message);
        pending = null;
      },
    });

    return {
      turns: 0,
      close: () => void conversation.endSession().catch(() => undefined),
      ask: (text) =>
        new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => {
            pending = null;
            reject(new Error(`no reply within ${timeoutMs}ms`));
          }, timeoutMs);
          pending = (reply) => {
            clearTimeout(timer);
            resolve(reply);
          };
          conversation.sendUserMessage(text);
        }),
    };
  }

  async function sessionFor(layer: string, systemPrompt: string): Promise<PooledSession> {
    const existing = sessions.get(layer);
    if (existing && existing.turns < resetAfter) return existing;
    existing?.close();
    const fresh = await open(systemPrompt);
    sessions.set(layer, fresh);
    return fresh;
  }

  return {
    async call({ layer, systemPrompt, userText }) {
      const startedAt = performance.now();
      const session = await sessionFor(layer, systemPrompt);
      session.turns += 1;
      const text = await session.ask(userText);
      return { text, totalMs: performance.now() - startedAt };
    },
    close() {
      for (const s of sessions.values()) s.close();
      sessions.clear();
    },
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

export type Outcome<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * Races a promise against a deadline.
 *
 * Resolves rather than rejects: every caller here has a defined behaviour on timeout, and
 * an exception would invite a `catch` that forgets to produce one.
 */
export async function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  label = "deadline",
): Promise<Outcome<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Outcome<T>>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: `${label}: exceeded ${ms}ms` }), ms);
  });
  try {
    return await Promise.race([
      promise.then((value): Outcome<T> => ({ ok: true, value })),
      timeout,
    ]);
  } catch (err) {
    // A layer that threw is not a layer that was slow, and the log should say so.
    return { ok: false, reason: `${label}: ${(err as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Models drift into prose around JSON; take the first balanced object and parse that. */
export function parseJson<T>(text: string): T | null {
  if (typeof text !== "string") return null;
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') inStr = !inStr;
    if (inStr) continue;
    if (ch === "{") depth++;
    if (ch === "}" && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1)) as T;
      } catch {
        return null;
      }
    }
  }
  return null;
}
