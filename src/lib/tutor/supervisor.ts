import type { EventBus } from "../events";
import { DIRECTIVE_MARKER } from "../persona";
import {
  INITIAL_LESSON,
  askLevelDirective,
  clearMistakes,
  forgiveSteering,
  resetLevelDirective,
  resetLevel,
  rollback,
  step,
  type LessonState,
  type TutorAction,
} from "./lesson";
import { describeLevel } from "./level";
import { labelOf } from "./mistakes";
import type { StoredLesson } from "./lessonStore";

/**
 * Runs the lesson reducer against the live conversation.
 *
 * The only impure part of the tutor, and deliberately thin: it reads the same event
 * bus the scene reads, so it never touches the pipeline, and it acts through one
 * method. Everything that decides anything is in `lesson.ts` and is pure.
 */

/**
 * How the tutor reaches the agent mid-conversation. `AgentSession` satisfies it;
 * a test hands over a recorder instead.
 *
 * `false` means the directive was not handed over at all — there was no live
 * conversation to hand it to. `true` means the SDK took it, which is as much as
 * anything here can know: the SDK itself drops a message with a console warning
 * when the room is mid-reconnect, and nothing acknowledges one that arrives.
 */
export interface TutorChannel {
  sendContext(text: string): boolean;
}

export class Tutor {
  private state: LessonState = INITIAL_LESSON;

  constructor(
    private bus: EventBus,
    private channel: TutorChannel,
    /** Called whenever there is something new worth surviving a reload. */
    private persist: (lesson: StoredLesson) => void = () => {},
  ) {}

  get lesson(): LessonState {
    return this.state;
  }

  /** Subscribes to the conversation. Returns the unsubscribe, like `EventBus.on`. */
  attach(): () => void {
    return this.bus.on((e) => {
      // `stt-result` is what the recogniser heard, i.e. the learner's own words.
      // The agent's replies are not judged: steering the tutor by its own English
      // would clear the streak the learner just set.
      if (e.type !== "stt-result") return;
      const [next, actions] = step(this.state, {
        kind: "user-utterance",
        text: e.result.text,
      });
      // Per action: a lost note costs nothing, a lost steer costs the rung, a lost
      // recheck costs the mark that says it was drilled.
      let state = next;
      for (const action of actions) {
        if (!this.dispatch(action)) state = rollback(this.state, state, action);
      }
      this.state = state;

      if (actions.some((a) => a.type === "level-set")) this.announceLevel();
      // Saved on anything worth remembering rather than on every utterance: a write
      // per turn would be most of them writing nothing new.
      if (actions.some((a) => a.type === "note-mistake" || a.type === "level-set")) {
        this.save();
      }
    });
  }

  /**
   * A new conversation is a new lesson: the previous streak is not this learner's
   * doing. What they get wrong is kept — that is the half the product promises to
   * remember.
   */
  reset(): void {
    this.state = forgiveSteering(this.state);
  }

  /** Context that must arrive with a new session, before its first reply. */
  openingContext(): string {
    if (!this.state.level) {
      return "\n\nLEVEL STATUS\nThe learner's English level is not known. Ask what their level is before assessing it from their conversation.";
    }
    return `\n\nKNOWN LEARNER LEVEL\nThe learner's English level is ${describeLevel(this.state.level)}. It is already known: do not ask for it again. Greet them and continue at that level.`;
  }

  /** Asks through the live channel, so the dashboard greeting cannot skip the lesson. */
  begin(): void {
    if (this.state.levelPhase !== "asking") return;
    if (!this.channel.sendContext(askLevelDirective(false))) return;
    this.state = { ...this.state, levelPhase: "asked-again" };
  }

  /**
   * Picks up a lesson from a previous visit.
   *
   * Announces the level if there is one, so the page shows it without waiting for the
   * learner to say anything, and replays the mistakes so the board is not empty while
   * the record behind it is not.
   */
  restore(stored: StoredLesson): void {
    this.state = {
      ...this.state,
      level: stored.level,
      levelPhase: stored.level ? "set" : "asking",
      mistakes: stored.mistakes,
      counts: stored.counts,
      rechecked: stored.rechecked,
    };

    for (const [i, correction] of stored.mistakes.entries()) {
      this.bus.emit({
        type: "mistake",
        said: correction.said,
        fixed: correction.fixed,
        labels: correction.ruleIds.map(labelOf),
        total: i + 1,
        at: performance.now(),
      });
    }
    this.announceLevel();
  }

  /**
   * Forgets the level and asks again. The mistakes stay: the learner asked to be
   * re-assessed, not to be forgotten.
   *
   * The agent is told at once rather than at the next session, so pressing the button
   * mid-lesson does what it says.
   */
  resetLevel(): void {
    this.state = resetLevel(this.state);
    if (this.channel.sendContext(resetLevelDirective())) {
      this.state = { ...this.state, levelPhase: "asked-again" };
    }
    this.save();
    this.announceLevel();
  }

  /**
   * Wipes the record, on the page and in the store, and tells the agent it is gone.
   *
   * The directive matters as much as the wipe: the notes are already in the agent's
   * context and cannot be taken back out, so without it the learner clears the board
   * and is then told they keep making a mistake that is no longer written anywhere.
   */
  clearMistakes(): void {
    // Nothing to forget, so nothing to tell the agent about. Without this, pressing a
    // button on an empty record spends a directive saying a record was wiped.
    if (this.state.mistakes.length === 0) return;
    this.state = clearMistakes(this.state);
    this.channel.sendContext(
      `${DIRECTIVE_MARKER} The learner has cleared their record of mistakes. Forget the ones you were told about and do not bring them up again. Keep correcting what you hear from now on.`,
    );
    this.save();
    this.bus.emit({ type: "mistakes-cleared", at: performance.now() });
  }

  private announceLevel(): void {
    this.bus.emit({
      type: "level",
      level: this.state.level?.level ?? null,
      told: this.state.level?.source === "told",
      at: performance.now(),
    });
  }

  private save(): void {
    this.persist({
      level: this.state.level,
      mistakes: [...this.state.mistakes],
      counts: { ...this.state.counts },
      rechecked: [...this.state.rechecked],
    });
  }

  private dispatch(action: TutorAction): boolean {
    if (action.type === "note-mistake") {
      const { correction } = action;
      this.bus.emit({
        type: "mistake",
        said: correction.said,
        fixed: correction.fixed,
        labels: correction.ruleIds.map(labelOf),
        total: action.total,
        at: performance.now(),
      });
    }
    return this.channel.sendContext(action.text);
  }
}
