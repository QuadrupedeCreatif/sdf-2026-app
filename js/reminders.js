/**
 * Rappels locaux avant chaque événement du planning.
 *
 * Limite technique importante (voir README) : ceci repose sur des
 * `setTimeout` programmés depuis la page, via la Service Worker
 * Notification API. Ça ne fonctionne QUE tant que l'app reste ouverte
 * (même en arrière-plan d'un onglet/app encore en mémoire) :
 *  - Android/Chrome : fonctionne raisonnablement bien tant que Chrome
 *    n'a pas été fermé/tué et que l'app n'a pas été retirée des apps
 *    récentes.
 *  - iOS/Safari : très limité. Sans serveur de notifications push
 *    (Web Push + VAPID), une PWA installée sur iOS ne peut PAS recevoir
 *    de notification programmée pendant qu'elle est fermée ou en
 *    arrière-plan — iOS suspend le processus. Le rappel ne se
 *    déclenchera que si Voyag'heure est ouverte au premier plan au
 *    moment voulu. Comme cette app est 100% locale (pas de backend),
 *    on ne peut pas contourner cette limite d'iOS.
 */
import { VoyagheureDB } from './db.js';

const SETTINGS_KEY = 'voyagheure-settings';
const DEFAULT_SETTINGS = { remindersEnabled: false, defaultMinutes: 30 };
const MAX_DELAY_MS = 20 * 24 * 60 * 60 * 1000; // 20 jours (marge sous la limite 32-bit de setTimeout)

let scheduledTimeouts = new Map(); // entryId -> timeoutId

function getSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch (err) {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function notificationsSupported() {
  return 'Notification' in window && 'serviceWorker' in navigator;
}

function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
}

async function ensurePermission() {
  if (!notificationsSupported()) return 'unsupported';
  if (Notification.permission === 'granted' || Notification.permission === 'denied') {
    return Notification.permission;
  }
  try {
    return await Notification.requestPermission();
  } catch (err) {
    return Notification.permission;
  }
}

function reminderMinutesFor(entry, settings) {
  if (entry.reminderMode === 'none') return null;
  if (entry.reminderMode === 'custom' && entry.reminderMinutes !== null && entry.reminderMinutes !== undefined) {
    return entry.reminderMinutes;
  }
  return settings.defaultMinutes;
}

async function showReminder(entry) {
  try {
    const reg = await navigator.serviceWorker.ready;
    const bits = [];
    if (entry.startTime) bits.push(entry.startTime);
    if (entry.place) bits.push(entry.place);
    await reg.showNotification(entry.title, {
      body: bits.join(' · ') || 'Ça commence bientôt',
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      tag: `reminder-${entry.id}`,
      data: { entryId: entry.id, tripId: entry.tripId },
    });
  } catch (err) {
    console.warn('Impossible d’afficher la notification de rappel', err);
  }
}

function clearAllTimeouts() {
  scheduledTimeouts.forEach((id) => clearTimeout(id));
  scheduledTimeouts.clear();
}

/**
 * Recalcule et reprogramme tous les rappels à venir (tous voyages
 * confondus). À appeler après toute mutation d'entrée et au chargement
 * de l'app. No-op silencieux si les rappels sont désactivés, non
 * supportés, ou la permission pas accordée.
 */
async function rescheduleAll() {
  clearAllTimeouts();

  const settings = getSettings();
  if (!settings.remindersEnabled) return;
  if (!notificationsSupported() || Notification.permission !== 'granted') return;

  let entries;
  try {
    entries = await VoyagheureDB.getAllEntries();
  } catch (err) {
    return;
  }

  const now = Date.now();
  entries.forEach((entry) => {
    if (!entry.startDate || !entry.startTime) return;
    const minutesBefore = reminderMinutesFor(entry, settings);
    if (minutesBefore === null) return;

    const eventTime = new Date(`${entry.startDate}T${entry.startTime}`).getTime();
    if (Number.isNaN(eventTime)) return;

    const fireAt = eventTime - minutesBefore * 60_000;
    const delay = fireAt - now;
    if (delay <= 0 || delay > MAX_DELAY_MS) return;

    const timeoutId = setTimeout(() => showReminder(entry), delay);
    scheduledTimeouts.set(entry.id, timeoutId);
  });
}

export const VoyagheureReminders = {
  getSettings,
  saveSettings,
  notificationsSupported,
  isIOS,
  ensurePermission,
  rescheduleAll,
};
