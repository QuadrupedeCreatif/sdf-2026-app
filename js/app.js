import { VoyagheureDB } from './db.js';
import { VoyagheureParser } from './parser.js';
import { VoyagheureReminders } from './reminders.js';

(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const state = {
    view: 'home', // 'home' | 'trip'
    currentTrip: null,
    activeTab: 'documents',
  };

  let importQueue = [];
  let entryCtx = null; // { mode: 'import'|'manual'|'edit', file?, parsed?, existingEntry? }
  let combinedCtx = null; // { file, events: [{type,title,startDate,startTime,endTime,place,address}] }
  let documentCtx = null; // { doc, linkedEntries } — édition d'un billet combiné existant

  // Documents partagés (billets combinés) du voyage courant, indexés par id
  // — repeuplé à chaque refreshAll(). Une entrée avec `documentId` va lire
  // son prix/référence/statut/PDF ici plutôt que sur ses propres champs
  // (qui restent null pour ce type d'entrée, voir js/db.js).
  let docsById = new Map();

  function docFor(entry) {
    return entry.documentId ? docsById.get(entry.documentId) || null : null;
  }
  function effectivePrice(entry) {
    const doc = docFor(entry);
    return doc ? doc.price : entry.price;
  }
  function effectiveReference(entry) {
    const doc = docFor(entry);
    return doc ? doc.reference : entry.reference;
  }
  function effectivePaymentStatus(entry) {
    const doc = docFor(entry);
    return doc ? doc.paymentStatus : entry.paymentStatus;
  }
  function effectivePdfBlob(entry) {
    const doc = docFor(entry);
    return doc ? doc.pdfBlob : entry.pdfBlob;
  }
  function effectivePdfName(entry) {
    const doc = docFor(entry);
    return doc ? doc.pdfName : entry.pdfName;
  }

  // ---------------------------------------------------------------------
  // Utils
  // ---------------------------------------------------------------------
  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function formatAmount(n) {
    return Number(n).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function formatDateLabel(iso) {
    const d = new Date(`${iso}T00:00:00`);
    if (Number.isNaN(d.getTime())) return iso;
    const s = d.toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: 'long' });
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function formatDateShort(iso) {
    const d = new Date(`${iso}T00:00:00`);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  function formatFileSize(bytes) {
    if (bytes < 1024) return `${bytes} o`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} Ko`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
  }

  function openBlobInNewTab(blob, name) {
    const url = URL.createObjectURL(blob);
    const win = window.open(url, '_blank');
    if (!win) {
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.click();
    }
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  function isImageBlob(blob) {
    return !!blob && typeof blob.type === 'string' && blob.type.startsWith('image/');
  }

  function attachmentViewLabel(blob) {
    return isImageBlob(blob) ? "Voir l'original" : 'Voir le PDF';
  }

  // Deux modes d'import comptent comme "import" (queue, valeurs par défaut,
  // pièce jointe attachée à la sauvegarde) : PDF (auto-détecté) et image
  // (formulaire assisté sans extraction).
  function isImportMode(mode) {
    return mode === 'import' || mode === 'import-image';
  }

  function isIOSDevice() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  }

  /** Ouvre l'app de navigation du téléphone (Plans sur iOS, Google Maps
   *  sinon). Préfère les coordonnées GPS (plus précises) si l'entrée en a
   *  une (voir "Enregistrer ma position ici"), sinon utilise l'adresse texte. */
  function openInMaps(entry) {
    const hasCoords = entry.latitude != null && entry.longitude != null;
    const query = hasCoords ? `${entry.latitude},${entry.longitude}` : encodeURIComponent(entry.address);
    const url = isIOSDevice()
      ? `https://maps.apple.com/?q=${query}`
      : `https://www.google.com/maps/search/?api=1&query=${query}`;
    window.open(url, '_blank', 'noopener');
  }

  /** Comportement partagé Documents/Planning : ouvre le PDF/image d'origine
   *  s'il y en a un (viewer natif du téléphone), sinon ouvre l'édition. */
  function openEntryAttachmentOrEdit(entry) {
    // Une entrée issue d'un billet combiné n'a pas son propre PDF : elle
    // pointe vers celui du document partagé (même PDF/QR pour tous les
    // événements qu'il couvre).
    const blob = effectivePdfBlob(entry);
    if (blob) {
      openBlobInNewTab(blob, effectivePdfName(entry) || entry.title);
    } else {
      openEntryModal({ mode: 'edit', existingEntry: entry });
    }
  }

  function timeToMinutes(hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  }

  function formatDuration(minutes) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (h === 0) return `${m} min`;
    if (m === 0) return `${h} h`;
    return `${h} h ${m}`;
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  /** Date du jour au format YYYY-MM-DD, en heure LOCALE (pas UTC) — pour
   *  comparer à `entry.startDate` tel que saisi/détecté. */
  function todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  // -----------------------------------------------------------------
  // Distance à vol d'oiseau (Haversine) + estimation de temps de trajet
  // -----------------------------------------------------------------
  // Pas de calcul d'itinéraire routier réel (nécessiterait un service en
  // ligne + clé API) : une estimation simple à partir de la distance
  // directe entre deux points GPS, suffisante pour repérer un risque de
  // retard sans rien casser du fonctionnement 100% hors-ligne.
  function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const toRad = (v) => (v * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  const WALK_SPEED_KMH = 5;
  const TRANSIT_SPEED_KMH = 25;
  const TRANSIT_OVERHEAD_MIN = 10; // marche d'approche + attente
  const WALK_THRESHOLD_KM = 2;

  /** Mode de transport par défaut selon la distance : marche en dessous de
   *  2 km, transport en commun au-delà (+ forfait fixe d'approche/attente). */
  function estimateTravel(distanceKm) {
    if (distanceKm <= WALK_THRESHOLD_KM) {
      return { icon: '🚶', mode: 'walk', minutes: Math.max(1, Math.round((distanceKm / WALK_SPEED_KMH) * 60)) };
    }
    return {
      icon: '🚇',
      mode: 'transit',
      minutes: Math.round((distanceKm / TRANSIT_SPEED_KMH) * 60) + TRANSIT_OVERHEAD_MIN,
    };
  }

  // Champs pré-remplissables par l'import PDF, mappés vers l'id de leur
  // <input>/<select> — utilisé pour lire/écrire la valeur indifféremment
  // qu'elle vienne d'un champ riche `{value,snippet,confidence}` (import)
  // ou d'une entrée simple déjà en base (édition).
  const DETECTABLE_FIELDS = {
    type: 'entry-type',
    startDate: 'entry-start-date',
    startTime: 'entry-start-time',
    endDate: 'entry-end-date',
    place: 'entry-place',
    address: 'entry-address',
    price: 'entry-price',
    reference: 'entry-reference',
  };

  /** Lit la valeur d'un champ, qu'il soit riche `{value,...}` (import) ou brut (édition/manuel). */
  function fieldValue(f) {
    if (f && typeof f === 'object' && 'value' in f) return f.value;
    return f;
  }

  function truncate(str, max) {
    if (!str) return '';
    return str.length > max ? `${str.slice(0, max).trim()}…` : str;
  }

  function clearFieldHints() {
    Object.values(DETECTABLE_FIELDS).forEach((inputId) => {
      const hint = document.getElementById(`${inputId}-hint`);
      if (hint) {
        hint.hidden = true;
        hint.textContent = '';
      }
      const fieldLabel = document.getElementById(inputId)?.closest('.field');
      if (fieldLabel) fieldLabel.classList.remove('field--unsure');
    });
  }

  /**
   * Affiche, sous chaque champ pré-rempli par l'import, l'extrait de texte
   * source qui a servi à sa détection ; un champ sans détection fiable
   * reste vide et est signalé (bordure + icône) plutôt que deviné.
   * `parsed` doit être le résultat riche de VoyagheureParser.analyzePdf
   * (ou VoyagheureParser.emptyAnalysis pour une image).
   */
  function applyFieldHints(parsed) {
    clearFieldHints();
    if (!parsed) return;
    Object.entries(DETECTABLE_FIELDS).forEach(([key, inputId]) => {
      const f = parsed[key];
      if (!f || typeof f !== 'object') return;
      const hint = document.getElementById(`${inputId}-hint`);
      const fieldLabel = document.getElementById(inputId)?.closest('.field');
      if (f.confidence && f.snippet) {
        if (hint) {
          hint.hidden = false;
          hint.textContent = `détecté depuis : « ${truncate(f.snippet, 70)} »`;
        }
      } else if (fieldLabel) {
        fieldLabel.classList.add('field--unsure');
      }
    });
  }

  const TYPE_META = {
    transport: { icon: '🚌', label: 'Transport' },
    event: { icon: '🎟️', label: 'Billet événement' },
    lodging: { icon: '🛏️', label: 'Hébergement' },
    other: { icon: '🧾', label: 'Autre' },
  };

  const PAYMENT_META = {
    paid: { icon: '✅', label: 'Déjà payé' },
    due: { icon: '⏳', label: 'À venir' },
    estimate: { icon: '🎲', label: 'Estimé' },
  };

  // ---------------------------------------------------------------------
  // Modales génériques
  // ---------------------------------------------------------------------
  function showModal(sel) {
    const modal = $(sel);
    modal.hidden = false;
    requestAnimationFrame(() => modal.classList.add('is-open'));
  }

  function hideModal(sel) {
    const modal = $(sel);
    modal.classList.remove('is-open');
    setTimeout(() => {
      modal.hidden = true;
    }, 150);
  }

  $$('.modal').forEach((modal) => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) hideModal(`#${modal.id}`);
    });
  });

  // ---------------------------------------------------------------------
  // Navigation accueil / voyage
  // ---------------------------------------------------------------------
  function showView(view) {
    state.view = view;
    $('#view-home').hidden = view !== 'home';
    $('#view-trip').hidden = view !== 'trip';
    $('#header-home').hidden = view !== 'home';
    $('#header-trip').hidden = view !== 'trip';
    $('#tab-bar').hidden = view !== 'trip';
  }

  async function goHome() {
    state.currentTrip = null;
    showView('home');
    await renderHome();
  }

  async function openTrip(tripId) {
    const trip = await VoyagheureDB.getTrip(tripId);
    if (!trip) return;
    state.currentTrip = trip;
    showView('trip');
    $('#trip-title').textContent = trip.name;
    const bits = [trip.place, [trip.startDate, trip.endDate].filter(Boolean).map(formatDateShort).join(' → ')].filter(Boolean);
    $('#trip-subtitle').textContent = bits.join(' · ');
    const entries = await refreshAll();
    // Accès immédiat à la vue "Aujourd'hui" (Planning) si ce voyage a des
    // entrées pour la date du jour, sans avoir à chercher dans le planning
    // complet — sinon comportement inchangé (onglet Entrées par défaut).
    const hasToday = (entries || []).some((e) => e.startDate === todayISO());
    switchTab(hasToday ? 'planning' : 'documents');
  }

  // ---------------------------------------------------------------------
  // Écran d'accueil : liste des voyages
  // ---------------------------------------------------------------------
  async function renderHome() {
    const trips = await VoyagheureDB.getAllTrips();
    const list = $('#trips-list');
    list.innerHTML = '';
    $('#trips-empty').hidden = trips.length > 0;

    for (const trip of trips) {
      const entries = await VoyagheureDB.getEntriesForTrip(trip.id);
      const li = document.createElement('li');
      li.className = 'trip-card';

      const openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'trip-card__open';
      const dateRange = [trip.startDate, trip.endDate].filter(Boolean).map(formatDateShort).join(' → ');
      openBtn.innerHTML = `
        <span class="trip-card__icon" aria-hidden="true">🧳</span>
        <span class="trip-card__body">
          <span class="trip-card__name">${escapeHtml(trip.name)}</span>
          <span class="trip-card__meta">${[escapeHtml(trip.place), dateRange].filter(Boolean).join(' · ') || 'Aucune date renseignée'}</span>
          <span class="trip-card__count">${entries.length} entrée${entries.length > 1 ? 's' : ''}</span>
        </span>
      `;
      openBtn.addEventListener('click', () => openTrip(trip.id));

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'trip-card__delete';
      deleteBtn.setAttribute('aria-label', `Supprimer ${trip.name}`);
      deleteBtn.textContent = '✕';
      deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (confirm(`Supprimer le voyage "${trip.name}" et toutes ses entrées ?`)) {
          await VoyagheureDB.deleteTrip(trip.id);
          renderHome();
          VoyagheureReminders.rescheduleAll();
        }
      });

      li.appendChild(openBtn);
      li.appendChild(deleteBtn);
      list.appendChild(li);
    }
  }

  function openTripModal() {
    $('#trip-form').reset();
    showModal('#trip-modal');
    $('#trip-name').focus();
  }

  $('#new-trip-btn').addEventListener('click', openTripModal);
  $('#trip-cancel').addEventListener('click', () => hideModal('#trip-modal'));
  $('#back-to-home').addEventListener('click', goHome);

  $('#trip-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#trip-name').value.trim();
    if (!name) return;
    const trip = await VoyagheureDB.createTrip({
      name,
      place: $('#trip-place').value.trim(),
      startDate: $('#trip-start').value || null,
      endDate: $('#trip-end').value || null,
    });
    hideModal('#trip-modal');
    await openTrip(trip.id);
  });

  // ---------------------------------------------------------------------
  // Onglets (au sein d'un voyage)
  // ---------------------------------------------------------------------
  function switchTab(tab) {
    state.activeTab = tab;
    $$('.tab-panel').forEach((panel) => {
      panel.hidden = panel.dataset.tabPanel !== tab;
    });
    $$('.tab-bar__btn').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.tab === tab);
    });
  }

  $$('.tab-bar__btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  async function refreshAll() {
    if (!state.currentTrip) return [];
    const [entries, documents] = await Promise.all([
      VoyagheureDB.getEntriesForTrip(state.currentTrip.id),
      VoyagheureDB.getDocumentsForTrip(state.currentTrip.id),
    ]);
    docsById = new Map(documents.map((doc) => [doc.id, doc]));
    renderEntries(entries);
    renderPlanning(entries);
    renderBudget(entries);
    await renderChecklist();
    VoyagheureReminders.rescheduleAll();
    return entries;
  }

  // ---------------------------------------------------------------------
  // Onglet Entrées (import / liste / ajout manuel)
  // ---------------------------------------------------------------------
  function renderEntries(entries) {
    const list = $('#entries-list');
    list.innerHTML = '';

    // Une entrée issue d'un billet combiné (documentId renseigné) ne
    // s'affiche pas comme une carte individuelle ici : toutes celles qui
    // partagent le même document sont regroupées en UNE carte "billet
    // combiné" (voir renderCombinedDocCard) — le PDF/QR est unique, pas
    // besoin de le montrer une fois par événement.
    const standalone = entries.filter((e) => !e.documentId);
    const grouped = new Map(); // documentId -> entries[]
    entries
      .filter((e) => e.documentId)
      .forEach((e) => {
        if (!grouped.has(e.documentId)) grouped.set(e.documentId, []);
        grouped.get(e.documentId).push(e);
      });

    $('#entries-empty').hidden = standalone.length > 0 || grouped.size > 0;

    const sortedStandalone = [...standalone].sort((a, b) => b.addedAt - a.addedAt);
    sortedStandalone.forEach((entry) => renderEntryCard(list, entry));

    Array.from(grouped.entries())
      .sort((a, b) => (docsById.get(b[0])?.addedAt || 0) - (docsById.get(a[0])?.addedAt || 0))
      .forEach(([documentId, linkedEntries]) => renderCombinedDocCard(list, documentId, linkedEntries));
  }

  function renderEntryCard(list, entry) {
    const meta = TYPE_META[entry.type] || TYPE_META.other;
    const li = document.createElement('li');
    li.className = `doc-card type-${entry.type}`;

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'doc-card__open';
    const metaBits = [
      meta.label,
      entry.startDate ? formatDateShort(entry.startDate) : null,
      entry.price != null ? `${formatAmount(entry.price)} €` : null,
    ].filter(Boolean);
    openBtn.innerHTML = `
      <span class="doc-card__icon" aria-hidden="true">${meta.icon}</span>
      <span class="doc-card__body">
        <span class="doc-card__name">${escapeHtml(entry.title)}</span>
        <div class="doc-card__meta">${escapeHtml(metaBits.join(' · '))}</div>
      </span>
    `;
    openBtn.addEventListener('click', () => openEntryAttachmentOrEdit(entry));

    li.appendChild(openBtn);

    if (entry.address) {
      const mapBtn = document.createElement('button');
      mapBtn.type = 'button';
      mapBtn.className = 'doc-card__map';
      mapBtn.setAttribute('aria-label', `Itinéraire vers ${entry.address}`);
      mapBtn.textContent = '📍';
      mapBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openInMaps(entry);
      });
      li.appendChild(mapBtn);
    }

    if (entry.pdfBlob) {
      const scanBtn = document.createElement('button');
      scanBtn.type = 'button';
      scanBtn.className = 'doc-card__scan';
      scanBtn.setAttribute('aria-label', 'Afficher pour scan');
      scanBtn.textContent = '🔳';
      scanBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openScanModal(entry.pdfBlob, entry.pdfName || entry.title);
      });
      li.appendChild(scanBtn);
    }

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'doc-card__edit';
    editBtn.setAttribute('aria-label', `Modifier ${entry.title}`);
    editBtn.textContent = '✎';
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openEntryModal({ mode: 'edit', existingEntry: entry });
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'doc-card__delete';
    deleteBtn.setAttribute('aria-label', `Supprimer ${entry.title}`);
    deleteBtn.textContent = '✕';
    deleteBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm(`Supprimer "${entry.title}" ?`)) {
        await VoyagheureDB.deleteEntry(entry.id);
        refreshAll();
      }
    });

    li.appendChild(editBtn);
    li.appendChild(deleteBtn);
    list.appendChild(li);
  }

  /** Carte unique pour un billet combiné : un PDF/QR/prix partagé par
   *  plusieurs événements de planning, listés en sous-titre. */
  function renderCombinedDocCard(list, documentId, linkedEntries) {
    const doc = docsById.get(documentId);
    if (!doc) return; // ne devrait pas arriver (document supprimé sans cascade)
    const sorted = [...linkedEntries].sort((a, b) =>
      `${a.startDate || ''}${a.startTime || ''}`.localeCompare(`${b.startDate || ''}${b.startTime || ''}`)
    );

    const li = document.createElement('li');
    li.className = 'doc-card doc-card--combined';

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'doc-card__open';
    const metaBits = [
      'Billet combiné',
      `${sorted.length} événements`,
      doc.price != null ? `${formatAmount(doc.price)} €` : null,
    ].filter(Boolean);
    const subtitle = sorted
      .map((e) => `${escapeHtml(e.title)}${e.startDate ? ` (${formatDateShort(e.startDate)})` : ''}`)
      .join(' · ');
    openBtn.innerHTML = `
      <span class="doc-card__icon" aria-hidden="true">🎫</span>
      <span class="doc-card__body">
        <span class="doc-card__name">${escapeHtml(doc.title || 'Billet combiné')}</span>
        <div class="doc-card__meta">${escapeHtml(metaBits.join(' · '))}</div>
        <div class="doc-card__combined-events">${subtitle}</div>
      </span>
    `;
    openBtn.addEventListener('click', () => {
      if (doc.pdfBlob) openBlobInNewTab(doc.pdfBlob, doc.pdfName || 'Billet combiné');
      else openDocumentModal(doc, sorted);
    });
    li.appendChild(openBtn);

    if (doc.pdfBlob) {
      const scanBtn = document.createElement('button');
      scanBtn.type = 'button';
      scanBtn.className = 'doc-card__scan';
      scanBtn.setAttribute('aria-label', 'Afficher pour scan');
      scanBtn.textContent = '🔳';
      scanBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openScanModal(doc.pdfBlob, doc.pdfName || doc.title);
      });
      li.appendChild(scanBtn);
    }

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'doc-card__edit';
    editBtn.setAttribute('aria-label', 'Modifier le billet combiné');
    editBtn.textContent = '✎';
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openDocumentModal(doc, sorted);
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'doc-card__delete';
    deleteBtn.setAttribute('aria-label', 'Supprimer le billet combiné');
    deleteBtn.textContent = '✕';
    deleteBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm(`Supprimer ce billet combiné et ses ${sorted.length} événements ?`)) {
        await VoyagheureDB.deleteDocument(doc.id);
        refreshAll();
      }
    });

    li.appendChild(editBtn);
    li.appendChild(deleteBtn);
    list.appendChild(li);
  }

  // ---------------------------------------------------------------------
  // Plein écran "à scanner" (QR code / code-barres)
  // ---------------------------------------------------------------------
  // Aucune API web standard ne permet de forcer la luminosité de l'écran :
  // on utilise le Wake Lock pour au moins empêcher la mise en veille
  // pendant le scan, et on affiche une consigne explicite pour le reste.
  let scanWakeLock = null;
  let scanObjectUrl = null;

  async function requestScanWakeLock() {
    const hint = $('#scan-modal-hint');
    if (!('wakeLock' in navigator)) {
      hint.textContent =
        '💡 Augmente la luminosité de ton écran à la main : ce navigateur ne permet pas de la forcer, ni d’empêcher la mise en veille automatiquement.';
      return;
    }
    try {
      scanWakeLock = await navigator.wakeLock.request('screen');
      hint.textContent = '💡 Augmente la luminosité de ton écran à la main pour un scan optimal — elle ne peut pas être forcée automatiquement.';
    } catch (err) {
      scanWakeLock = null;
      hint.textContent = '💡 Augmente la luminosité de ton écran à la main pour un scan optimal.';
    }
  }

  async function releaseScanWakeLock() {
    if (scanWakeLock) {
      try {
        await scanWakeLock.release();
      } catch (err) {
        // déjà relâché (ex. app passée en arrière-plan) — sans conséquence
      }
      scanWakeLock = null;
    }
  }

  // Le Wake Lock est automatiquement relâché quand l'onglet passe en
  // arrière-plan (ex. bascule d'app pour ouvrir le scanner) : on le
  // redemande dès que l'app redevient visible, tant que la modale est ouverte.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !$('#scan-modal').hidden && !scanWakeLock) {
      requestScanWakeLock();
    }
  });

  /** Affiche un PDF/image en plein écran, fond blanc, pour faciliter le
   *  scan de son QR code/code-barres par un tiers. */
  async function openScanModal(blob, name) {
    // Demandé en tout premier, avant tout `await` intermédiaire : certains
    // navigateurs exigent que l'appel reste rattaché au geste utilisateur
    // (le clic) qui a déclenché cette fonction.
    const wakeLockPromise = requestScanWakeLock();

    const img = $('#scan-image');
    if (scanObjectUrl) {
      URL.revokeObjectURL(scanObjectUrl);
      scanObjectUrl = null;
    }

    if (isImageBlob(blob)) {
      scanObjectUrl = URL.createObjectURL(blob);
      img.src = scanObjectUrl;
    } else {
      try {
        img.src = await VoyagheureParser.renderFirstPageDataUrl(blob);
      } catch (err) {
        console.warn('Impossible de générer l’aperçu du PDF pour le scan', err);
        alert("Impossible d'afficher ce document pour le scan.");
        await releaseScanWakeLock();
        return;
      }
    }

    $('#scan-modal').hidden = false;
    await wakeLockPromise;
  }

  $('#scan-close').addEventListener('click', async () => {
    $('#scan-modal').hidden = true;
    $('#scan-image').src = '';
    if (scanObjectUrl) {
      URL.revokeObjectURL(scanObjectUrl);
      scanObjectUrl = null;
    }
    await releaseScanWakeLock();
  });

  function isSupportedImportFile(f) {
    if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) return true;
    if (f.type.startsWith('image/') || /\.(png|jpe?g|webp|heic|heif)$/i.test(f.name)) return true;
    return false;
  }

  $('#import-btn').addEventListener('click', () => $('#file-input').click());

  $('#file-input').addEventListener('change', async () => {
    const files = Array.from($('#file-input').files || []).filter(isSupportedImportFile);
    $('#file-input').value = '';
    if (files.length === 0) return;
    importQueue = files;
    await processNextImport();
  });

  async function processNextImport() {
    if (importQueue.length === 0) return;
    const file = importQueue.shift();

    // Image : pas d'extraction automatique, juste un formulaire assisté
    // avec l'image affichée en aperçu pour recopier rapidement. Tous les
    // champs restent donc à confiance nulle (non détectés).
    if (file.type.startsWith('image/')) {
      const parsed = VoyagheureParser.emptyAnalysis(file);
      parsed.type.value = 'other';
      openEntryModal({ mode: 'import-image', file, parsed });
      return;
    }

    $('#import-status').hidden = false;
    let parsed;
    try {
      parsed = await VoyagheureParser.analyzePdf(file);
    } catch (err) {
      console.warn('Analyse du PDF impossible', err);
      parsed = VoyagheureParser.emptyAnalysis(file);
    }
    $('#import-status').hidden = true;

    // Billet combiné : plusieurs blocs événement détectés dans le même
    // document (même PDF/QR/prix pour tous) — flux de confirmation dédié.
    // Un seul bloc (ou aucun) : comportement inchangé, entrée classique.
    if (parsed.blocks && parsed.blocks.length > 1) {
      openCombinedModal({
        file,
        events: parsed.blocks.map((b) => ({ ...b })),
        title: parsed.documentTitle,
        price: fieldValue(parsed.price),
        reference: fieldValue(parsed.reference),
      });
      return;
    }

    openEntryModal({ mode: 'import', file, parsed });
  }

  $('#manual-add-btn').addEventListener('click', () => {
    openEntryModal({ mode: 'manual' });
  });

  let previewObjectUrl = null;

  function clearImagePreview() {
    $('#entry-image-preview').hidden = true;
    $('#entry-image-preview-img').src = '';
    if (previewObjectUrl) {
      URL.revokeObjectURL(previewObjectUrl);
      previewObjectUrl = null;
    }
  }

  // Coordonnées GPS de l'entrée en cours d'édition/import — pas de champ
  // visible dans le formulaire, juste capturées via la géolocalisation du
  // téléphone (pas de géocodage automatique de l'adresse : nécessiterait
  // un service en ligne, incompatible avec le fonctionnement 100%
  // hors-ligne). Servent à affiner le bouton 📍 et à estimer le temps de
  // trajet entre deux entrées consécutives du planning.
  let pendingGps = { latitude: null, longitude: null };

  function renderGpsStatus() {
    const el = $('#entry-gps-status');
    if (pendingGps.latitude != null && pendingGps.longitude != null) {
      el.hidden = false;
      el.textContent = `📍 Position enregistrée (${pendingGps.latitude.toFixed(5)}, ${pendingGps.longitude.toFixed(5)}) — retape le bouton pour la mettre à jour.`;
    } else {
      el.hidden = true;
      el.textContent = '';
    }
  }

  $('#entry-gps-btn').addEventListener('click', () => {
    if (!('geolocation' in navigator)) {
      alert("La géolocalisation n'est pas prise en charge par ce navigateur.");
      return;
    }
    const btn = $('#entry-gps-btn');
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Localisation en cours…';
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        pendingGps = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
        renderGpsStatus();
        btn.disabled = false;
        btn.textContent = original;
      },
      () => {
        btn.disabled = false;
        btn.textContent = original;
        alert("Impossible de récupérer ta position — vérifie que la géolocalisation est autorisée pour Voyag’heure.");
      },
      { enableHighAccuracy: true, timeout: 10_000 }
    );
  });

  function openEntryModal(ctx) {
    entryCtx = ctx;
    const isEdit = ctx.mode === 'edit';
    const isImport = isImportMode(ctx.mode);
    const isImageImport = ctx.mode === 'import-image';
    const data = isEdit ? ctx.existingEntry : ctx.parsed || {};

    // Une entrée d'un billet combiné n'a pas son propre prix/référence/
    // statut : ces champs vivent sur le document partagé et se modifient
    // depuis sa carte (onglet Entrées), pas ici — on les masque plutôt que
    // de laisser croire qu'ils s'appliquent à ce seul événement.
    const linkedDoc = isEdit ? docFor(ctx.existingEntry) : null;
    $('#entry-price-reference-row').hidden = !!linkedDoc;
    $('#entry-payment-status-field').hidden = !!linkedDoc;
    $('#entry-document-note').hidden = !linkedDoc;

    $('#entry-modal-title').textContent = isEdit
      ? 'Modifier l’entrée'
      : isImageImport
        ? 'Recopie les infos de l’image'
        : isImport
          ? 'Confirme les infos détectées'
          : 'Nouvelle entrée';
    $('#entry-modal-hint').textContent = isImageImport
      ? `Aucune extraction automatique sur les images — recopie depuis « ${ctx.file.name} » ci-dessous.`
      : isImport
        ? `Détecté depuis « ${ctx.file.name} » — vérifie et corrige si besoin.`
        : '';

    clearImagePreview();
    if (isImageImport) {
      previewObjectUrl = URL.createObjectURL(ctx.file);
      $('#entry-image-preview-img').src = previewObjectUrl;
      $('#entry-image-preview').hidden = false;
    }

    const startDate = fieldValue(data.startDate);
    const startTime = fieldValue(data.startTime);
    const endDate = fieldValue(data.endDate);
    const place = fieldValue(data.place);
    const address = fieldValue(data.address);
    const price = linkedDoc ? linkedDoc.price : fieldValue(data.price);
    const reference = linkedDoc ? linkedDoc.reference : fieldValue(data.reference);

    $('#entry-type').value = fieldValue(data.type) || 'other';
    $('#entry-title').value = data.title || '';
    $('#entry-start-date').value = startDate || '';
    $('#entry-start-time').value = startTime || '';
    $('#entry-end-date').value = endDate || '';
    $('#entry-end-time').value = data.endTime || '';
    $('#entry-place').value = place || '';
    $('#entry-address').value = address || '';
    $('#entry-price').value = price === null || price === undefined ? '' : price;
    $('#entry-reference').value = reference || '';
    $('#entry-payment-status').value = (linkedDoc ? linkedDoc.paymentStatus : data.paymentStatus) || (isImport ? 'paid' : 'estimate');
    $('#entry-reminder-mode').value = data.reminderMode || 'default';
    $('#entry-reminder-minutes').value = data.reminderMinutes === null || data.reminderMinutes === undefined ? '' : data.reminderMinutes;
    updateReminderCustomFieldVisibility();

    pendingGps = { latitude: data.latitude ?? null, longitude: data.longitude ?? null };
    renderGpsStatus();

    // Extraits sources + signalement des champs non détectés — seulement
    // pertinent juste après un import (PDF ou image).
    applyFieldHints(isImport ? ctx.parsed : null);

    const blob = isEdit ? effectivePdfBlob(ctx.existingEntry) : isImport ? ctx.file : null;
    const viewBtn = $('#entry-view-pdf');
    viewBtn.hidden = !blob;
    viewBtn.textContent = attachmentViewLabel(blob);
    viewBtn.onclick = blob
      ? () => openBlobInNewTab(blob, (isEdit && effectivePdfName(ctx.existingEntry)) || ctx.file?.name || data.title)
      : null;

    $('#entry-delete').hidden = !isEdit;

    showModal('#entry-modal');
  }

  function closeEntryModalAndContinueQueue() {
    hideModal('#entry-modal');
    clearImagePreview();
    const wasImport = entryCtx && isImportMode(entryCtx.mode);
    entryCtx = null;
    if (wasImport && importQueue.length > 0) {
      setTimeout(processNextImport, 180);
    }
  }

  // Champs sur lesquels on mémorise les corrections récurrentes (voir
  // js/db.js "correctionRules") : quand plusieurs candidats existaient et
  // que l'utilisateur a choisi une valeur différente de celle suggérée qui
  // correspond à un AUTRE candidat détecté, on retient son libellé comme
  // préféré pour ce type de document.
  const LEARNABLE_FIELDS = ['price', 'reference', 'address', 'place'];

  async function maybeLearnFromCorrection(ctx, values) {
    if (ctx.mode !== 'import' || !ctx.parsed || !ctx.parsed.docSignature) return;
    const { docSignature, candidates } = ctx.parsed;

    for (const key of LEARNABLE_FIELDS) {
      const original = ctx.parsed[key]?.value;
      const finalValue = values[key];
      const same =
        key === 'price'
          ? Number(original) === Number(finalValue)
          : String(original || '').trim() === String(finalValue || '').trim();
      if (same) continue; // rien corrigé sur ce champ

      const pool = candidates?.[key] || [];
      const match = pool.find((c) =>
        key === 'price' ? Number(c.value) === Number(finalValue) : String(c.value).trim() === String(finalValue || '').trim()
      );
      if (match && match.label) {
        await VoyagheureDB.saveCorrectionRule(docSignature, key, match.label);
      }
    }
  }

  function updateReminderCustomFieldVisibility() {
    $('#entry-reminder-custom-field').hidden = $('#entry-reminder-mode').value !== 'custom';
  }
  $('#entry-reminder-mode').addEventListener('change', updateReminderCustomFieldVisibility);

  $('#entry-cancel').addEventListener('click', closeEntryModalAndContinueQueue);

  $('#entry-delete').addEventListener('click', async () => {
    if (!entryCtx || entryCtx.mode !== 'edit') return;
    if (confirm(`Supprimer "${entryCtx.existingEntry.title}" ?`)) {
      await VoyagheureDB.deleteEntry(entryCtx.existingEntry.id);
      closeEntryModalAndContinueQueue();
      refreshAll();
    }
  });

  $('#entry-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!entryCtx) return;

    const linkedDoc = entryCtx.mode === 'edit' ? docFor(entryCtx.existingEntry) : null;

    const values = {
      type: $('#entry-type').value,
      title: $('#entry-title').value.trim(),
      startDate: $('#entry-start-date').value || null,
      startTime: $('#entry-start-time').value || null,
      endDate: $('#entry-end-date').value || null,
      endTime: $('#entry-end-time').value || null,
      place: $('#entry-place').value.trim(),
      address: $('#entry-address').value.trim(),
      latitude: pendingGps.latitude,
      longitude: pendingGps.longitude,
      reminderMode: $('#entry-reminder-mode').value,
      reminderMinutes: $('#entry-reminder-minutes').value === '' ? null : Number($('#entry-reminder-minutes').value),
    };
    // Prix/référence/statut sont masqués (et non modifiables ici) pour une
    // entrée d'un billet combiné — ne pas les écraser avec les champs
    // cachés du formulaire, qui n'ont pas été édités.
    if (!linkedDoc) {
      values.price = $('#entry-price').value === '' ? null : Number($('#entry-price').value);
      values.reference = $('#entry-reference').value.trim();
      values.paymentStatus = $('#entry-payment-status').value;
    }
    if (!values.title) return;

    await maybeLearnFromCorrection(entryCtx, values);

    if (entryCtx.mode === 'edit') {
      await VoyagheureDB.updateEntry({ ...entryCtx.existingEntry, ...values });
    } else {
      const attach = isImportMode(entryCtx.mode);
      await VoyagheureDB.createEntry({
        tripId: state.currentTrip.id,
        ...values,
        pdfBlob: attach ? entryCtx.file : null,
        pdfName: attach ? entryCtx.file.name : null,
      });
    }

    closeEntryModalAndContinueQueue();
    await refreshAll();
  });

  // ---------------------------------------------------------------------
  // Billet combiné — confirmation d'import (plusieurs événements détectés
  // dans un même PDF, partageant un seul prix/référence/QR)
  // ---------------------------------------------------------------------
  function blankCombinedEvent() {
    return { type: 'event', title: '', startDate: null, startTime: null, endTime: null, place: '', address: '' };
  }

  function openCombinedModal({ file, events, title, price, reference }) {
    combinedCtx = { file, events: events.length > 0 ? events : [blankCombinedEvent()] };
    $('#combined-modal-hint').textContent =
      `${combinedCtx.events.length} événements détectés depuis « ${file.name} » — vérifie/corrige chacun ci-dessous.`;
    $('#combined-title').value = title || file.name;
    $('#combined-price').value = price === null || price === undefined ? '' : price;
    $('#combined-reference').value = reference || '';
    $('#combined-payment-status').value = 'paid';
    renderCombinedEventsList();
    showModal('#combined-modal');
  }

  function typeOptionsHtml(selected) {
    return Object.entries(TYPE_META)
      .map(([value, meta]) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${meta.icon} ${escapeHtml(meta.label)}</option>`)
      .join('');
  }

  function renderCombinedEventsList() {
    const container = $('#combined-events-list');
    container.innerHTML = combinedCtx.events
      .map(
        (ev, i) => `
      <fieldset class="combined-event" data-index="${i}">
        <div class="combined-event__header">
          <span class="combined-event__number">Événement ${i + 1}</span>
          <button type="button" class="combined-event__remove" aria-label="Retirer cet événement" ${combinedCtx.events.length <= 1 ? 'disabled' : ''}>✕</button>
        </div>
        <label class="field"><span>Titre</span><input type="text" class="ce-title" value="${escapeHtml(ev.title || '')}" /></label>
        <label class="field">
          <span>Type</span>
          <select class="ce-type">${typeOptionsHtml(ev.type)}</select>
        </label>
        <div class="field-row">
          <label class="field"><span>Date</span><input type="date" class="ce-start-date" value="${ev.startDate || ''}" /></label>
          <label class="field"><span>Heure de début</span><input type="time" class="ce-start-time" value="${ev.startTime || ''}" /></label>
        </div>
        <div class="field-row">
          <label class="field"><span>Heure de fin</span><input type="time" class="ce-end-time" value="${ev.endTime || ''}" /></label>
          <label class="field"><span>Lieu</span><input type="text" class="ce-place" value="${escapeHtml(ev.place || '')}" /></label>
        </div>
        <label class="field"><span>Adresse</span><input type="text" class="ce-address" value="${escapeHtml(ev.address || '')}" /></label>
      </fieldset>
    `
      )
      .join('');

    $$('.combined-event').forEach((fieldset) => {
      const i = Number(fieldset.dataset.index);
      const ev = combinedCtx.events[i];
      const bind = (selector, field, parse = (v) => v) => {
        fieldset.querySelector(selector).addEventListener('input', (e) => {
          ev[field] = parse(e.target.value) || null;
        });
      };
      bind('.ce-title', 'title');
      fieldset.querySelector('.ce-type').addEventListener('change', (e) => {
        ev.type = e.target.value;
      });
      bind('.ce-start-date', 'startDate');
      bind('.ce-start-time', 'startTime');
      bind('.ce-end-time', 'endTime');
      bind('.ce-place', 'place');
      bind('.ce-address', 'address');

      fieldset.querySelector('.combined-event__remove').addEventListener('click', () => {
        if (combinedCtx.events.length <= 1) return;
        combinedCtx.events.splice(i, 1);
        renderCombinedEventsList();
      });
    });
  }

  $('#combined-add-event').addEventListener('click', () => {
    combinedCtx.events.push(blankCombinedEvent());
    renderCombinedEventsList();
  });

  function closeCombinedModal() {
    hideModal('#combined-modal');
    combinedCtx = null;
    if (importQueue.length > 0) setTimeout(processNextImport, 180);
  }

  $('#combined-cancel').addEventListener('click', closeCombinedModal);

  $('#combined-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!combinedCtx) return;
    const events = combinedCtx.events;
    if (events.length === 0 || events.some((ev) => !ev.title || !ev.title.trim())) {
      alert('Chaque événement doit avoir un titre.');
      return;
    }

    const doc = await VoyagheureDB.createDocument({
      tripId: state.currentTrip.id,
      title: $('#combined-title').value.trim() || 'Billet combiné',
      pdfBlob: combinedCtx.file,
      pdfName: combinedCtx.file.name,
      price: $('#combined-price').value === '' ? null : Number($('#combined-price').value),
      reference: $('#combined-reference').value.trim(),
      paymentStatus: $('#combined-payment-status').value,
    });

    for (const ev of events) {
      await VoyagheureDB.createEntry({
        tripId: state.currentTrip.id,
        documentId: doc.id,
        type: ev.type,
        title: ev.title.trim(),
        startDate: ev.startDate || null,
        startTime: ev.startTime || null,
        endDate: null,
        endTime: ev.endTime || null,
        place: ev.place || '',
        address: ev.address || '',
      });
    }

    closeCombinedModal();
    await refreshAll();
  });

  // ---------------------------------------------------------------------
  // Billet combiné — édition d'un document existant (prix/référence/statut
  // partagés + suppression cascade)
  // ---------------------------------------------------------------------
  function openDocumentModal(doc, linkedEntries) {
    documentCtx = { doc, linkedEntries };
    $('#document-events-list').innerHTML = linkedEntries
      .map((entry) => {
        const meta = TYPE_META[entry.type] || TYPE_META.other;
        const bits = [entry.startDate ? formatDateShort(entry.startDate) : null, entry.startTime, entry.place]
          .filter(Boolean)
          .join(' · ');
        return `<li>${meta.icon} <strong>${escapeHtml(entry.title)}</strong>${bits ? ` — ${escapeHtml(bits)}` : ''}</li>`;
      })
      .join('');

    $('#document-title').value = doc.title || 'Billet combiné';
    $('#document-price').value = doc.price === null || doc.price === undefined ? '' : doc.price;
    $('#document-reference').value = doc.reference || '';
    $('#document-payment-status').value = doc.paymentStatus || 'estimate';

    const viewBtn = $('#document-view-pdf');
    viewBtn.hidden = !doc.pdfBlob;
    viewBtn.textContent = attachmentViewLabel(doc.pdfBlob);
    viewBtn.onclick = doc.pdfBlob ? () => openBlobInNewTab(doc.pdfBlob, doc.pdfName || 'Billet combiné') : null;

    showModal('#document-modal');
  }

  $('#document-cancel').addEventListener('click', () => {
    hideModal('#document-modal');
    documentCtx = null;
  });

  $('#document-delete').addEventListener('click', async () => {
    if (!documentCtx) return;
    if (confirm(`Supprimer ce billet combiné et ses ${documentCtx.linkedEntries.length} événements ?`)) {
      await VoyagheureDB.deleteDocument(documentCtx.doc.id);
      hideModal('#document-modal');
      documentCtx = null;
      await refreshAll();
    }
  });

  $('#document-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!documentCtx) return;
    await VoyagheureDB.updateDocument({
      ...documentCtx.doc,
      title: $('#document-title').value.trim() || 'Billet combiné',
      price: $('#document-price').value === '' ? null : Number($('#document-price').value),
      reference: $('#document-reference').value.trim(),
      paymentStatus: $('#document-payment-status').value,
    });
    hideModal('#document-modal');
    documentCtx = null;
    await refreshAll();
  });

  // ---------------------------------------------------------------------
  // Onglet Planning
  // ---------------------------------------------------------------------
  /**
   * Construit la liste d'items d'un jour (ou de la vue "Aujourd'hui"),
   * avec le battement/temps de trajet estimé entre deux entrées
   * consécutives — factorisé pour être utilisé à la fois par le planning
   * complet (jour par jour) et par la vue "Aujourd'hui" épinglée en haut.
   */
  function buildTimelineItemsEl(items) {
    const itemsEl = document.createElement('div');
    itemsEl.className = 'timeline-items';
    items.forEach((entry, index) => {
      const meta = TYPE_META[entry.type] || TYPE_META.other;
      const wrap = document.createElement('div');
      wrap.className = `timeline-item type-${entry.type}`;

      const timesLine = entry.startTime
        ? `<p class="timeline-item__times">${entry.startTime}${entry.endTime ? `<span class="timeline-item__times-arrow">→</span>${entry.endTime}` : ''}</p>`
        : '';

      const openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'timeline-item__open';
      openBtn.innerHTML = `
        <span class="timeline-item__icon" aria-hidden="true">${meta.icon}</span>
        <span>
          <p class="timeline-item__type">${meta.label}</p>
          ${timesLine}
          <p class="timeline-item__title">${escapeHtml(entry.title)}</p>
          ${entry.place ? `<p class="timeline-item__time">${escapeHtml(entry.place)}</p>` : ''}
        </span>
      `;
      // Ouvre directement le PDF/l'image d'origine (viewer natif), sans
      // changer d'onglet — ou l'édition s'il n'y a pas de pièce jointe.
      openBtn.addEventListener('click', () => openEntryAttachmentOrEdit(entry));
      wrap.appendChild(openBtn);

      if (entry.address) {
        const mapBtn = document.createElement('button');
        mapBtn.type = 'button';
        mapBtn.className = 'timeline-item__map';
        mapBtn.setAttribute('aria-label', `Itinéraire vers ${entry.address}`);
        mapBtn.textContent = '📍';
        mapBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          openInMaps(entry);
        });
        wrap.appendChild(mapBtn);
      }

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'timeline-item__edit';
      editBtn.setAttribute('aria-label', `Modifier ${entry.title}`);
      editBtn.textContent = '✎';
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openEntryModal({ mode: 'edit', existingEntry: entry });
      });
      wrap.appendChild(editBtn);

      itemsEl.appendChild(wrap);

      // Temps disponible avant la prochaine entrée du même jour. Si les
      // deux entrées ont une position GPS (voir "Enregistrer ma position
      // ici"), estime le temps de trajet à vol d'oiseau (Haversine) et
      // affiche la marge restante — sinon garde le simple calcul d'écart
      // horaire, pour rester compatible avec les entrées sans coordonnées.
      const next = items[index + 1];
      if (next && entry.startTime && next.startTime) {
        const endRef = entry.endTime || entry.startTime;
        const gapMinutes = timeToMinutes(next.startTime) - timeToMinutes(endRef);
        if (gapMinutes > 0) {
          const gapEl = document.createElement('div');
          gapEl.className = 'timeline-gap';

          const hasCoords = entry.latitude != null && entry.longitude != null && next.latitude != null && next.longitude != null;
          if (hasCoords) {
            const distanceKm = haversineKm(entry.latitude, entry.longitude, next.latitude, next.longitude);
            const travel = estimateTravel(distanceKm);
            const margin = gapMinutes - travel.minutes;
            const atRisk = margin < 0;
            if (atRisk) gapEl.classList.add('timeline-gap--alert');

            const travelLabel =
              travel.mode === 'walk'
                ? `${travel.icon} ${formatDuration(travel.minutes)} de marche estimée`
                : `${travel.icon} ~${formatDuration(travel.minutes)} en transport estimé`;
            const marginLabel = atRisk
              ? `⚠️ dépasse le temps disponible de ${formatDuration(-margin)} !`
              : `${formatDuration(margin)} de marge`;

            const line = document.createElement('p');
            line.className = 'timeline-gap__line';
            line.textContent = `${travelLabel} · ${marginLabel}`;
            gapEl.appendChild(line);

            const note = document.createElement('p');
            note.className = 'timeline-gap__note';
            note.textContent = "Estimation à vol d'oiseau (distance directe), pas un vrai calcul d'itinéraire — peut différer du trajet réel.";
            gapEl.appendChild(note);
          } else {
            const line = document.createElement('p');
            line.className = 'timeline-gap__line';
            line.textContent = `⏳ ${formatDuration(gapMinutes)} avant le prochain événement`;
            gapEl.appendChild(line);
          }

          itemsEl.appendChild(gapEl);
        }
      }
    });
    return itemsEl;
  }

  /** Vue "Aujourd'hui" épinglée en haut du Planning : uniquement les
   *  entrées de la date calendaire du jour, triées par heure. */
  function renderTodaySection(entries) {
    const todayItems = entries
      .filter((e) => e.startDate === todayISO())
      .sort((a, b) => (a.startTime || '99:99').localeCompare(b.startTime || '99:99'));

    const container = $('#today-items');
    container.innerHTML = '';
    $('#today-empty').hidden = todayItems.length > 0;
    if (todayItems.length > 0) container.appendChild(buildTimelineItemsEl(todayItems));

    return todayItems.length;
  }

  function renderPlanning(entries) {
    renderTodaySection(entries);

    const container = $('#planning-timeline');
    container.innerHTML = '';

    const withDate = entries.filter((e) => e.startDate);
    const withoutDate = entries.filter((e) => !e.startDate);
    $('#planning-empty').hidden = entries.length > 0;

    const byDate = new Map();
    withDate.forEach((e) => {
      if (!byDate.has(e.startDate)) byDate.set(e.startDate, []);
      byDate.get(e.startDate).push(e);
    });
    const sortedDates = Array.from(byDate.keys()).sort();
    sortedDates.forEach((date) => {
      byDate.get(date).sort((a, b) => (a.startTime || '99:99').localeCompare(b.startTime || '99:99'));
    });

    const renderDay = (label, items) => {
      const dayEl = document.createElement('div');
      dayEl.className = 'timeline-day';
      const labelEl = document.createElement('p');
      labelEl.className = 'timeline-day__label';
      labelEl.textContent = label;
      dayEl.appendChild(labelEl);
      dayEl.appendChild(buildTimelineItemsEl(items));
      container.appendChild(dayEl);
    };

    sortedDates.forEach((date) => renderDay(formatDateLabel(date), byDate.get(date)));
    if (withoutDate.length > 0) renderDay('Sans date', withoutDate);
  }

  // ---------------------------------------------------------------------
  // Onglet Budget
  // ---------------------------------------------------------------------
  function renderBudget(entries) {
    // Un billet combiné ne doit compter qu'UNE fois dans le budget, même
    // s'il couvre plusieurs entrées de planning : on ne garde que la
    // première entrée rencontrée par document, remplacée par une ligne
    // "virtuelle" représentant le document (son prix/statut, pas celui
    // d'un événement en particulier).
    const seenDocs = new Set();
    const billable = [];
    entries.forEach((entry) => {
      if (entry.documentId) {
        if (seenDocs.has(entry.documentId)) return;
        seenDocs.add(entry.documentId);
        const doc = docsById.get(entry.documentId);
        if (!doc || doc.price === null || doc.price === undefined) return;
        billable.push({
          id: `doc-${doc.id}`,
          title: 'Billet combiné',
          type: 'other',
          price: doc.price,
          paymentStatus: doc.paymentStatus,
          isDocument: true,
          document: doc,
        });
        return;
      }
      if (entry.price !== null && entry.price !== undefined) billable.push(entry);
    });

    $('#budget-empty').hidden = billable.length > 0;

    const sections = { paid: [], due: [], estimate: [] };
    billable.forEach((e) => {
      (sections[e.paymentStatus] || sections.estimate).push(e);
    });

    const sum = (arr) => arr.reduce((s, e) => s + Number(e.price), 0);
    const totals = { paid: sum(sections.paid), due: sum(sections.due), estimate: sum(sections.estimate) };
    const total = totals.paid + totals.due + totals.estimate;

    $('#budget-summary').innerHTML = `
      <div class="budget-summary__card">
        <p class="budget-summary__label">Payé</p>
        <p class="budget-summary__value">${formatAmount(totals.paid)} €</p>
      </div>
      <div class="budget-summary__card">
        <p class="budget-summary__label">À venir</p>
        <p class="budget-summary__value">${formatAmount(totals.due)} €</p>
      </div>
      <div class="budget-summary__card">
        <p class="budget-summary__label">Total est.</p>
        <p class="budget-summary__value budget-summary__value--total">${formatAmount(total)} €</p>
      </div>
    `;

    ['paid', 'due', 'estimate'].forEach((status) => {
      const list = $(`.budget-list[data-list="${status}"]`);
      list.innerHTML = '';
      sections[status].forEach((entry) => {
        const meta = entry.isDocument ? { icon: '🎫' } : TYPE_META[entry.type] || TYPE_META.other;
        const li = document.createElement('li');
        li.className = 'budget-row';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `budget-row__open type-${entry.type}`;
        btn.innerHTML = `
          <span class="budget-row__icon" aria-hidden="true">${meta.icon}</span>
          <span class="budget-row__label">${escapeHtml(entry.title)}</span>
          <span class="budget-row__amount">${formatAmount(entry.price)} €</span>
        `;
        btn.addEventListener('click', async () => {
          if (entry.isDocument) {
            const linked = await VoyagheureDB.getEntriesForDocument(entry.document.id);
            openDocumentModal(entry.document, linked);
          } else {
            openEntryModal({ mode: 'edit', existingEntry: entry });
          }
        });
        li.appendChild(btn);
        list.appendChild(li);
      });
    });
  }

  // ---------------------------------------------------------------------
  // Onglet Checklist (liste libre par voyage, aucun contenu suggéré)
  // ---------------------------------------------------------------------
  async function renderChecklist() {
    if (!state.currentTrip) return;
    const items = await VoyagheureDB.getChecklistItemsForTrip(state.currentTrip.id);
    items.sort((a, b) => a.addedAt - b.addedAt);

    const list = $('#checklist-list');
    list.innerHTML = '';
    $('#checklist-empty').hidden = items.length > 0;

    items.forEach((item) => {
      const li = document.createElement('li');
      li.className = `checklist-item${item.checked ? ' is-checked' : ''}`;

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'checklist-item__checkbox';
      checkbox.checked = item.checked;
      checkbox.setAttribute('aria-label', `Marquer "${item.text}" comme fait`);
      checkbox.addEventListener('change', async () => {
        await VoyagheureDB.updateChecklistItem({ ...item, checked: checkbox.checked });
        renderChecklist();
      });

      const text = document.createElement('span');
      text.className = 'checklist-item__text';
      text.textContent = item.text;

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'checklist-item__delete';
      deleteBtn.setAttribute('aria-label', `Supprimer "${item.text}"`);
      deleteBtn.textContent = '✕';
      deleteBtn.addEventListener('click', async () => {
        await VoyagheureDB.deleteChecklistItem(item.id);
        renderChecklist();
      });

      li.appendChild(checkbox);
      li.appendChild(text);
      li.appendChild(deleteBtn);
      list.appendChild(li);
    });
  }

  $('#checklist-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#checklist-input');
    const text = input.value.trim();
    if (!text || !state.currentTrip) return;
    await VoyagheureDB.createChecklistItem({ tripId: state.currentTrip.id, text });
    input.value = '';
    renderChecklist();
  });

  // ---------------------------------------------------------------------
  // Réglages (rappels)
  // ---------------------------------------------------------------------
  function openSettingsModal() {
    const settings = VoyagheureReminders.getSettings();
    $('#settings-reminders-enabled').checked = settings.remindersEnabled;
    $('#settings-default-minutes').value = settings.defaultMinutes;

    const supported = VoyagheureReminders.notificationsSupported();
    $('#settings-unsupported-hint').hidden = supported;
    $('#settings-ios-hint').hidden = !VoyagheureReminders.isIOS();
    $('#settings-permission-hint').hidden = true;
    $('#settings-reminders-enabled').disabled = !supported;

    showModal('#settings-modal');
  }

  $('#settings-btn').addEventListener('click', openSettingsModal);
  $('#settings-cancel').addEventListener('click', () => hideModal('#settings-modal'));

  $('#settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const wantsEnabled = $('#settings-reminders-enabled').checked;
    const defaultMinutes = $('#settings-default-minutes').value === '' ? 30 : Number($('#settings-default-minutes').value);

    let enabled = wantsEnabled;
    if (wantsEnabled) {
      // On ne demande la permission qu'au moment où l'utilisateur active la
      // fonctionnalité — jamais au premier lancement de l'app.
      const permission = await VoyagheureReminders.ensurePermission();
      if (permission !== 'granted') {
        enabled = false;
        const hint = $('#settings-permission-hint');
        hint.hidden = false;
        hint.textContent =
          permission === 'unsupported'
            ? 'Les notifications ne sont pas prises en charge par ce navigateur.'
            : 'Permission refusée — active les notifications pour Voyag’heure dans les réglages de ton navigateur pour utiliser les rappels.';
        $('#settings-reminders-enabled').checked = false;
        return; // laisse la modale ouverte pour que le message soit visible
      }
    }

    VoyagheureReminders.saveSettings({ remindersEnabled: enabled, defaultMinutes });
    hideModal('#settings-modal');
    VoyagheureReminders.rescheduleAll();
  });

  // ---------------------------------------------------------------------
  // Sauvegarde / restauration complète (export-import JSON)
  // ---------------------------------------------------------------------
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  function base64ToBlob(base64, type) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type });
  }

  async function serializeBlobField(blob) {
    if (!blob) return null;
    return { data: await blobToBase64(blob), type: blob.type || 'application/octet-stream' };
  }

  function deserializeBlobField(field) {
    if (!field) return null;
    return base64ToBlob(field.data, field.type);
  }

  /** Construit l'objet exportable : tout ce qui vit en IndexedDB, PDF/images
   *  encodés en base64 pour tenir dans du JSON. */
  async function buildBackupData() {
    const [trips, entries, documents, checklistItems] = await Promise.all([
      VoyagheureDB.getAllTrips(),
      VoyagheureDB.getAllEntries(),
      VoyagheureDB.getAllDocuments(),
      VoyagheureDB.getAllChecklistItems(),
    ]);

    const entriesOut = await Promise.all(
      entries.map(async (e) => ({ ...e, pdfBlob: await serializeBlobField(e.pdfBlob) }))
    );
    const documentsOut = await Promise.all(
      documents.map(async (d) => ({ ...d, pdfBlob: await serializeBlobField(d.pdfBlob) }))
    );

    return {
      version: 1,
      app: "Voyag'heure",
      exportedAt: new Date().toISOString(),
      trips,
      entries: entriesOut,
      documents: documentsOut,
      checklistItems,
    };
  }

  $('#backup-export-btn').addEventListener('click', async () => {
    const btn = $('#backup-export-btn');
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Préparation…';
    try {
      const data = await buildBackupData();
      const json = JSON.stringify(data, null, 2);
      const filename = `voyagheure-sauvegarde-${new Date().toISOString().slice(0, 10)}.json`;
      const file = new File([json], filename, { type: 'application/json' });

      if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: 'Sauvegarde Voyag’heure' });
        } catch (err) {
          if (err.name !== 'AbortError') throw err; // annulé par l'utilisateur : pas une erreur
        }
      } else {
        const url = URL.createObjectURL(file);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
      }
    } catch (err) {
      console.warn('Export impossible', err);
      alert("L'export a échoué — réessaie.");
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });

  $('#backup-import-btn').addEventListener('click', () => $('#backup-import-input').click());

  $('#backup-import-input').addEventListener('change', async () => {
    const file = $('#backup-import-input').files?.[0];
    $('#backup-import-input').value = '';
    if (!file) return;

    let data;
    try {
      data = JSON.parse(await file.text());
    } catch (err) {
      alert('Ce fichier n’est pas une sauvegarde Voyag’heure valide (JSON illisible).');
      return;
    }
    if (!data || !Array.isArray(data.trips)) {
      alert('Ce fichier n’est pas une sauvegarde Voyag’heure valide.');
      return;
    }

    const tripCount = data.trips.length;
    if (!confirm(`Importer cette sauvegarde (${tripCount} voyage${tripCount > 1 ? 's' : ''}) ?`)) return;
    const replace = confirm(
      'Remplacer TOUTES tes données actuelles par cette sauvegarde ?\n\nOK = remplacer\nAnnuler = fusionner (garder aussi tes voyages actuels)'
    );

    const status = $('#backup-status');
    status.hidden = false;
    status.textContent = 'Import en cours…';

    try {
      if (replace) await VoyagheureDB.clearAllData();

      for (const trip of data.trips || []) {
        await VoyagheureDB.restoreTrip(trip);
      }
      for (const entry of data.entries || []) {
        await VoyagheureDB.restoreEntry({ ...entry, pdfBlob: deserializeBlobField(entry.pdfBlob) });
      }
      for (const doc of data.documents || []) {
        await VoyagheureDB.restoreDocument({ ...doc, pdfBlob: deserializeBlobField(doc.pdfBlob) });
      }
      for (const item of data.checklistItems || []) {
        await VoyagheureDB.restoreChecklistItem(item);
      }

      status.textContent = 'Sauvegarde importée avec succès.';

      if (state.currentTrip) {
        // Le voyage courant peut avoir été supprimé/modifié par un
        // remplacement : recharge sa vue si elle existe encore, sinon
        // retourne à l'accueil plutôt que de laisser une vue obsolète.
        const stillExists = await VoyagheureDB.getTrip(state.currentTrip.id);
        if (stillExists) await refreshAll();
        else await goHome();
      } else {
        await renderHome();
      }
    } catch (err) {
      console.warn('Import de sauvegarde impossible', err);
      status.textContent = "Échec de l'import — vérifie le fichier et réessaie.";
    }
  });

  // ---------------------------------------------------------------------
  // Statut hors-ligne
  // ---------------------------------------------------------------------
  function initOfflineBadge() {
    const update = () => {
      $('#offline-badge-home').hidden = navigator.onLine;
      $('#offline-badge-trip').hidden = navigator.onLine;
    };
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    update();
  }

  // ---------------------------------------------------------------------
  // Installation (Android / Chrome)
  // ---------------------------------------------------------------------
  function initInstallPrompt() {
    const installBtn = $('#install-btn');
    let deferredPrompt = null;

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      installBtn.hidden = false;
    });

    installBtn.addEventListener('click', async () => {
      if (!deferredPrompt) return;
      installBtn.hidden = true;
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
    });

    window.addEventListener('appinstalled', () => {
      installBtn.hidden = true;
    });
  }

  // ---------------------------------------------------------------------
  // Service Worker
  // ---------------------------------------------------------------------
  function initServiceWorker() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch((err) => {
          console.warn('Échec d’enregistrement du Service Worker', err);
        });
      });
    }
  }

  // ---------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------
  async function init() {
    initOfflineBadge();
    initInstallPrompt();
    initServiceWorker();
    await renderHome();
    VoyagheureReminders.rescheduleAll();
  }

  init();
})();
