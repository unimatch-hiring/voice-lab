import { createHash } from "node:crypto";
import { USER_ID_V4 } from "../shared/historyContract.js";

/** The lower-cased UUID v4 in `value`, or null when it is missing or not a v4. */
export function parseUserId(value) {
  if (typeof value !== "string" || !USER_ID_V4.test(value)) return null;
  return value.toLowerCase();
}

/** Only this hash reaches the store, so the database never holds a usable user id. */
export function hashUserId(userId) {
  return createHash("sha256").update(userId).digest("hex");
}
