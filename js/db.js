/**
 * Couche IndexedDB de Voyag'heure.
 *
 * Quatre stores :
 *  - "trips"           : les voyages/événements créés par l'utilisateur.
 *  - "entries"         : les entrées de planning (un événement précis :
 *                        titre, jour, heure, lieu, adresse). Une entrée
 *                        "solo" (import PDF/image classique ou ajout
 *                        manuel) porte aussi son prix/référence/statut de
 *                        paiement/PDF directement — exactement comme
 *                        avant, pour ne rien casser sur les données déjà
 *                        stockées. Une entrée issue d'un "billet combiné"
 *                        a plutôt un `documentId` : son prix/référence/
 *                        statut/PDF vivent alors sur le document partagé
 *                        (voir "documents" ci-dessous) et restent null ici.
 *  - "documents"       : un billet combiné (un seul PDF qui couvre
 *                        plusieurs événements distincts, ex. pass festival
 *                        multi-jours) — porte le PDF, le prix TOTAL, la
 *                        référence et le statut de paiement, comptés
 *                        UNE fois pour tous les événements qu'il couvre.
 *  - "correctionRules" : préférences apprises quand l'utilisateur corrige
 *                        un champ pré-rempli par l'import PDF (ex. "pour
 *                        les documents FlixBus, préfère le prix labellisé
 *                        'Total'"). Une ligne par (signature de document,
 *                        champ) — pas de ML, juste une table de préférence.
 *  - "checklistItems"  : la checklist d'un voyage (onglet dédié) — texte
 *                        libre + coché/non coché, sans suggestion
 *                        automatique de contenu.
 *
 * Rien de spécifique à un événement précis n'est codé ici : toutes les
 * données viennent de l'utilisateur, à la création du voyage ou à
 * l'import/l'ajout d'une entrée.
 */

const DB_NAME = 'voyagheure-db';
const DB_VERSION = 4;
const TRIPS_STORE = 'trips';
const ENTRIES_STORE = 'entries';
const DOCUMENTS_STORE = 'documents';
const CORRECTIONS_STORE = 'correctionRules';
const CHECKLIST_STORE = 'checklistItems';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(TRIPS_STORE)) {
        db.createObjectStore(TRIPS_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(ENTRIES_STORE)) {
        const store = db.createObjectStore(ENTRIES_STORE, { keyPath: 'id' });
        store.createIndex('tripId', 'tripId');
        store.createIndex('startDate', 'startDate');
      }
      if (!db.objectStoreNames.contains(DOCUMENTS_STORE)) {
        const store = db.createObjectStore(DOCUMENTS_STORE, { keyPath: 'id' });
        store.createIndex('tripId', 'tripId');
      }
      const entriesStore = req.transaction.objectStore(ENTRIES_STORE);
      if (!entriesStore.indexNames.contains('documentId')) {
        entriesStore.createIndex('documentId', 'documentId');
      }
      if (!db.objectStoreNames.contains(CORRECTIONS_STORE)) {
        db.createObjectStore(CORRECTIONS_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(CHECKLIST_STORE)) {
        const store = db.createObjectStore(CHECKLIST_STORE, { keyPath: 'id' });
        store.createIndex('tripId', 'tripId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeName, mode) {
  return openDb().then((db) => db.transaction(storeName, mode).objectStore(storeName));
}

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// ---------------------------------------------------------------------
// Trips
// ---------------------------------------------------------------------

async function createTrip({ name, place, startDate, endDate }) {
  const store = await tx(TRIPS_STORE, 'readwrite');
  const trip = {
    id: makeId(),
    name: name.trim(),
    place: place ? place.trim() : '',
    startDate: startDate || null,
    endDate: endDate || null,
    createdAt: Date.now(),
  };
  return new Promise((resolve, reject) => {
    const req = store.add(trip);
    req.onsuccess = () => resolve(trip);
    req.onerror = () => reject(req.error);
  });
}

async function updateTrip(trip) {
  const store = await tx(TRIPS_STORE, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.put(trip);
    req.onsuccess = () => resolve(trip);
    req.onerror = () => reject(req.error);
  });
}

async function getAllTrips() {
  const store = await tx(TRIPS_STORE, 'readonly');
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => {
      const trips = req.result || [];
      trips.sort((a, b) => b.createdAt - a.createdAt);
      resolve(trips);
    };
    req.onerror = () => reject(req.error);
  });
}

async function getTrip(id) {
  const store = await tx(TRIPS_STORE, 'readonly');
  return new Promise((resolve, reject) => {
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function deleteTrip(id) {
  const entries = await getEntriesForTrip(id);
  const entryStore = await tx(ENTRIES_STORE, 'readwrite');
  await Promise.all(
    entries.map(
      (entry) =>
        new Promise((resolve, reject) => {
          const req = entryStore.delete(entry.id);
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
        })
    )
  );

  const documents = await getDocumentsForTrip(id);
  const documentStore = await tx(DOCUMENTS_STORE, 'readwrite');
  await Promise.all(
    documents.map(
      (doc) =>
        new Promise((resolve, reject) => {
          const req = documentStore.delete(doc.id);
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
        })
    )
  );

  const checklistItems = await getChecklistItemsForTrip(id);
  const checklistStore = await tx(CHECKLIST_STORE, 'readwrite');
  await Promise.all(
    checklistItems.map(
      (item) =>
        new Promise((resolve, reject) => {
          const req = checklistStore.delete(item.id);
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
        })
    )
  );

  const tripStore = await tx(TRIPS_STORE, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = tripStore.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ---------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------

async function createEntry(fields) {
  const store = await tx(ENTRIES_STORE, 'readwrite');
  const entry = {
    id: makeId(),
    tripId: fields.tripId,
    // Si renseigné, prix/référence/statut/PDF vivent sur ce document
    // partagé (billet combiné) plutôt que sur l'entrée elle-même.
    documentId: fields.documentId || null,
    type: fields.type || 'other',
    title: fields.title || 'Sans titre',
    startDate: fields.startDate || null,
    startTime: fields.startTime || null,
    endDate: fields.endDate || null,
    endTime: fields.endTime || null,
    place: fields.place || '',
    address: fields.address || '',
    // Coordonnées GPS optionnelles (voir js/app.js "Définir la position") :
    // utilisées pour affiner le bouton 📍 et estimer le temps de trajet à
    // vol d'oiseau entre deux entrées consécutives du planning. Pas de
    // géocodage automatique de l'adresse (nécessiterait un service en
    // ligne) — l'utilisateur les capture lui-même via la géolocalisation
    // du téléphone.
    latitude: fields.latitude === '' || fields.latitude === undefined || fields.latitude === null ? null : Number(fields.latitude),
    longitude: fields.longitude === '' || fields.longitude === undefined || fields.longitude === null ? null : Number(fields.longitude),
    price: fields.price === '' || fields.price === undefined || fields.price === null ? null : Number(fields.price),
    reference: fields.reference || '',
    paymentStatus: fields.paymentStatus || 'estimate',
    // 'default' (utilise le réglage global) | 'custom' (voir reminderMinutes) | 'none'
    reminderMode: fields.reminderMode || 'default',
    reminderMinutes: fields.reminderMinutes === '' || fields.reminderMinutes === undefined || fields.reminderMinutes === null ? null : Number(fields.reminderMinutes),
    pdfBlob: fields.pdfBlob || null,
    pdfName: fields.pdfName || null,
    addedAt: Date.now(),
  };
  return new Promise((resolve, reject) => {
    const req = store.add(entry);
    req.onsuccess = () => resolve(entry);
    req.onerror = () => reject(req.error);
  });
}

async function updateEntry(entry) {
  const store = await tx(ENTRIES_STORE, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.put(entry);
    req.onsuccess = () => resolve(entry);
    req.onerror = () => reject(req.error);
  });
}

async function getEntriesForTrip(tripId) {
  const store = await tx(ENTRIES_STORE, 'readonly');
  return new Promise((resolve, reject) => {
    const req = store.index('tripId').getAll(tripId);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

/** Toutes les entrées, tous voyages confondus — utilisé pour planifier les rappels. */
async function getAllEntries() {
  const store = await tx(ENTRIES_STORE, 'readonly');
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function getEntry(id) {
  const store = await tx(ENTRIES_STORE, 'readonly');
  return new Promise((resolve, reject) => {
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function deleteEntry(id) {
  const store = await tx(ENTRIES_STORE, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ---------------------------------------------------------------------
// Documents (billets combinés — un PDF, plusieurs entrées de planning)
// ---------------------------------------------------------------------

/**
 * Crée le document partagé d'un billet combiné : son PDF, son prix TOTAL,
 * sa référence et son statut de paiement — comptés une seule fois même si
 * plusieurs entrées de planning le référencent (via `entry.documentId`).
 */
async function createDocument(fields) {
  const store = await tx(DOCUMENTS_STORE, 'readwrite');
  const doc = {
    id: makeId(),
    tripId: fields.tripId,
    // Titre affiché sur la carte "Billet combiné" (onglet Entrées) — extrait
    // du texte du PDF si possible, sinon du nom de fichier (voir js/parser.js).
    title: fields.title || 'Billet combiné',
    pdfBlob: fields.pdfBlob || null,
    pdfName: fields.pdfName || null,
    price: fields.price === '' || fields.price === undefined || fields.price === null ? null : Number(fields.price),
    reference: fields.reference || '',
    paymentStatus: fields.paymentStatus || 'estimate',
    addedAt: Date.now(),
  };
  return new Promise((resolve, reject) => {
    const req = store.add(doc);
    req.onsuccess = () => resolve(doc);
    req.onerror = () => reject(req.error);
  });
}

async function updateDocument(doc) {
  const store = await tx(DOCUMENTS_STORE, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.put(doc);
    req.onsuccess = () => resolve(doc);
    req.onerror = () => reject(req.error);
  });
}

async function getDocument(id) {
  const store = await tx(DOCUMENTS_STORE, 'readonly');
  return new Promise((resolve, reject) => {
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function getDocumentsForTrip(tripId) {
  const store = await tx(DOCUMENTS_STORE, 'readonly');
  return new Promise((resolve, reject) => {
    const req = store.index('tripId').getAll(tripId);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function getEntriesForDocument(documentId) {
  const store = await tx(ENTRIES_STORE, 'readonly');
  return new Promise((resolve, reject) => {
    const req = store.index('documentId').getAll(documentId);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

/** Supprime le document ET toutes les entrées de planning qui le référencent. */
async function deleteDocument(id) {
  const linkedEntries = await getEntriesForDocument(id);
  const entryStore = await tx(ENTRIES_STORE, 'readwrite');
  await Promise.all(
    linkedEntries.map(
      (entry) =>
        new Promise((resolve, reject) => {
          const req = entryStore.delete(entry.id);
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
        })
    )
  );
  const docStore = await tx(DOCUMENTS_STORE, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = docStore.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ---------------------------------------------------------------------
// Règles de correction apprises (import PDF)
// ---------------------------------------------------------------------

function correctionId(docSignature, field) {
  return `${docSignature}::${field}`;
}

/** Retourne la règle apprise pour (signature de document, champ), ou null. */
async function getCorrectionRule(docSignature, field) {
  if (!docSignature) return null;
  const store = await tx(CORRECTIONS_STORE, 'readonly');
  return new Promise((resolve, reject) => {
    const req = store.get(correctionId(docSignature, field));
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Enregistre/actualise la préférence apprise : pour ce type de document,
 * préfère désormais la valeur associée au libellé `preferLabel` (ex.
 * "Total") pour ce champ. Un import ultérieur du même type de document
 * l'appliquera avant la simple heuristique par défaut.
 */
async function saveCorrectionRule(docSignature, field, preferLabel) {
  const store = await tx(CORRECTIONS_STORE, 'readwrite');
  const rule = { id: correctionId(docSignature, field), docSignature, field, preferLabel, updatedAt: Date.now() };
  return new Promise((resolve, reject) => {
    const req = store.put(rule);
    req.onsuccess = () => resolve(rule);
    req.onerror = () => reject(req.error);
  });
}

// ---------------------------------------------------------------------
// Checklist (par voyage — texte libre, coché/non coché, pas de suggestion
// automatique de contenu)
// ---------------------------------------------------------------------

async function createChecklistItem({ tripId, text }) {
  const store = await tx(CHECKLIST_STORE, 'readwrite');
  const item = { id: makeId(), tripId, text: (text || '').trim(), checked: false, addedAt: Date.now() };
  return new Promise((resolve, reject) => {
    const req = store.add(item);
    req.onsuccess = () => resolve(item);
    req.onerror = () => reject(req.error);
  });
}

async function updateChecklistItem(item) {
  const store = await tx(CHECKLIST_STORE, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.put(item);
    req.onsuccess = () => resolve(item);
    req.onerror = () => reject(req.error);
  });
}

async function deleteChecklistItem(id) {
  const store = await tx(CHECKLIST_STORE, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function getChecklistItemsForTrip(tripId) {
  const store = await tx(CHECKLIST_STORE, 'readonly');
  return new Promise((resolve, reject) => {
    const req = store.index('tripId').getAll(tripId);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

// ---------------------------------------------------------------------
// Sauvegarde / restauration complète (export-import JSON — voir js/app.js)
// ---------------------------------------------------------------------

async function getAllDocuments() {
  const store = await tx(DOCUMENTS_STORE, 'readonly');
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function getAllChecklistItems() {
  const store = await tx(CHECKLIST_STORE, 'readonly');
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function putRaw(storeName, record) {
  return tx(storeName, 'readwrite').then(
    (store) =>
      new Promise((resolve, reject) => {
        const req = store.put(record);
        req.onsuccess = () => resolve(record);
        req.onerror = () => reject(req.error);
      })
  );
}

// Réinsèrent un enregistrement TEL QUEL (id d'origine conservé) — utilisé
// uniquement par la restauration d'une sauvegarde, pour préserver les
// références croisées (entry.tripId, entry.documentId...) telles qu'elles
// étaient au moment de l'export.
function restoreTrip(trip) {
  return putRaw(TRIPS_STORE, trip);
}
function restoreEntry(entry) {
  return putRaw(ENTRIES_STORE, entry);
}
function restoreDocument(doc) {
  return putRaw(DOCUMENTS_STORE, doc);
}
function restoreChecklistItem(item) {
  return putRaw(CHECKLIST_STORE, item);
}

/**
 * Vide entièrement voyages/entrées/documents/checklists — pas les règles
 * de correction apprises, propres à cet appareil et sans rapport avec les
 * données du voyageur. Utilisé avant de restaurer une sauvegarde en mode
 * "remplacer" (voir js/app.js).
 */
async function clearAllData() {
  for (const storeName of [TRIPS_STORE, ENTRIES_STORE, DOCUMENTS_STORE, CHECKLIST_STORE]) {
    const store = await tx(storeName, 'readwrite');
    await new Promise((resolve, reject) => {
      const req = store.clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }
}

export const VoyagheureDB = {
  createTrip,
  updateTrip,
  getAllTrips,
  getTrip,
  deleteTrip,
  createEntry,
  updateEntry,
  getEntriesForTrip,
  getAllEntries,
  getEntry,
  deleteEntry,
  createDocument,
  updateDocument,
  getDocument,
  getDocumentsForTrip,
  getEntriesForDocument,
  deleteDocument,
  getCorrectionRule,
  saveCorrectionRule,
  createChecklistItem,
  updateChecklistItem,
  deleteChecklistItem,
  getChecklistItemsForTrip,
  getAllDocuments,
  getAllChecklistItems,
  restoreTrip,
  restoreEntry,
  restoreDocument,
  restoreChecklistItem,
  clearAllData,
};
