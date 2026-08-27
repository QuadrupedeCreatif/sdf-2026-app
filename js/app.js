(() => {
  'use strict';

  const state = {
    data: SDFData.load(),
    activeTab: 'documents',
  };

  // ---------------------------------------------------------------------
  // Utils
  // ---------------------------------------------------------------------
  function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} o`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} Ko`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
  }

  function formatDate(ts) {
    return new Date(ts).toLocaleDateString('fr-FR', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function formatAmount(n) {
    return n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function persist() {
    SDFData.save(state.data);
  }

  // ---------------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------------
  function initTabs() {
    document.querySelectorAll('.tab-bar__btn').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
  }

  function switchTab(tab) {
    state.activeTab = tab;
    document.querySelectorAll('.tab-panel').forEach((panel) => {
      panel.hidden = panel.dataset.tabPanel !== tab;
    });
    document.querySelectorAll('.tab-bar__btn').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.tab === tab);
    });
  }

  // ---------------------------------------------------------------------
  // Documents (IndexedDB)
  // ---------------------------------------------------------------------
  const docsList = document.getElementById('documents-list');
  const docsEmpty = document.getElementById('documents-empty');
  const fileInput = document.getElementById('file-input');
  const importBtn = document.getElementById('import-btn');

  async function refreshDocuments() {
    const docs = await SDFDatabase.getAllDocuments();
    docsList.innerHTML = '';
    docsEmpty.hidden = docs.length > 0;

    docs.forEach((doc) => {
      const li = document.createElement('li');
      li.className = 'doc-card';

      const openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'doc-card__open';
      openBtn.innerHTML = `
        <span class="doc-card__icon" aria-hidden="true">📄</span>
        <span class="doc-card__body">
          <span class="doc-card__name"></span>
          <div class="doc-card__meta"></div>
        </span>
      `;
      openBtn.querySelector('.doc-card__name').textContent = doc.name;
      openBtn.querySelector('.doc-card__meta').textContent = `${formatSize(doc.size)} · ajouté le ${formatDate(doc.addedAt)}`;
      openBtn.addEventListener('click', () => openDocument(doc));

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'doc-card__delete';
      deleteBtn.setAttribute('aria-label', `Supprimer ${doc.name}`);
      deleteBtn.textContent = '✕';
      deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (confirm(`Supprimer "${doc.name}" ?`)) {
          await SDFDatabase.deleteDocument(doc.id);
          refreshDocuments();
        }
      });

      li.appendChild(openBtn);
      li.appendChild(deleteBtn);
      docsList.appendChild(li);
    });
  }

  function openDocument(doc) {
    const url = URL.createObjectURL(doc.blob);
    // Ouvre le PDF dans un nouvel onglet : le navigateur mobile prend le
    // relais avec son viewer PDF natif en plein écran.
    const win = window.open(url, '_blank');
    if (!win) {
      // Popup bloquée : on retente via un lien direct.
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.click();
    }
    // Libère la mémoire une fois le viewer probablement chargé.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  function initImport() {
    importBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const files = Array.from(fileInput.files || []);
      for (const file of files) {
        if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) continue;
        await SDFDatabase.addDocument({
          name: file.name,
          size: file.size,
          type: file.type,
          blob: file,
        });
      }
      fileInput.value = '';
      refreshDocuments();
    });
  }

  // ---------------------------------------------------------------------
  // Planning
  // ---------------------------------------------------------------------
  function renderPlanning() {
    const container = document.getElementById('planning-timeline');
    container.innerHTML = '';

    state.data.planning.forEach((day) => {
      const dayEl = document.createElement('div');
      dayEl.className = 'timeline-day';

      const label = document.createElement('p');
      label.className = 'timeline-day__label';
      label.textContent = day.label;
      dayEl.appendChild(label);

      const itemsEl = document.createElement('div');
      itemsEl.className = 'timeline-items';

      day.items.forEach((item) => {
        const itemEl = document.createElement('div');
        itemEl.className = 'timeline-item';
        itemEl.innerHTML = `
          <span class="timeline-item__icon" aria-hidden="true">${item.icon}</span>
          <span>
            <p class="timeline-item__type">${item.type}</p>
            <p class="timeline-item__title">${item.title}</p>
            <p class="timeline-item__time">${item.time}</p>
          </span>
        `;
        itemsEl.appendChild(itemEl);
      });

      dayEl.appendChild(itemsEl);
      container.appendChild(dayEl);
    });
  }

  // ---------------------------------------------------------------------
  // Budget
  // ---------------------------------------------------------------------
  const SECTION_LABELS = { paid: 'Déjà payé', due: 'À venir', estimate: 'Estimé' };

  function sectionTotal(section) {
    return state.data.budget
      .filter((item) => item.section === section)
      .reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  }

  function renderBudgetSummary() {
    const summary = document.getElementById('budget-summary');
    const paid = sectionTotal('paid');
    const due = sectionTotal('due');
    const estimate = sectionTotal('estimate');
    const total = paid + due + estimate;

    summary.innerHTML = `
      <div class="budget-summary__card">
        <p class="budget-summary__label">Payé</p>
        <p class="budget-summary__value">${formatAmount(paid)} €</p>
      </div>
      <div class="budget-summary__card">
        <p class="budget-summary__label">À venir</p>
        <p class="budget-summary__value">${formatAmount(due)} €</p>
      </div>
      <div class="budget-summary__card">
        <p class="budget-summary__label">Total est.</p>
        <p class="budget-summary__value budget-summary__value--total">${formatAmount(total)} €</p>
      </div>
    `;
  }

  function renderBudgetSection(section) {
    const list = document.querySelector(`.budget-list[data-list="${section}"]`);
    list.innerHTML = '';

    state.data.budget
      .filter((item) => item.section === section)
      .forEach((item) => {
        const li = document.createElement('li');
        li.className = 'budget-row';

        const labelInput = document.createElement('input');
        labelInput.className = 'budget-row__label';
        labelInput.type = 'text';
        labelInput.value = item.label;
        labelInput.setAttribute('aria-label', 'Libellé de la dépense');
        labelInput.addEventListener('change', () => {
          item.label = labelInput.value.trim() || item.label;
          persist();
        });

        const amountWrap = document.createElement('div');
        amountWrap.className = 'budget-row__amount-wrap';
        const amountInput = document.createElement('input');
        amountInput.className = 'budget-row__amount';
        amountInput.type = 'number';
        amountInput.inputMode = 'decimal';
        amountInput.step = '0.01';
        amountInput.min = '0';
        amountInput.placeholder = '0';
        amountInput.value = item.amount === null || item.amount === undefined ? '' : item.amount;
        amountInput.setAttribute('aria-label', `Montant pour ${item.label}`);
        amountInput.addEventListener('input', () => {
          const val = amountInput.value === '' ? null : parseFloat(amountInput.value);
          item.amount = Number.isFinite(val) ? val : null;
          persist();
          renderBudgetSummary();
        });
        const currency = document.createElement('span');
        currency.className = 'budget-row__currency';
        currency.textContent = '€';
        amountWrap.appendChild(amountInput);
        amountWrap.appendChild(currency);

        li.appendChild(labelInput);
        li.appendChild(amountWrap);

        if (item.custom) {
          const delBtn = document.createElement('button');
          delBtn.type = 'button';
          delBtn.className = 'budget-row__delete';
          delBtn.textContent = '✕';
          delBtn.setAttribute('aria-label', `Supprimer ${item.label}`);
          delBtn.addEventListener('click', () => {
            state.data.budget = state.data.budget.filter((b) => b.id !== item.id);
            persist();
            renderBudgetSection(section);
            renderBudgetSummary();
          });
          li.appendChild(delBtn);
        }

        list.appendChild(li);
      });
  }

  function renderBudget() {
    renderBudgetSummary();
    ['paid', 'due', 'estimate'].forEach(renderBudgetSection);
  }

  function initBudgetAddButtons() {
    document.querySelectorAll('[data-add]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const section = btn.dataset.add;
        state.data.budget.push({
          id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          section,
          label: `Nouvelle dépense (${SECTION_LABELS[section]})`,
          amount: null,
          custom: true,
        });
        persist();
        renderBudgetSection(section);
        renderBudgetSummary();
      });
    });
  }

  // ---------------------------------------------------------------------
  // Statut hors-ligne
  // ---------------------------------------------------------------------
  function initOfflineBadge() {
    const badge = document.getElementById('offline-badge');
    const update = () => {
      badge.hidden = navigator.onLine;
    };
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    update();
  }

  // ---------------------------------------------------------------------
  // Installation (Android / Chrome)
  // ---------------------------------------------------------------------
  function initInstallPrompt() {
    const installBtn = document.getElementById('install-btn');
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
  function init() {
    initTabs();
    initImport();
    initBudgetAddButtons();
    initOfflineBadge();
    initInstallPrompt();
    initServiceWorker();

    refreshDocuments();
    renderPlanning();
    renderBudget();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
