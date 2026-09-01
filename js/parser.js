/**
 * Extraction PDF (pdf.js, vendored) + détection heuristique des champs
 * d'une entrée (type, dates, heure, prix, lieu, adresse, référence).
 *
 * Approche par POSITION : on reconstruit les lignes de chaque page à
 * partir des coordonnées (x, y) de chaque fragment de texte que pdf.js
 * fournit (`item.transform`), au lieu de concaténer tout le texte en une
 * seule chaîne. Un champ est associé à sa valeur par proximité spatiale
 * (même ligne après un libellé, ou ligne suivante juste en dessous) —
 * pas par un regex appliqué à un texte plat où l'ordre peut être ambigu.
 *
 * Chaque champ détecté porte son "snippet" (l'extrait de texte source qui
 * a servi à la détection) et un booléen `confidence`. Rien n'est garanti
 * à 100% : c'est un pré-remplissage, l'utilisateur valide ou corrige
 * toujours dans le formulaire de confirmation. Un champ sans détection
 * fiable reste `null`/`confidence:false` plutôt que de deviner.
 *
 * Mémorisation des corrections (voir js/db.js, store "correctionRules") :
 * quand plusieurs candidats existent pour un champ (ex. plusieurs prix
 * sur la page — sous-total, taxes, total), on retient pour chaque
 * candidat le libellé qui l'a introduit. Si l'utilisateur corrige un
 * champ vers un autre candidat détecté, on mémorise que pour ce type de
 * document, ce libellé est préféré — appliqué dès le prochain import du
 * même type de document.
 */
import * as pdfjsLib from '../vendor/pdfjs/pdf.min.mjs';
import { VoyagheureDB } from './db.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;

// ---------------------------------------------------------------------
// Extraction positionnelle : pages -> lignes (avec x/y) -> texte
// ---------------------------------------------------------------------

/**
 * Reconstruit les lignes de chaque page à partir de la position (x, y)
 * de chaque fragment de texte, triées dans l'ordre de lecture naturel
 * (haut → bas, gauche → droite) plutôt que dans l'ordre d'émission brut
 * de pdf.js.
 */
async function extractPdfLines(file) {
  const buffer = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: buffer }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();

    const rows = [];
    let current = null;
    for (const item of content.items) {
      if (!('str' in item) || !item.str.trim()) continue;
      const x = item.transform ? item.transform[4] : 0;
      const y = item.transform ? item.transform[5] : 0;
      if (!current || Math.abs(current.y - y) > 2) {
        current = { y, items: [] };
        rows.push(current);
      }
      current.items.push({ str: item.str, x });
    }

    // Le repère PDF a un axe Y croissant vers le haut : la première ligne
    // de la page a le plus grand y.
    rows.sort((a, b) => b.y - a.y);
    rows.forEach((row) => row.items.sort((a, b) => a.x - b.x));

    const lines = rows
      .map((row) => ({
        y: row.y,
        x0: row.items[0]?.x ?? 0,
        text: row.items
          .map((it) => it.str)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim(),
      }))
      .filter((l) => l.text);

    pages.push({ pageIndex: i, lines });
  }
  return pages;
}

// ---------------------------------------------------------------------
// Recherche générique par proximité label → valeur
// ---------------------------------------------------------------------

/**
 * Cherche, pour chaque ligne contenant `labelRe`, une valeur soit sur la
 * même ligne juste après le libellé, soit (à défaut) sur une des
 * `searchNextLines` lignes suivantes de la même page — pour gérer les
 * mises en page en tableau où le libellé est au-dessus de la valeur.
 * `extractValue(text)` doit renvoyer `{ value, matchedText }` ou `null`.
 */
function findLabeledCandidates(allLines, labelRe, extractValue, { searchNextLines = 0 } = {}) {
  const candidates = [];
  allLines.forEach((line, idx) => {
    const m = labelRe.exec(line.text);
    labelRe.lastIndex = 0;
    if (!m) return;

    // Le libellé mémorisé est le texte de la ligne JUSQU'AU mot-clé inclus
    // (ex. "Sous-total", pas seulement "total") : indispensable pour
    // distinguer "Sous-total" de "Total" quand les deux contiennent le même
    // mot-clé — sinon la préférence apprise ne pourrait pas les départager.
    const label = line.text.slice(0, m.index + m[0].length).trim();
    const after = line.text.slice(m.index + m[0].length);
    const found = extractValue(after);
    if (found) {
      candidates.push({ value: found.value, label, snippet: line.text, page: line.page, y: line.y });
      return;
    }
    for (let n = 1; n <= searchNextLines; n++) {
      const next = allLines[idx + n];
      if (!next || next.page !== line.page) break;
      const found2 = extractValue(next.text);
      if (found2) {
        candidates.push({ value: found2.value, label, snippet: next.text, page: next.page, y: next.y });
        break;
      }
    }
  });
  return candidates;
}

function toField(candidate) {
  if (!candidate) return { value: null, snippet: null, confidence: false };
  return { value: candidate.value, snippet: candidate.snippet, confidence: true };
}

/** Applique la règle apprise (préférence de libellé) si elle matche un des candidats, sinon garde l'ordre par défaut. */
function chooseCandidate(candidates, rule) {
  if (candidates.length === 0) return null;
  if (rule && rule.preferLabel) {
    const preferred = candidates.find((c) => c.label && c.label.toLowerCase().includes(rule.preferLabel.toLowerCase()));
    if (preferred) return preferred;
  }
  return candidates[0];
}

// ---------------------------------------------------------------------
// Type de document — mots-clés pondérés (fort = 3, faible = 1)
// ---------------------------------------------------------------------
const TRANSPORT_STRONG = [
  'flixbus', 'blablacar', 'blablabus', 'ouibus', 'eurolines',
  'sncf', 'trainline', 'eurostar', 'thalys', 'ouigo', 'ryanair',
  'easyjet', 'vueling', 'transavia', 'air france', 'lufthansa',
  'gare de', 'gare routière', 'aéroport', 'aeroport', 'boarding pass',
  'carte d\'embarquement', 'billet de train', 'ticket bus', 'flight',
  'vol n°', 'terminal', 'quai n°', 'voie n°',
];
const TRANSPORT_WEAK = ['départ', 'depart', 'arrivée', 'arrivee'];

const LODGING_STRONG = [
  'hostelworld', 'booking.com', 'airbnb', 'hostel', 'hôtel', 'hotel',
  'auberge de jeunesse', 'check-in', 'check-out', 'nuitée', 'nuitées',
  'nuit', 'chambre', 'réservation logement', 'guest house',
];

const EVENT_STRONG = ['billet', 'ticket', 'portes', 'doors', 'concert', 'festival', 'salle'];

function scoreKeywords(lower, list, weight) {
  return list.reduce((sum, kw) => sum + (lower.includes(kw) ? weight : 0), 0);
}

function scoreTypes(lower) {
  return {
    transport: scoreKeywords(lower, TRANSPORT_STRONG, 3) + scoreKeywords(lower, TRANSPORT_WEAK, 1),
    lodging: scoreKeywords(lower, LODGING_STRONG, 3),
    event: scoreKeywords(lower, EVENT_STRONG, 2),
  };
}

function bestType(lower) {
  const scores = scoreTypes(lower);
  const [type, score] = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return { type, score };
}

function detectTypeField(allLines, text) {
  const { type, score } = bestType(text.toLowerCase());
  if (score === 0) return { value: 'event', snippet: null, confidence: false };
  const keywordsByType = { transport: [...TRANSPORT_STRONG, ...TRANSPORT_WEAK], lodging: LODGING_STRONG, event: EVENT_STRONG };
  const kws = keywordsByType[type];
  const line = allLines.find((l) => kws.some((kw) => l.text.toLowerCase().includes(kw)));
  return { value: type, snippet: line ? line.text : null, confidence: true };
}

// Fournisseurs connus -> signature de document précise (sinon on retombe
// sur "type:<transport|lodging|event>").
const KNOWN_PROVIDERS = [
  'flixbus', 'blablacar', 'ouibus', 'sncf', 'trainline', 'eurostar', 'thalys',
  'ouigo', 'ryanair', 'easyjet', 'transavia', 'air france', 'lufthansa',
  'hostelworld', 'booking.com', 'airbnb',
];

function detectDocSignature(text) {
  const lower = text.toLowerCase();
  const provider = KNOWN_PROVIDERS.find((p) => lower.includes(p));
  if (provider) return provider.replace(/[^a-z0-9]/g, '');
  return `type:${bestType(lower).type}`;
}

// ---------------------------------------------------------------------
// Dates — JJ.MM.AAAA, JJ/MM/AAAA, "28 août 2026", "28 August"
// ---------------------------------------------------------------------
const MONTHS = {
  // Français
  janvier: '01', janv: '01', jan: '01',
  février: '02', fevrier: '02', févr: '02', fevr: '02', fev: '02',
  mars: '03',
  avril: '04', avr: '04',
  mai: '05',
  juin: '06',
  juillet: '07', juil: '07',
  août: '08', aout: '08',
  septembre: '09', sept: '09', sep: '09',
  octobre: '10', oct: '10',
  novembre: '11', nov: '11',
  décembre: '12', decembre: '12', déc: '12', dec: '12',
  // Anglais
  january: '01',
  february: '02', feb: '02',
  march: '03', mar: '03',
  april: '04', apr: '04',
  june: '06', jun: '06',
  july: '07', jul: '07',
  august: '08', aug: '08',
  september: '09',
  october: '10',
  november: '11',
  december: '12',
};
const MONTH_NAMES_RE = Object.keys(MONTHS).join('|');

function pad2(n) {
  return String(n).padStart(2, '0');
}

function detectDatesField(allLines) {
  const found = [];
  allLines.forEach((line) => {
    const numericRe = /\b(\d{1,2})[.\/](\d{1,2})[.\/](\d{2,4})\b/g;
    let m;
    while ((m = numericRe.exec(line.text))) {
      let [, d, mo, y] = m;
      if (y.length === 2) y = `20${y}`;
      const day = Number(d);
      const month = Number(mo);
      if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
        found.push({ iso: `${y}-${pad2(month)}-${pad2(day)}`, snippet: line.text });
      }
    }
    const literalRe = new RegExp(`\\b(\\d{1,2})\\s+(${MONTH_NAMES_RE})\\.?\\s*(\\d{4})?`, 'gi');
    while ((m = literalRe.exec(line.text))) {
      const day = Number(m[1]);
      const month = MONTHS[m[2].toLowerCase()];
      const year = m[3] || String(new Date().getFullYear());
      if (day >= 1 && day <= 31) {
        found.push({ iso: `${year}-${month}-${pad2(day)}`, snippet: line.text });
      }
    }
  });

  const seen = new Set();
  const ordered = [];
  found.forEach((f) => {
    if (!seen.has(f.iso)) {
      seen.add(f.iso);
      ordered.push(f);
    }
  });

  const start = ordered[0];
  const end = ordered.length > 1 ? ordered[ordered.length - 1] : null;
  return {
    startDate: start ? { value: start.iso, snippet: start.snippet, confidence: true } : { value: null, snippet: null, confidence: false },
    endDate: end ? { value: end.iso, snippet: end.snippet, confidence: true } : { value: null, snippet: null, confidence: false },
  };
}

// ---------------------------------------------------------------------
// Heure
// ---------------------------------------------------------------------
function detectTimeField(allLines) {
  const re = /\b([01]?\d|2[0-3])[:hH]([0-5]\d)\b/;
  for (const line of allLines) {
    const m = re.exec(line.text);
    if (m) return { value: `${pad2(Number(m[1]))}:${m[2]}`, snippet: line.text, confidence: true };
  }
  return { value: null, snippet: null, confidence: false };
}

// ---------------------------------------------------------------------
// Prix — "24,00 €", "€ 24,00 EUR", "Total: 27,49 €"
// ---------------------------------------------------------------------
const PRICE_LABELS = /total|prix|montant|amount|price/i;

function extractPrice(text) {
  const m = /(\d{1,4}[.,]\d{2})\s?(?:€|EUR)\b/i.exec(text) || /(?:€|EUR)\s?(\d{1,4}[.,]\d{2})/i.exec(text);
  if (!m) return null;
  const value = parseFloat(m[1].replace(',', '.'));
  return Number.isFinite(value) ? { value, matchedText: m[0] } : null;
}

function findPriceCandidates(allLines) {
  let candidates = findLabeledCandidates(allLines, PRICE_LABELS, extractPrice, { searchNextLines: 1 });
  if (candidates.length === 0) {
    allLines.forEach((line) => {
      const found = extractPrice(line.text);
      if (found) candidates.push({ value: found.value, label: null, snippet: line.text, page: line.page, y: line.y });
    });
  }
  // Par défaut, un montant labellisé "sous-total"/"partiel" passe après
  // les autres (Total, Prix, Montant...) — une règle apprise peut ensuite
  // préférer un autre libellé pour un type de document donné.
  const SUB_AMOUNT_RE = /sous|partiel|subtotal/i;
  candidates.sort((a, b) => {
    const aSub = a.label && SUB_AMOUNT_RE.test(a.label) ? 1 : 0;
    const bSub = b.label && SUB_AMOUNT_RE.test(b.label) ? 1 : 0;
    return aSub - bSub;
  });
  return candidates;
}

// ---------------------------------------------------------------------
// Référence / numéro de commande
// ---------------------------------------------------------------------
const REFERENCE_LABELS = /r[ée]f(?:[ée]rence)?|commande|r[ée]servation|order\s*(?:number|id)?|booking\s*(?:number|id)?|confirmation/i;

function extractReference(text) {
  const m = /(?:[:#]|n°)\s*([A-Z0-9][A-Z0-9-]{3,19})\b/.exec(text);
  if (!m) return null;
  return { value: m[1], matchedText: m[0] };
}

function findReferenceCandidates(allLines) {
  return findLabeledCandidates(allLines, REFERENCE_LABELS, extractReference, { searchNextLines: 1 });
}

// ---------------------------------------------------------------------
// Lieu
// ---------------------------------------------------------------------
const PLACE_LABELS = /lieu|venue|destination|d[ée]part|arriv[ée]e/i;

function extractPlaceValue(text) {
  const cleaned = text.replace(/^\s*[:\-]\s*/, '').trim();
  if (!cleaned || cleaned.length > 60) return null;
  if (/^\d{1,2}[.\/]\d{1,2}/.test(cleaned)) return null; // ressemble à une date, pas un lieu
  return { value: cleaned, matchedText: cleaned };
}

function findPlaceCandidates(allLines) {
  return findLabeledCandidates(allLines, PLACE_LABELS, extractPlaceValue, { searchNextLines: 0 });
}

// ---------------------------------------------------------------------
// Adresse — ligne "code postal + ville" combinée à la ligne de rue au-dessus
// ---------------------------------------------------------------------
const POSTAL_CITY_RE = /^\d{4,5}\s?[A-Z]{0,2}\s+[A-ZÀ-Ü][\p{L}'-]+/u;
const ADDRESS_NOISE_RE = /total|prix|price|r[ée]f[ée]rence|commande|r[ée]servation|confirmation|booking|billet|ticket/i;

function findAddressCandidates(allLines) {
  const candidates = [];
  allLines.forEach((line, idx) => {
    if (!POSTAL_CITY_RE.test(line.text)) return;
    const prevRaw = allLines[idx - 1];
    const prev = prevRaw && prevRaw.page === line.page ? prevRaw.text.replace(/^(?:adresse|address)\s*[:\-]\s*/i, '').trim() : '';
    const looksLikeStreet = prev && /\d/.test(prev) && prev.length < 60 && !ADDRESS_NOISE_RE.test(prev) && !POSTAL_CITY_RE.test(prev);
    const value = looksLikeStreet ? `${prev}, ${line.text}` : line.text;
    candidates.push({ value, label: 'adresse', snippet: value, page: line.page, y: line.y });
  });
  return candidates;
}

// ---------------------------------------------------------------------
// API principale
// ---------------------------------------------------------------------

function titleFromFilename(name) {
  return name
    .replace(/\.pdf$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function emptyField() {
  return { value: null, snippet: null, confidence: false };
}

function emptyAnalysis(file) {
  return {
    type: { value: 'event', snippet: null, confidence: false },
    title: titleFromFilename(file.name),
    startDate: emptyField(),
    startTime: emptyField(),
    endDate: emptyField(),
    place: emptyField(),
    address: emptyField(),
    price: emptyField(),
    reference: emptyField(),
    docSignature: null,
    candidates: {},
  };
}

/**
 * Analyse un fichier PDF et retourne les champs détectés (pré-remplissage
 * du formulaire de confirmation), chacun avec sa valeur, son extrait
 * source (`snippet`) et un booléen `confidence`. Ne lève pas d'exception
 * sur un PDF illisible : retourne des champs vides dans ce cas.
 */
async function analyzePdf(file) {
  const base = emptyAnalysis(file);

  let pages;
  try {
    pages = await extractPdfLines(file);
  } catch (err) {
    console.warn('Lecture du PDF impossible, formulaire vide à compléter à la main.', err);
    return base;
  }

  const allLines = pages.flatMap((p) => p.lines.map((l) => ({ ...l, page: p.pageIndex })));
  if (allLines.length === 0) return base;

  const text = allLines.map((l) => l.text).join('\n');
  const docSignature = detectDocSignature(text);

  const typeField = detectTypeField(allLines, text);
  const { startDate, endDate } = detectDatesField(allLines);
  const startTime = detectTimeField(allLines);

  const priceCandidates = findPriceCandidates(allLines);
  const referenceCandidates = findReferenceCandidates(allLines);
  const addressCandidates = findAddressCandidates(allLines);
  const placeCandidates = findPlaceCandidates(allLines);

  let priceRule = null;
  let referenceRule = null;
  let addressRule = null;
  let placeRule = null;
  try {
    [priceRule, referenceRule, addressRule, placeRule] = await Promise.all([
      VoyagheureDB.getCorrectionRule(docSignature, 'price'),
      VoyagheureDB.getCorrectionRule(docSignature, 'reference'),
      VoyagheureDB.getCorrectionRule(docSignature, 'address'),
      VoyagheureDB.getCorrectionRule(docSignature, 'place'),
    ]);
  } catch (err) {
    // Pas bloquant : sans règles apprises, on garde l'heuristique par défaut.
  }

  return {
    type: typeField,
    title: base.title,
    startDate,
    startTime,
    endDate,
    place: toField(chooseCandidate(placeCandidates, placeRule)),
    address: toField(chooseCandidate(addressCandidates, addressRule)),
    price: toField(chooseCandidate(priceCandidates, priceRule)),
    reference: toField(chooseCandidate(referenceCandidates, referenceRule)),
    docSignature,
    candidates: {
      price: priceCandidates,
      reference: referenceCandidates,
      address: addressCandidates,
      place: placeCandidates,
    },
  };
}

export const VoyagheureParser = { analyzePdf, titleFromFilename, emptyAnalysis };
