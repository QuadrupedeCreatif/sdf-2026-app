/**
 * Petite couche IndexedDB pour stocker les PDF (billets, factures) en local.
 * Rien ne quitte jamais l'appareil : les fichiers sont stockés en Blob.
 */
const SDFDatabase = (() => {
  const DB_NAME = 'sdf2026-db';
  const DB_VERSION = 1;
  const STORE = 'documents';

  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('addedAt', 'addedAt');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function addDocument({ name, size, type, blob }) {
    const db = await open();
    const record = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      size,
      type: type || 'application/pdf',
      blob,
      addedAt: Date.now(),
    };
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).add(record);
      tx.oncomplete = () => resolve(record);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function getAllDocuments() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => {
        const docs = req.result || [];
        docs.sort((a, b) => b.addedAt - a.addedAt);
        resolve(docs);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async function deleteDocument(id) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  return { addDocument, getAllDocuments, deleteDocument };
})();
