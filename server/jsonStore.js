import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * One JSON document on disk. Updates are queued so two requests never read the same
 * version and the later write silently drops the earlier one.
 */
export function createJsonStore(file, emptyDoc) {
  let queue = Promise.resolve();

  const read = async () => {
    try {
      return { ...structuredClone(emptyDoc), ...JSON.parse(await readFile(file, "utf8")) };
    } catch (e) {
      if (e.code === "ENOENT") return structuredClone(emptyDoc);
      throw e;
    }
  };

  // temp + rename: a crash mid-write leaves the previous file, never half a document.
  const write = async (doc) => {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(doc, null, 2));
    await rename(tmp, file);
  };

  return {
    read,
    update(mutate) {
      const next = queue.then(async () => {
        const doc = mutate(await read());
        await write(doc);
        return doc;
      });
      queue = next.catch(() => undefined);
      return next;
    },
  };
}
