/** What the parent sets, all free-form text. Mirrors `SETTINGS_FIELDS` in `server/childService.js`. */
export interface ParentSettings {
  allowedTopics: string;
  blockedTopics: string;
  childProfile: string;
  triggerWords: string;
}

export const EMPTY_SETTINGS: ParentSettings = {
  allowedTopics: "",
  blockedTopics: "",
  childProfile: "",
  triggerWords: "",
};
