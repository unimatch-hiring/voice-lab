import { afterEach, describe, expect, it, vi } from "vitest";
import { browserUserId, KeyValueStorage, loadUserId, USER_ID_KEY } from "./userId";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KNOWN_ID = "3f1c2a4e-9b7d-4c1a-8e2f-5a6b7c8d9e0f";

function memoryStorage(initial: Record<string, string> = {}): KeyValueStorage {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  };
}

describe("loadUserId", () => {
  it("generates a v4 id on first call and stores it", () => {
    const storage = memoryStorage();
    const id = loadUserId(storage, () => crypto.randomUUID());

    expect(id).toMatch(UUID_V4);
    expect(storage.getItem(USER_ID_KEY)).toBe(id);
  });

  it("returns the stored id without calling the generator", () => {
    const storage = memoryStorage({ [USER_ID_KEY]: KNOWN_ID });
    const newId = vi.fn(() => "unused");

    expect(loadUserId(storage, newId)).toBe(KNOWN_ID);
    expect(newId).not.toHaveBeenCalled();
  });

  it("returns the same id on a second call with the same storage", () => {
    const storage = memoryStorage();
    const first = loadUserId(storage, () => crypto.randomUUID());
    const newId = vi.fn(() => crypto.randomUUID());

    expect(loadUserId(storage, newId)).toBe(first);
    expect(newId).not.toHaveBeenCalled();
  });

  it.each([
    ["not a uuid", "not-a-uuid"],
    ["a v1 uuid", "3f1c2a4e-9b7d-1c1a-8e2f-5a6b7c8d9e0f"],
    ["a v4 uuid with a bad variant", "3f1c2a4e-9b7d-4c1a-ce2f-5a6b7c8d9e0f"],
    ["an empty string", ""],
  ])("replaces a stored value that is %s", (_label, stored) => {
    const storage = memoryStorage({ [USER_ID_KEY]: stored });

    expect(loadUserId(storage, () => KNOWN_ID)).toBe(KNOWN_ID);
    expect(storage.getItem(USER_ID_KEY)).toBe(KNOWN_ID);
  });

  it("accepts an upper-case stored v4 id", () => {
    const upper = KNOWN_ID.toUpperCase();
    const storage = memoryStorage({ [USER_ID_KEY]: upper });

    expect(loadUserId(storage, () => "unused")).toBe(upper);
  });

  it("returns null when reading storage throws", () => {
    const storage: KeyValueStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {},
    };

    expect(loadUserId(storage, () => KNOWN_ID)).toBeNull();
  });

  it("returns null when writing the new id throws", () => {
    const storage: KeyValueStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    };

    expect(loadUserId(storage, () => KNOWN_ID)).toBeNull();
  });

  it("returns null when the generator throws", () => {
    const newId = () => {
      throw new Error("no entropy");
    };

    expect(loadUserId(memoryStorage(), newId)).toBeNull();
  });

  it("returns null without a generator, even if an id is stored", () => {
    const storage = memoryStorage({ [USER_ID_KEY]: KNOWN_ID });

    expect(loadUserId(storage, null)).toBeNull();
  });

  it("returns null without storage", () => {
    expect(loadUserId(null, () => KNOWN_ID)).toBeNull();
  });
});

// Node 25+ defines its own global `localStorage`, undefined without --localstorage-file, and it
// shadows jsdom's: each test installs the storage it means instead of relying on the runtime's.
describe("browserUserId", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("stores and reuses an id in localStorage", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    const id = browserUserId();

    expect(id).toMatch(UUID_V4);
    expect(storage.getItem(USER_ID_KEY)).toBe(id);
    expect(browserUserId()).toBe(id);
  });

  it("returns null when reading localStorage throws", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get: () => {
        throw new DOMException("blocked", "SecurityError");
      },
    });
    try {
      expect(browserUserId()).toBeNull();
    } finally {
      if (original) Object.defineProperty(globalThis, "localStorage", original);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });

  it("returns null when crypto.randomUUID is not a function", () => {
    vi.stubGlobal("crypto", {});

    expect(browserUserId()).toBeNull();
  });
});
