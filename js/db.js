/**
 * Couche IndexedDB de Voyag'heure.
 *
 * Deux stores :
 *  - "trips"   : les voyages/événements créés par l'utilisateur.
 *  - "entries" : les entrées (billets, transport, hébergement, dépenses
 *                manuelles) rattachées à un voyage, PDF original inclus.
 *
 * Rien de spécifique à un événement précis n'est codé ici : toutes les
 * données viennent de l'utilisateur, à la création du voyage ou à
 * l'import/l'ajout d'une entrée.
 */

const DB_NAME = 'voyagheure-db';
const DB_VERSION = 1;
const TRIPS_STORE = 'trips';
const ENTRIES_STORE = 'entries';

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
    type: fields.type || 'other',
    title: fields.title || 'Sans titre',
    startDate: fields.startDate || null,
    startTime: fields.startTime || null,
    endDate: fields.endDate || null,
    endTime: fields.endTime || null,
    place: fields.place || '',
    price: fields.price === '' || fields.price === undefined ? null : Number(fields.price),
    reference: fields.reference || '',
    paymentStatus: fields.paymentStatus || 'estimate',
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

export const VoyagheureDB = {
  createTrip,
  updateTrip,
  getAllTrips,
  getTrip,
  deleteTrip,
  createEntry,
  updateEntry,
  getEntriesForTrip,
  getEntry,
  deleteEntry,
};
