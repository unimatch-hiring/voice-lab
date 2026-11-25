/**
 * The opaque paging cursor of the conversation list. It holds the sort key of the last
 * row of a page (store.js orders by started_at DESC, id DESC), so the order and this
 * encoding change together.
 */

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

export function encodeCursor(next) {
  const { startedAt, id } = next;
  return Buffer.from(JSON.stringify({ startedAt, id })).toString("base64url");
}

/** Returns the sort key the cursor holds, or null when the value is not a cursor. */
export function decodeCursor(value) {
  if (typeof value !== "string") return null;
  let cursor;
  try {
    cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!isObject(cursor)) return null;
  const { startedAt, id } = cursor;
  if (!Number.isFinite(startedAt) || typeof id !== "string" || id === "") return null;
  return { startedAt, id };
}
