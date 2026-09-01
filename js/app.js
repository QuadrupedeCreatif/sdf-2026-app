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

  /** Ouvre l'app de navigation du téléphone (Plans sur iOS, Google Maps sinon). */
  function openInMaps(address) {
    const query = encodeURIComponent(address);
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
    switchTab('documents');
    await refreshAll();
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
    if (!state.currentTrip) return;
    const [entries, documents] = await Promise.all([
      VoyagheureDB.getEntriesForTrip(state.currentTrip.id),
      VoyagheureDB.getDocumentsForTrip(state.currentTrip.id),
    ]);
    docsById = new Map(documents.map((doc) => [doc.id, doc]));
    renderEntries(entries);
    renderPlanning(entries);
    renderBudget(entries);
    VoyagheureReminders.rescheduleAll();
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
        openInMaps(entry.address);
      });
      li.appendChild(mapBtn);
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
    const metaBits = [`${sorted.length} événements`, doc.price != null ? `${formatAmount(doc.price)} €` : null].filter(Boolean);
    const subtitle = sorted
      .map((e) => `${escapeHtml(e.title)}${e.startDate ? ` (${formatDateShort(e.startDate)})` : ''}`)
      .join(' · ');
    openBtn.innerHTML = `
      <span class="doc-card__icon" aria-hidden="true">🎫</span>
      <span class="doc-card__body">
        <span class="doc-card__name">Billet combiné</span>
        <div class="doc-card__meta">${escapeHtml(metaBits.join(' · '))}</div>
        <div class="doc-card__combined-events">${subtitle}</div>
      </span>
    `;
    openBtn.addEventListener('click', () => {
      if (doc.pdfBlob) openBlobInNewTab(doc.pdfBlob, doc.pdfName || 'Billet combiné');
      else openDocumentModal(doc, sorted);
    });
    li.appendChild(openBtn);

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

  function openCombinedModal({ file, events, price, reference }) {
    combinedCtx = { file, events: events.length > 0 ? events : [blankCombinedEvent()] };
    $('#combined-modal-hint').textContent =
      `${combinedCtx.events.length} événements détectés depuis « ${file.name} » — vérifie/corrige chacun ci-dessous.`;
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
  function renderPlanning(entries) {
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
            openInMaps(entry.address);
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

        // Temps disponible avant la prochaine entrée du même jour (temps de
        // trajet/battement) — seulement si les deux entrées ont une heure.
        const next = items[index + 1];
        if (next && entry.startTime && next.startTime) {
          const endRef = entry.endTime || entry.startTime;
          const gapMinutes = timeToMinutes(next.startTime) - timeToMinutes(endRef);
          if (gapMinutes > 0) {
            const gapEl = document.createElement('p');
            gapEl.className = 'timeline-gap';
            gapEl.innerHTML = `⏳ ${formatDuration(gapMinutes)} avant le prochain événement`;
            itemsEl.appendChild(gapEl);
          }
        }
      });
      dayEl.appendChild(itemsEl);
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
