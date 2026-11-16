import { beforeEach, expect, test } from "vitest";
import { EMPTY_PROFILE } from "./formModel";
import { clearProfile, loadProfile, loadToken, saveProfile, saveToken } from "./tokenStore";

/** jsdom has no IndexedDB: a Map behind the few calls tokenStore makes, answering asynchronously. */
function fakeIndexedDB() {
  const data = new Map<string, unknown>();
  const request = <T>(run: () => T) => {
    const req = {} as { result: T; onsuccess?: () => void; onerror?: () => void };
    setTimeout(() => {
      req.result = run();
      req.onsuccess?.();
    });
    return req;
  };
  const store = {
    get: (k: string) => request(() => data.get(k)),
    put: (v: unknown, k: string) => request(() => void data.set(k, v)),
    delete: (k: string) => request(() => void data.delete(k)),
  };
  const db = {
    objectStoreNames: { contains: () => true },
    transaction: () => ({ objectStore: () => store }),
    close: () => {},
  };
  return { open: () => request(() => db) };
}

beforeEach(() => {
  (globalThis as { indexedDB?: unknown }).indexedDB = fakeIndexedDB();
});

test("the profile survives a reload under its own record, apart from the token", async () => {
  const profile = { ...EMPTY_PROFILE, name: "Анна", phone: "+7 900 123-45-67" };
  await saveToken("vibe_secret");
  await saveProfile(profile);

  expect(await loadProfile()).toEqual(profile);
  expect(await loadToken()).toBe("vibe_secret");
});

test("saves fired keystroke by keystroke on a first visit all decrypt, and the last one wins", async () => {
  const typed = ["+", "+7", "+7 9", "+7 90"].map((phone) => ({ ...EMPTY_PROFILE, phone }));
  await Promise.all([saveToken("vibe_secret"), ...typed.map(saveProfile)]);

  expect(await loadProfile()).toEqual(typed.at(-1));
  expect(await loadToken()).toBe("vibe_secret");
});

test("one failed write does not block every save after it", async () => {
  const idb = globalThis.indexedDB as unknown as { open: () => unknown };
  const realOpen = idb.open;
  idb.open = () => {
    idb.open = realOpen;
    const req = { error: new Error("quota") } as { error: Error; onerror?: () => void };
    setTimeout(() => req.onerror?.());
    return req;
  };
  const profile = { ...EMPTY_PROFILE, name: "Анна" };

  await expect(saveProfile({ ...EMPTY_PROFILE, name: "x" })).rejects.toThrow("quota");
  await saveProfile(profile);

  expect(await loadProfile()).toEqual(profile);
});

test("a cleared profile is gone from the store, and the token stays", async () => {
  await saveToken("vibe_secret");
  await saveProfile({ ...EMPTY_PROFILE, name: "Анна", phone: "+34180" });

  await clearProfile();

  expect(await loadProfile()).toEqual(EMPTY_PROFILE);
  expect(await loadToken()).toBe("vibe_secret");
});
