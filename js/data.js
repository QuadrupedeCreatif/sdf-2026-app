/**
 * Données du voyage (planning + budget) et persistance localStorage.
 * Les billets/PDF réels sont dans IndexedDB (voir db.js) : ici on ne stocke
 * que les infos structurées de planning et les montants de budget.
 */
const SDFData = (() => {
  const LS_KEY = 'sdf2026-trip-data';

  // --- Contenu par défaut (première ouverture de l'app) --------------------
  const DEFAULT_DATA = {
    trip: {
      name: 'Summer Dance Forever 2026',
      place: 'Paradiso, Amsterdam',
      dates: '28 → 31 août 2026',
    },
    planning: [
      {
        date: '2026-08-28',
        label: 'Ven. 28 août',
        items: [
          {
            icon: '🚌',
            type: 'Bus',
            title: 'FlixBus — Paris → Amsterdam',
            time: 'Horaire à vérifier sur le billet',
          },
          {
            icon: '🛏️',
            type: 'Logement',
            title: 'Check-in — hostel (Hostelworld)',
            time: 'À l’arrivée à Amsterdam',
          },
          {
            icon: '🎟️',
            type: 'Événement',
            title: 'Preselections — Paradiso',
            time: 'Horaire à vérifier sur le billet',
          },
        ],
      },
      {
        date: '2026-08-29',
        label: 'Sam. 29 août',
        items: [
          {
            icon: '🎟️',
            type: 'Événement',
            title: 'House Dance Battles — Paradiso',
            time: 'Horaire à vérifier sur le billet',
          },
        ],
      },
      {
        date: '2026-08-30',
        label: 'Dim. 30 août',
        items: [
          {
            icon: '🎟️',
            type: 'Événement',
            title: 'Hiphop Battles — Paradiso',
            time: 'Horaire à vérifier sur le billet',
          },
        ],
      },
      {
        date: '2026-08-31',
        label: 'Lun. 31 août',
        items: [
          {
            icon: '🛏️',
            type: 'Logement',
            title: 'Check-out — hostel (Hostelworld)',
            time: 'Avant l’heure limite indiquée par l’hostel',
          },
          {
            icon: '🚌',
            type: 'Bus',
            title: 'FlixBus — Amsterdam → Paris',
            time: 'Horaire à vérifier sur le billet',
          },
        ],
      },
    ],
    // Budget : montants par défaut à 0/vide, éditables dans l'app.
    // "paid"   = déjà payé (billets, bus, hostel réservés en avance)
    // "due"    = à venir, déjà connu (à régler sur place, ex. taxe de séjour)
    // "estimate" = estimation (nourriture, souvenirs...)
    budget: [
      { id: 'preselections', section: 'paid', label: 'Billet — Preselections', amount: null, custom: false },
      { id: 'house-battles', section: 'paid', label: 'Billet — House Dance Battles', amount: null, custom: false },
      { id: 'hiphop-battles', section: 'paid', label: 'Billet — Hiphop Battles', amount: null, custom: false },
      { id: 'flixbus-aller', section: 'paid', label: 'FlixBus — Paris → Amsterdam', amount: null, custom: false },
      { id: 'flixbus-retour', section: 'paid', label: 'FlixBus — Amsterdam → Paris', amount: null, custom: false },
      { id: 'hostel', section: 'paid', label: 'Hostel (Hostelworld)', amount: null, custom: false },

      { id: 'taxe-sejour', section: 'due', label: 'Taxe de séjour / caution hostel', amount: null, custom: false },

      { id: 'nourriture', section: 'estimate', label: 'Nourriture sur place', amount: null, custom: false },
      { id: 'transport-local', section: 'estimate', label: 'Transport local (métro/tram)', amount: null, custom: false },
      { id: 'souvenirs', section: 'estimate', label: 'Souvenirs / merch festival', amount: null, custom: false },
      { id: 'extra', section: 'estimate', label: 'Imprévus', amount: null, custom: false },
    ],
  };

  function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function load() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return clone(DEFAULT_DATA);
      const parsed = JSON.parse(raw);
      // Fusion douce : garde les nouveaux champs par défaut si absents.
      return {
        trip: { ...DEFAULT_DATA.trip, ...(parsed.trip || {}) },
        planning: parsed.planning || clone(DEFAULT_DATA.planning),
        budget: Array.isArray(parsed.budget) ? parsed.budget : clone(DEFAULT_DATA.budget),
      };
    } catch (err) {
      console.warn('Lecture localStorage impossible, retour aux valeurs par défaut.', err);
      return clone(DEFAULT_DATA);
    }
  }

  function save(data) {
    localStorage.setItem(LS_KEY, JSON.stringify(data));
  }

  return { load, save, DEFAULT_DATA };
})();
