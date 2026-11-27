import { REVIEW_TEXT_LIMIT, REVIEW_TURN_LIMIT, type ReviewTurn, type TurnReview } from "../../../shared/child";

const CORRECTION_WAIT = 500;
const PLAYBACK_SETTLE = 200;

interface PendingTurn extends ReviewTurn {
  id: string;
  inputEventId?: number;
  outputEventId?: number;
  interruptionId?: number;
  correctionTimer?: ReturnType<typeof setTimeout>;
  played: boolean;
  finishedPlayback: boolean;
  ready: boolean;
  occurredAt: string;
}

type ReviewPayload = Pick<TurnReview, "turnId" | "occurredAt" | "turns">;

export function reviewTurns(send: (turn: ReviewPayload) => void) {
  const queue: PendingTurn[] = [];
  const history: ReviewTurn[] = [];
  let active: PendingTurn | undefined;
  let playbackTimer: ReturnType<typeof setTimeout> | undefined;
  let lastInputId: number | undefined;
  let lastReplyId: number | undefined;
  let closed = false;

  function complete(turn: PendingTurn, output: string | null) {
    clearTimeout(turn.correctionTimer);
    turn.ready = true;
    turn.output = output?.slice(0, REVIEW_TEXT_LIMIT) ?? null;
    let next = queue[0];
    while (next?.ready) {
      queue.shift();
      history.push({ input: next.input, output: next.output });
      if (history.length > REVIEW_TURN_LIMIT) history.shift();
      send({ turnId: next.id, occurredAt: next.occurredAt, turns: [...history] });
      next = queue[0];
    }
  }

  function interrupt(eventId?: number) {
    const turn = active;
    if (!turn || (eventId !== undefined && turn.inputEventId !== undefined && eventId < turn.inputEventId)) return;
    clearTimeout(playbackTimer);
    active = undefined;
    turn.interruptionId = eventId;
    turn.correctionTimer = setTimeout(() => complete(turn, null), CORRECTION_WAIT);
  }

  function settlePlayback() {
    const turn = active;
    if (!turn?.finishedPlayback || turn.output === null) return;
    clearTimeout(playbackTimer);
    // WebRTC reports active speakers, so a brief gap can look like playback ending.
    playbackTimer = setTimeout(() => {
      if (active !== turn) return;
      active = undefined;
      complete(turn, turn.output);
    }, PLAYBACK_SETTLE);
  }

  return {
    input(text: string, eventId?: number) {
      if (closed || !text.trim() || (eventId !== undefined && lastInputId !== undefined && eventId <= lastInputId)) return;
      lastInputId = eventId ?? lastInputId;
      if (active?.finishedPlayback && active.output !== null) {
        clearTimeout(playbackTimer);
        complete(active, active.output);
        active = undefined;
      }
      interrupt();
      active = {
        id: crypto.randomUUID(), inputEventId: eventId, input: text.slice(0, REVIEW_TEXT_LIMIT), output: null,
        played: false, finishedPlayback: false, ready: false, occurredAt: new Date().toISOString(),
      };
      queue.push(active);
    },
    output(text: string, eventId?: number) {
      if (!active || !text.trim() || (eventId !== undefined &&
          ((lastReplyId !== undefined && eventId <= lastReplyId) ||
          (active.inputEventId !== undefined && eventId < active.inputEventId)))) return;
      lastReplyId = eventId ?? lastReplyId;
      active.outputEventId = eventId;
      active.output = text;
      settlePlayback();
    },
    mode(mode: "speaking" | "listening") {
      if (!active) return;
      if (mode === "speaking") {
        active.played = true;
        active.finishedPlayback = false;
        clearTimeout(playbackTimer);
      } else if (active.played) {
        active.finishedPlayback = true;
        settlePlayback();
      }
    },
    interrupt,
    correct(eventId: number, original: string, heard: string) {
      const turn = queue.find((turn) => turn !== active && !turn.ready &&
        (turn.outputEventId === eventId || turn.interruptionId === eventId) &&
        (turn.output === null || turn.output === original));
      if (turn) complete(turn, heard.trim() ? heard : null);
    },
    close() {
      closed = true;
      clearTimeout(playbackTimer);
      const turn = active;
      active = undefined;
      for (const pending of [...queue]) {
        if (!pending.ready) complete(pending, pending === turn && turn.finishedPlayback ? turn.output : null);
      }
    },
  };
}
