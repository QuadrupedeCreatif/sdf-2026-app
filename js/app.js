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
    if (entry.pdfBlob) {
      openBlobInNewTab(entry.pdfBlob, entry.pdfName || entry.title);
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
    const entries = await VoyagheureDB.getEntriesForTrip(state.currentTrip.id);
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
    const sorted = [...entries].sort((a, b) => b.addedAt - a.addedAt);
    $('#entries-empty').hidden = sorted.length > 0;

    sorted.forEach((entry) => {
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
    });
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
    const price = fieldValue(data.price);
    const reference = fieldValue(data.reference);

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
    $('#entry-payment-status').value = data.paymentStatus || (isImport ? 'paid' : 'estimate');
    $('#entry-reminder-mode').value = data.reminderMode || 'default';
    $('#entry-reminder-minutes').value = data.reminderMinutes === null || data.reminderMinutes === undefined ? '' : data.reminderMinutes;
    updateReminderCustomFieldVisibility();

    // Extraits sources + signalement des champs non détectés — seulement
    // pertinent juste après un import (PDF ou image).
    applyFieldHints(isImport ? ctx.parsed : null);

    const blob = isEdit ? ctx.existingEntry.pdfBlob : isImport ? ctx.file : null;
    const viewBtn = $('#entry-view-pdf');
    viewBtn.hidden = !blob;
    viewBtn.textContent = attachmentViewLabel(blob);
    viewBtn.onclick = blob ? () => openBlobInNewTab(blob, (isEdit && ctx.existingEntry.pdfName) || ctx.file?.name || data.title) : null;

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

    const values = {
      type: $('#entry-type').value,
      title: $('#entry-title').value.trim(),
      startDate: $('#entry-start-date').value || null,
      startTime: $('#entry-start-time').value || null,
      endDate: $('#entry-end-date').value || null,
      endTime: $('#entry-end-time').value || null,
      place: $('#entry-place').value.trim(),
      address: $('#entry-address').value.trim(),
      price: $('#entry-price').value === '' ? null : Number($('#entry-price').value),
      reference: $('#entry-reference').value.trim(),
      paymentStatus: $('#entry-payment-status').value,
      reminderMode: $('#entry-reminder-mode').value,
      reminderMinutes: $('#entry-reminder-minutes').value === '' ? null : Number($('#entry-reminder-minutes').value),
    };
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
    const priced = entries.filter((e) => e.price !== null && e.price !== undefined);
    $('#budget-empty').hidden = priced.length > 0;

    const sections = { paid: [], due: [], estimate: [] };
    priced.forEach((e) => {
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
        const meta = TYPE_META[entry.type] || TYPE_META.other;
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
        btn.addEventListener('click', () => openEntryModal({ mode: 'edit', existingEntry: entry }));
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
