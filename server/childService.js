export const SETTINGS_FIELDS = ["allowedTopics", "blockedTopics", "childProfile", "triggerWords"];
const MAX_FIELD_LENGTH = 4000;

export const EMPTY_DOC = {
  settings: Object.fromEntries(SETTINGS_FIELDS.map((f) => [f, ""])),
};

/** The request was understood but its content is not acceptable: a 400, not a 500. */
export class ValidationError extends Error {}

export function createChildService(store) {
  return {
    async getSettings() {
      return (await store.read()).settings;
    },

    async saveSettings(input) {
      const settings = parseSettings(input);
      await store.update((doc) => ({ ...doc, settings }));
      return settings;
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
