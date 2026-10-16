import type { QuestionAudience, QuestionSkill, TrainingQuestion, Transport } from "./transport";

const SKILLS: readonly QuestionSkill[] = ["replacement", "homogeneous", "any"];

/** A site question drawn before the conversation, with the skill it was drawn for. */
export interface SessionQuestion {
  skill: QuestionSkill;
  question: TrainingQuestion;
}

/** Long enough for two uncached pack pages; past it the coach starts without a list. */
const SESSION_WAIT_MS = 5000;

/**
 * One question per skill, drawn before the session opens and handed over in the prompt.
 * All skills go in one request, so a start spends one of the key's six a minute. A failed
 * or slow draw costs the list, never the start.
 */
export async function sessionQuestions(
  transport: Transport,
  audience: QuestionAudience,
  waitMs = SESSION_WAIT_MS,
): Promise<SessionQuestion[]> {
  const draw = transport.trainingQuestions({ skills: [...SKILLS], audience }).catch(() => []);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<[]>((resolve) => (timer = setTimeout(() => resolve([]), waitMs)));
  const drawn: (TrainingQuestion | null)[] = await Promise.race([draw, late]);
  clearTimeout(timer);

  return SKILLS.flatMap((skill, i) => {
    const question = drawn[i];
    return question ? [{ skill, question }] : [];
  });
}
