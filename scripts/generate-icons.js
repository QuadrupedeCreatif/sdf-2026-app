/**
 * Génère les icônes PNG de la PWA (aucune dépendance externe).
 * Motif "soleil rétro" corail -> rose sur fond aubergine, dans la palette
 * de l'app. Ré-exécuter avec `node scripts/generate-icons.js` si les
 * couleurs de la charte changent.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const AUBERGINE = [0x1c, 0x10, 0x20];
const CORAIL = [0xf2, 0x89, 0x5a];
const ROSE = [0xe8, 0x5d, 0x86];

function lerp(a, b, t) {
  return Math.round(a + (b - a) * t);
}

function lerpColor(c1, c2, t) {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}

// --- CRC32 (nécessaire pour les chunks PNG) ---
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgbaPixels) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type RGBA
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;
  const ihdr = chunk('IHDR', ihdrData);

  // Raw scanlines: 1 filter byte (0) + width*4 bytes per row
  const raw = Buffer.alloc((width * 4 + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y++) {
    raw[offset++] = 0; // no filter
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      raw[offset++] = rgbaPixels[idx];
      raw[offset++] = rgbaPixels[idx + 1];
      raw[offset++] = rgbaPixels[idx + 2];
      raw[offset++] = rgbaPixels[idx + 3];
    }
  }

  const compressed = zlib.deflateSync(raw, { level: 9 });
  const idat = chunk('IDAT', compressed);
  const iend = chunk('IEND', Buffer.alloc(0));

  return Buffer.concat([sig, ihdr, idat, iend]);
}

/**
 * Dessine le motif "soleil rétro" dans un buffer RGBA.
 * @param {number} size largeur/hauteur du canvas
 * @param {number} radiusRatio rayon du soleil relatif à `size`
 */
function drawSunIcon(size, radiusRatio) {
  const pixels = new Uint8ClampedArray(size * size * 4);

  const cx = size / 2;
  const cy = size * 0.54;
  const r = size * radiusRatio;
  const stripeSpacing = Math.max(3, size * 0.05);
  const stripeThickness = stripeSpacing * 0.52;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      let color = AUBERGINE;
      let alpha = 255;

      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist <= r) {
        const t = Math.min(1, Math.max(0, (dy + r) / (2 * r)));
        const belowHorizon = dy > 0;
        if (belowHorizon) {
          const bandPos = dy % stripeSpacing;
          if (bandPos < stripeThickness) {
            color = lerpColor(CORAIL, ROSE, t);
          } // else: laisser le fond aubergine visible (lignes d'horizon)
        } else {
          color = lerpColor(CORAIL, ROSE, t);
        }
      }

      pixels[idx] = color[0];
      pixels[idx + 1] = color[1];
      pixels[idx + 2] = color[2];
      pixels[idx + 3] = alpha;
    }
  }

  return pixels;
}

function writeIcon(fileName, size, radiusRatio) {
  const pixels = drawSunIcon(size, radiusRatio);
  const png = encodePNG(size, size, pixels);
  const outPath = path.join(__dirname, '..', 'icons', fileName);
  fs.writeFileSync(outPath, png);
  console.log(`✓ ${fileName} (${size}x${size})`);
}

// Icônes "any" : le motif peut toucher les bords.
writeIcon('icon-192.png', 192, 0.4);
writeIcon('icon-512.png', 512, 0.4);

// Icônes "maskable" : rester dans la zone de sécurité (rayon <= 0.4*size),
// on prend une marge un peu plus large pour ne rien perdre au recadrage OS.
writeIcon('icon-192-maskable.png', 192, 0.32);
writeIcon('icon-512-maskable.png', 512, 0.32);

// Icône iOS (pas de transparence, pas de masquage géré par l'OS ici).
writeIcon('apple-touch-icon.png', 180, 0.4);

// Favicon.
writeIcon('favicon-32.png', 32, 0.42);
writeIcon('favicon-16.png', 16, 0.42);
