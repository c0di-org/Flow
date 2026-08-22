// Browser-only photo storage.
//
// The native app keeps photo derivatives as files under the Tauri app-data
// directory and hands the board plain filesystem paths. A browser has no such
// directory, so the web build stores the same derivatives as blobs in
// IndexedDB and puts `webphoto:<assetId>:<variant>` keys in the board document
// instead of paths. localStorage keeps holding the document itself, so board
// JSON stays small no matter how many photos are on the canvas.
//
// Object URLs are minted once per key at startup and live for the session:
// they are cheap handles onto the stored blob and are only decoded when Pixi
// actually loads one.

const DB_NAME = 'flow.webAssets.v1';
const STORE = 'variants';

export type WebAssetVariant = 'preview' | 'thumbnail' | 'micro';

export function webAssetKey(assetId: string, variant: WebAssetVariant) {
  return `webphoto:${assetId}:${variant}`;
}

export function isWebAssetKey(path: string) {
  return path.startsWith('webphoto:');
}

const objectUrls = new Map<string, string>();

let dbPromise: Promise<IDBDatabase | null> | undefined;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, 1);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    // Private-browsing modes and blocked storage land here. Photo import then
    // degrades to session-only rather than taking the whole board down.
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return dbPromise;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Mint object URLs for every stored variant. Call once before the first render
 * so `webAssetUrl` can stay synchronous on the texture-attach path.
 */
export async function warmWebAssets() {
  const db = await openDb();
  if (!db) return;
  try {
    const transaction = db.transaction(STORE, 'readonly');
    const store = transaction.objectStore(STORE);
    const [keys, blobs] = await Promise.all([
      requestToPromise(store.getAllKeys()),
      requestToPromise(store.getAll()),
    ]);
    keys.forEach((key, index) => {
      const blob = blobs[index] as Blob | undefined;
      if (typeof key !== 'string' || !blob) return;
      if (objectUrls.has(key)) return;
      objectUrls.set(key, URL.createObjectURL(blob));
    });
  } catch {
    // A damaged store should not stop the board from opening.
  }
}

export async function putWebAsset(key: string, blob: Blob) {
  const previous = objectUrls.get(key);
  objectUrls.set(key, URL.createObjectURL(blob));
  if (previous) URL.revokeObjectURL(previous);

  const db = await openDb();
  if (!db) return;
  const transaction = db.transaction(STORE, 'readwrite');
  transaction.objectStore(STORE).put(blob, key);
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    // Quota errors surface here; the caller reports the photo as failed.
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

/**
 * Resolve a stored key to a loadable URL. Unknown keys are returned unchanged
 * so the texture load fails loudly instead of silently rendering nothing.
 */
export function webAssetUrl(path: string) {
  return objectUrls.get(path) ?? path;
}

/**
 * Drop variants no board references any more — the browser-side equivalent of
 * the native `cleanup_orphan_assets` pass.
 */
export async function pruneWebAssets(referenced: Set<string>) {
  const db = await openDb();
  if (!db) return;
  try {
    const readTransaction = db.transaction(STORE, 'readonly');
    const keys = await requestToPromise(readTransaction.objectStore(STORE).getAllKeys());
    const orphans = keys.filter((key): key is string => typeof key === 'string' && !referenced.has(key));
    if (!orphans.length) return;

    const writeTransaction = db.transaction(STORE, 'readwrite');
    const store = writeTransaction.objectStore(STORE);
    for (const key of orphans) store.delete(key);
    await new Promise<void>((resolve) => {
      writeTransaction.oncomplete = () => resolve();
      writeTransaction.onerror = () => resolve();
      writeTransaction.onabort = () => resolve();
    });
    for (const key of orphans) {
      const url = objectUrls.get(key);
      if (!url) continue;
      URL.revokeObjectURL(url);
      objectUrls.delete(key);
    }
  } catch {
    // Cleanup is best effort.
  }
}
