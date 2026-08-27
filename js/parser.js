/**
 * Extraction de texte PDF (pdf.js, vendored) + détection heuristique des
 * champs d'une entrée (type, dates, heure, prix, lieu, référence).
 *
 * Rien n'est garanti à 100% : c'est un pré-remplissage, l'utilisateur
 * valide ou corrige toujours dans le formulaire de confirmation.
 */
import * as pdfjsLib from '../vendor/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;

/**
 * Extrait tout le texte d'un fichier PDF (File/Blob), en reconstruisant les
 * retours à la ligne à partir de la position verticale des fragments de
 * texte (pdf.js ne les fournit pas telles quelles) — indispensable pour que
 * les heuristiques ligne par ligne (prix, lieu, référence) restent fiables.
 */
async function extractPdfText(file) {
  const buffer = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: buffer }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const lines = [];
    let currentLine = '';
    let lastY = null;
    for (const item of content.items) {
      if (!('str' in item)) continue;
      const y = item.transform ? item.transform[5] : null;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) {
        if (currentLine.trim()) lines.push(currentLine.trim());
        currentLine = '';
      }
      currentLine += (currentLine && !currentLine.endsWith(' ') && !item.str.startsWith(' ') ? ' ' : '') + item.str;
      lastY = y;
    }
    if (currentLine.trim()) lines.push(currentLine.trim());
    pages.push(lines.join('\n'));
  }
  return pages.join('\n');
}

// ---------------------------------------------------------------------
// Détection du type de document
// ---------------------------------------------------------------------
const TRANSPORT_KEYWORDS = [
  'flixbus', 'blablacar', 'blablabus', 'ouibus', 'eurolines',
  'sncf', 'trainline', 'eurostar', 'thalys', 'ouigo', 'ryanair',
  'easyjet', 'vueling', 'transavia', 'air france', 'lufthansa',
  'gare de', 'gare routière', 'aéroport', 'aeroport', 'boarding pass',
  'carte d\'embarquement', 'billet de train', 'ticket bus', 'flight',
  'vol n°', 'terminal', 'quai n°', 'voie n°',
];
const LODGING_KEYWORDS = [
  'hostelworld', 'booking.com', 'airbnb', 'hostel', 'hôtel', 'hotel',
  'auberge de jeunesse', 'check-in', 'check-out', 'nuitée', 'nuitées',
  'chambre', 'réservation logement', 'guest house',
];

function detectType(text) {
  const lower = text.toLowerCase();
  if (TRANSPORT_KEYWORDS.some((kw) => lower.includes(kw))) return 'transport';
  if (LODGING_KEYWORDS.some((kw) => lower.includes(kw))) return 'lodging';
  return 'event';
}

// ---------------------------------------------------------------------
// Détection des dates
// ---------------------------------------------------------------------
const MONTHS_FR = {
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
};

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Retourne une liste de dates ISO (YYYY-MM-DD) trouvées dans le texte, dans l'ordre d'apparition. */
function detectDates(text) {
  const found = [];

  // JJ.MM.AAAA ou JJ/MM/AAAA (AAAA sur 2 ou 4 chiffres)
  const numericRe = /\b(\d{1,2})[.\/](\d{1,2})[.\/](\d{2,4})\b/g;
  let m;
  while ((m = numericRe.exec(text))) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = `20${y}`;
    const day = Number(d);
    const month = Number(mo);
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      found.push({ index: m.index, iso: `${y}-${pad2(month)}-${pad2(day)}` });
    }
  }

  // "Ven. 28 août" / "28 août 2026" / "28 août" (jour + mois en lettres, année optionnelle)
  const monthNames = Object.keys(MONTHS_FR).join('|');
  const literalRe = new RegExp(`\\b(\\d{1,2})\\s+(${monthNames})\\.?\\s*(\\d{4})?`, 'gi');
  while ((m = literalRe.exec(text))) {
    const day = Number(m[1]);
    const month = MONTHS_FR[m[2].toLowerCase()];
    const year = m[3] || String(new Date().getFullYear());
    if (day >= 1 && day <= 31) {
      found.push({ index: m.index, iso: `${year}-${month}-${pad2(day)}` });
    }
  }

  found.sort((a, b) => a.index - b.index);
  // dédoublonne en gardant la première occurrence de chaque date
  const seen = new Set();
  const ordered = [];
  for (const f of found) {
    if (!seen.has(f.iso)) {
      seen.add(f.iso);
      ordered.push(f.iso);
    }
  }
  return ordered;
}

// ---------------------------------------------------------------------
// Détection de l'heure
// ---------------------------------------------------------------------
function detectTime(text) {
  const re = /\b([01]?\d|2[0-3])[:hH]([0-5]\d)\b/;
  const m = re.exec(text);
  return m ? `${pad2(Number(m[1]))}:${m[2]}` : null;
}

// ---------------------------------------------------------------------
// Détection du prix
// ---------------------------------------------------------------------
function detectPrice(text) {
  // Cherche en priorité une ligne mentionnant "total" ; accepte le symbole
  // € comme la mention "EUR".
  const lines = text.split(/\n/);
  const priceRe = /(\d{1,4}(?:[.,]\d{2})?)\s?(?:€|eur\b)|(?:€|eur\b)\s?(\d{1,4}(?:[.,]\d{2})?)/i;

  const totalLine = lines.find((l) => /total/i.test(l) && priceRe.test(l));
  const source = totalLine || text;
  const m = priceRe.exec(source);
  if (!m) return null;
  const raw = (m[1] || m[2]).replace(',', '.');
  const value = parseFloat(raw);
  return Number.isFinite(value) ? value : null;
}

// ---------------------------------------------------------------------
// Détection du lieu
// ---------------------------------------------------------------------
function detectPlace(text) {
  const labelRe = /(?:lieu|venue|adresse|destination|départ|depart|arrivée|arrivee|de\s*→\s*à)\s*[:\-]\s*([^\n]{3,60})/gi;
  // Un label "départ"/"arrivée" précède parfois une date/heure plutôt qu'un
  // lieu (ex. "Départ : 28.08.2026 à 14h30") : on ignore ces candidats-là et
  // on prend le premier qui ressemble vraiment à un nom de lieu.
  let m;
  while ((m = labelRe.exec(text))) {
    const candidate = m[1].trim();
    const looksLikeDateOrTime = /^\d{1,2}[.\/]\d{1,2}/.test(candidate);
    if (candidate && !looksLikeDateOrTime) return candidate;
  }
  return '';
}

// ---------------------------------------------------------------------
// Détection de la référence / numéro de commande
// ---------------------------------------------------------------------
function detectReference(text) {
  // Le séparateur (:, # ou n°) est obligatoire entre le libellé et le code :
  // sans ça, un mot du libellé lui-même ("commande", "booking"...) pourrait
  // être capturé comme s'il était la référence.
  const labelRe = /(?:r[ée]f(?:[ée]rence)?|commande|r[ée]servation|order\s*(?:number|id)?|booking\s*(?:number|id)?|confirmation)\s*(?:[:#]|n°)\s*([A-Z0-9-]{4,20})/gi;
  const m = labelRe.exec(text);
  return m ? m[1].trim() : '';
}

// ---------------------------------------------------------------------
// API principale
// ---------------------------------------------------------------------

/** Construit un titre par défaut lisible à partir du nom de fichier. */
function titleFromFilename(name) {
  return name
    .replace(/\.pdf$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Analyse un fichier PDF et retourne les champs détectés (pré-remplissage
 * du formulaire de confirmation). Ne lève pas d'exception sur un PDF
 * illisible : retourne des champs vides dans ce cas.
 */
async function analyzePdf(file) {
  const base = {
    type: 'event',
    title: titleFromFilename(file.name),
    startDate: null,
    startTime: null,
    endDate: null,
    place: '',
    price: null,
    reference: '',
  };

  let text = '';
  try {
    text = await extractPdfText(file);
  } catch (err) {
    console.warn('Lecture du PDF impossible, formulaire vide à compléter à la main.', err);
    return base;
  }

  const dates = detectDates(text);

  return {
    type: detectType(text),
    title: base.title,
    startDate: dates[0] || null,
    startTime: detectTime(text),
    endDate: dates.length > 1 ? dates[dates.length - 1] : null,
    place: detectPlace(text),
    price: detectPrice(text),
    reference: detectReference(text),
  };
}

export const VoyagheureParser = { analyzePdf, extractPdfText };
