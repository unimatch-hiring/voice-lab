/**
 * Client token storage: IndexedDB plus a non-extractable WebCrypto key.
 *
 * The published build ships without a token — baking one in would hand our
 * paid quota to every visitor. So the live pipeline is unlocked by pasting the
 * token into the page, which means the token has to survive a reload somewhere.
 *
 * What this design does and does not buy:
 *
 * - The AES key is created with `extractable: false`, so it can be *used* from
 *   this origin but never read out, not even by our own code. A stolen copy of
 *   the database is therefore useless on another machine.
 * - It does NOT stop an attacker who is already running script on this page:
 *   they can call `loadToken()` just like we do. No browser storage can prevent
 *   that — `httpOnly` cookies could, but only a server can set those, and this
 *   frontend is static hosting.
 *
 * The real containment is elsewhere: the Worker hands out single-use ElevenLabs
 * tokens that expire in seconds, and it only answers a fixed origin list.
 */

const DB_NAME = "voice-lab";
const DB_VERSION = 1;
const STORE = "auth";
const KEY_ID = "token-key";
const BLOB_ID = "token-blob";
const ADMIN_BLOB_ID = "admin-blob";

interface StoredBlob {
  iv: number[];
  data: number[];
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(db: IDBDatabase, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    const request = run(db.transaction(STORE, mode).objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * The key is generated once and kept in IndexedDB as a CryptoKey handle.
 * Structured clone can store the handle itself, so the raw bytes never exist in
 * JS — that is what makes a copied database worthless.
 */
async function getKey(db: IDBDatabase): Promise<CryptoKey> {
  const existing = await tx<CryptoKey | undefined>(db, "readonly", (s) => s.get(KEY_ID));
  if (existing) return existing;

  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  await tx(db, "readwrite", (s) => s.put(key, KEY_ID));
  return key;
}

async function saveSecret(id: string, secret: string): Promise<void> {
  const db = await open();
  try {
    if (!secret) {
      await tx(db, "readwrite", (s) => s.delete(id));
      return;
    }
    const key = await getKey(db);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(secret),
    );
    const blob: StoredBlob = { iv: [...iv], data: [...new Uint8Array(data)] };
    await tx(db, "readwrite", (s) => s.put(blob, id));
  } finally {
    db.close();
  }
}

async function loadSecret(id: string): Promise<string> {
  let db: IDBDatabase;
  try {
    db = await open();
  } catch {
    // Private mode and some embedded webviews refuse to open a database.
    return "";
  }
  try {
    const blob = await tx<StoredBlob | undefined>(db, "readonly", (s) => s.get(id));
    if (!blob) return "";
    const key = await getKey(db);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(blob.iv) },
      key,
      new Uint8Array(blob.data),
    );
    return new TextDecoder().decode(plain);
  } catch {
    // Wrong key or corrupted record: treat it as "no token" rather than break
    // the page, the user can paste it again.
    return "";
  } finally {
    db.close();
  }
}

export async function saveToken(token: string): Promise<void> {
  await saveSecret(BLOB_ID, token);
}

export async function loadToken(): Promise<string> {
  return loadSecret(BLOB_ID);
}

export async function clearToken(): Promise<void> {
  await saveToken("");
}

/**
 * The admin password, kept the same way and under the same key as the candidate token —
 * a reload mid-interview must not lock us out of the tool that issues the keys.
 */
export async function saveAdminToken(secret: string): Promise<void> {
  await saveSecret(ADMIN_BLOB_ID, secret);
}

export async function loadAdminToken(): Promise<string> {
  return loadSecret(ADMIN_BLOB_ID);
}

export async function clearAdminToken(): Promise<void> {
  await saveSecret(ADMIN_BLOB_ID, "");
}
