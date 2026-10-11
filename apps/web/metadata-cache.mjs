// Browser-local metadata for testnet contracts without a shared metadata URI.
// IndexedDB holds full-size logos without the small localStorage string quota.
let database;
function openDatabase() {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open('elpida-metadata', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('metadata');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Metadata storage is blocked.'));
  }).catch(error => { database = null; throw error; });
  return database;
}

export async function readMetadataCache(key) {
  try {
    const db = await openDatabase();
    const value = await new Promise((resolve, reject) => {
      const request = db.transaction('metadata', 'readonly').objectStore('metadata').get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (value != null) return value;
  } catch {}
  // Preserve metadata saved by previous app versions.
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}

export async function writeMetadataCache(key, value) {
  try {
    const db = await openDatabase();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction('metadata', 'readwrite');
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
      transaction.objectStore('metadata').put(value, key);
    });
    try { localStorage.removeItem(key); } catch {}
    return true;
  } catch {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  }
}
