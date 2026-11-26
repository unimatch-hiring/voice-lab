import { randomUUID } from "node:crypto";

export const SETTINGS_FIELDS = ["allowedTopics", "blockedTopics", "childProfile", "triggerWords"];
const MAX_FIELD_LENGTH = 4000;
const MAX_CONTEXT_LINES = 3;
const CONTEXT_ROLES = ["child", "assistant"];

export const EMPTY_DOC = {
  settings: Object.fromEntries(SETTINGS_FIELDS.map((f) => [f, ""])),
  flags: [],
};

/** The request was understood but its content is not acceptable: a 400, not a 500. */
export class ValidationError extends Error {}

/** `classifier.classify(candidate)` → `{concern, category, severity, reason}`, or throws. */
export function createChildService(store, classifier) {
  const saveFlag = async (flag) => {
    const stored = { id: randomUUID(), at: Date.now(), ...flag };
    await store.update((doc) => ({ ...doc, flags: [...doc.flags, stored] }));
    return stored;
  };

  return {
    async getSettings() {
      return (await store.read()).settings;
    },

    async saveSettings(input) {
      const settings = parseSettings(input);
      await store.update((doc) => ({ ...doc, settings }));
      return settings;
    },

    /**
     * A keyword match is only a candidate; the classifier decides. When it cannot, the
     * flag is kept as unverified: a missed risk costs more than a false alarm.
     */
    async reviewFlag(input) {
      const candidate = parseCandidate(input);
      let verdict;
      try {
        verdict = await classifier.classify(candidate);
      } catch (e) {
        console.warn("flag review failed, keeping it unverified:", e.message);
        return { flagged: true, flag: await saveFlag({ ...candidate, status: "unverified" }) };
      }
      // Not stored: the child's words are kept only when there is a reason to.
      const { concern, ...review } = verdict;
      if (!concern) return { flagged: false };
      return { flagged: true, flag: await saveFlag({ ...candidate, status: "confirmed", ...review }) };
    },

    /** Everything gathered about the child; the parent's topics and alarm words stay. */
    async deleteChildData() {
      await store.update((doc) => ({
        ...doc,
        settings: { ...doc.settings, childProfile: "" },
        flags: [],
      }));
      return { deleted: true };
    },

    async listFlags() {
      return [...(await store.read()).flags].reverse();
    },
  };
}

function parseSettings(input) {
  if (!input || typeof input !== "object") throw new ValidationError("settings must be an object");
  const settings = {};
  for (const field of SETTINGS_FIELDS) {
    const value = input[field] ?? "";
    if (typeof value !== "string") throw new ValidationError(`${field} must be a string`);
    if (value.length > MAX_FIELD_LENGTH) throw new ValidationError(`${field} is too long`);
    settings[field] = value.trim();
  }
  return settings;
}

function parseCandidate(input) {
  const { text, matched, context = [] } = input ?? {};
  if (!isText(text)) throw new ValidationError("text must be a non-empty string");
  if (!Array.isArray(matched) || matched.length === 0 || !matched.every(isText)) {
    throw new ValidationError("matched must list the words that triggered the review");
  }
  if (!Array.isArray(context) || context.length > MAX_CONTEXT_LINES) {
    throw new ValidationError(`context must hold at most ${MAX_CONTEXT_LINES} lines`);
  }
  for (const line of context) {
    if (!CONTEXT_ROLES.includes(line?.role) || !isText(line.text)) {
      throw new ValidationError("each context line needs a role and a text");
    }
  }
  return {
    text,
    matched,
    context: context.map(({ role, text }) => ({ role, text })),
  };
}

function isText(v) {
  return typeof v === "string" && v.trim() !== "" && v.length <= MAX_FIELD_LENGTH;
}
