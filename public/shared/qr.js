/**
 * A very small QR encoder — version 1, alphanumeric mode, error correction H.
 *
 * Why write this instead of pulling in a library: the wristband has to be
 * printable at a registration desk with no internet, and a CDN script that
 * fails to load leaves a blank square on a child's wrist. So this is 200 lines
 * that never need a network.
 *
 * Why error correction H (the strongest, 30% recoverable): the code is printed
 * on paper, tied to a wrist, and then spends three days getting wet, muddy and
 * creased at a river. Half a torn wristband still scans.
 *
 * Constraints, deliberately: version 1 only (21x21 modules), alphanumeric
 * charset only. A 6-character join code fits with room to spare, and version 1
 * needs no alignment patterns or version blocks, which is what keeps this file
 * small enough to audit.
 */

const ALPHANUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

/* ------------------------------------------------ GF(256) for Reed-Solomon */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // QR's generator polynomial
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
})();

const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

function generatorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= mul(poly[j], 1);
      next[j + 1] ^= mul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function reedSolomon(data, eccLength) {
  const gen = generatorPoly(eccLength);
  const remainder = new Array(eccLength).fill(0);
  for (const byte of data) {
    const factor = byte ^ remainder[0];
    remainder.shift();
    remainder.push(0);
    for (let i = 0; i < eccLength; i += 1) {
      remainder[i] ^= mul(gen[i + 1], factor);
    }
  }
  return remainder;
}

/* ------------------------------------------------------------- encoding -- */

function encodeAlphanumeric(text) {
  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >> i) & 1);
  };

  push(0b0010, 4);        // alphanumeric mode indicator
  push(text.length, 9);   // character count, 9 bits for version 1

  for (let i = 0; i < text.length; i += 2) {
    const first = ALPHANUM.indexOf(text[i]);
    if (first < 0) throw new Error(`character not allowed in a QR code: ${text[i]}`);
    if (i + 1 < text.length) {
      const second = ALPHANUM.indexOf(text[i + 1]);
      push(first * 45 + second, 11);
    } else {
      push(first, 6);
    }
  }

  const DATA_CODEWORDS = 9; // version 1, ECC level H
  const capacity = DATA_CODEWORDS * 8;
  if (bits.length > capacity) {
    throw new Error('code is too long for a version 1 QR at this error correction level');
  }

  for (let i = 0; i < 4 && bits.length < capacity; i += 1) bits.push(0); // terminator
  while (bits.length % 8) bits.push(0);

  const bytes = [];
  for (let i = 0; i < bits.length; i += 8) {
    bytes.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
  }
  const PAD = [0xec, 0x11];
  let padIndex = 0;
  while (bytes.length < DATA_CODEWORDS) {
    bytes.push(PAD[padIndex % 2]);
    padIndex += 1;
  }

  return bytes.concat(reedSolomon(bytes, 17)); // 17 ECC codewords at level H
}

/* -------------------------------------------------------------- matrix --- */

const SIZE = 21;

function blankMatrix() {
  return {
    modules: Array.from({ length: SIZE }, () => new Array(SIZE).fill(null)),
    reserved: Array.from({ length: SIZE }, () => new Array(SIZE).fill(false)),
  };
}

function placeFinder(m, row, col) {
  for (let r = -1; r <= 7; r += 1) {
    for (let c = -1; c <= 7; c += 1) {
      const y = row + r;
      const x = col + c;
      if (y < 0 || y >= SIZE || x < 0 || x >= SIZE) continue;
      const inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6));
      const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      m.modules[y][x] = inRing || inCore ? 1 : 0;
      m.reserved[y][x] = true;
    }
  }
}

function placeFunctionPatterns(m) {
  placeFinder(m, 0, 0);
  placeFinder(m, 0, SIZE - 7);
  placeFinder(m, SIZE - 7, 0);

  for (let i = 8; i < SIZE - 8; i += 1) {
    const bit = i % 2 === 0 ? 1 : 0;
    m.modules[6][i] = bit;
    m.reserved[6][i] = true;
    m.modules[i][6] = bit;
    m.reserved[i][6] = true;
  }

  // Dark module, always set, always at this position.
  m.modules[SIZE - 8][8] = 1;
  m.reserved[SIZE - 8][8] = true;

  // Reserve the format information areas.
  for (let i = 0; i < 9; i += 1) {
    if (!m.reserved[8][i]) { m.reserved[8][i] = true; m.modules[8][i] = 0; }
    if (!m.reserved[i][8]) { m.reserved[i][8] = true; m.modules[i][8] = 0; }
  }
  for (let i = 0; i < 8; i += 1) {
    if (!m.reserved[8][SIZE - 1 - i]) { m.reserved[8][SIZE - 1 - i] = true; m.modules[8][SIZE - 1 - i] = 0; }
    if (!m.reserved[SIZE - 1 - i][8]) { m.reserved[SIZE - 1 - i][8] = true; m.modules[SIZE - 1 - i][8] = 0; }
  }
}

function placeData(m, codewords) {
  const bits = [];
  for (const byte of codewords) {
    for (let i = 7; i >= 0; i -= 1) bits.push((byte >> i) & 1);
  }

  let index = 0;
  let upward = true;
  for (let right = SIZE - 1; right > 0; right -= 2) {
    if (right === 6) right = 5; // skip the vertical timing column
    for (let step = 0; step < SIZE; step += 1) {
      const row = upward ? SIZE - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (m.reserved[row][col]) continue;
        m.modules[row][col] = index < bits.length ? bits[index] : 0;
        index += 1;
      }
    }
    upward = !upward;
  }
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function applyMask(m, maskIndex) {
  const fn = MASKS[maskIndex];
  for (let r = 0; r < SIZE; r += 1) {
    for (let c = 0; c < SIZE; c += 1) {
      if (!m.reserved[r][c] && fn(r, c)) m.modules[r][c] ^= 1;
    }
  }
}

function formatBits(maskIndex) {
  const ECC_H = 0b10; // error correction level H
  const data = (ECC_H << 3) | maskIndex;
  let value = data << 10;
  const GENERATOR = 0b10100110111;
  for (let i = 14; i >= 10; i -= 1) {
    if ((value >> i) & 1) value ^= GENERATOR << (i - 10);
  }
  return ((data << 10) | value) ^ 0b101010000010010;
}

function placeFormat(m, maskIndex) {
  const bits = formatBits(maskIndex);
  const bit = (i) => (bits >> i) & 1;

  // First copy: up the left of the top-right finder, then along row 8.
  // These coordinates are (row, col) — the spec and most reference code use
  // (x, y), which is the opposite order, and mixing them up produces a QR that
  // looks perfect and scans as nothing.
  for (let i = 0; i <= 5; i += 1) m.modules[i][8] = bit(i);
  m.modules[7][8] = bit(6);
  m.modules[8][8] = bit(7);
  m.modules[8][7] = bit(8);
  for (let i = 9; i <= 14; i += 1) m.modules[8][14 - i] = bit(i);

  // Second copy: bits 0-7 run right-to-left along row 8, bits 8-14 run down
  // column 8. Note this is the opposite axis order from the first copy.
  for (let i = 0; i <= 7; i += 1) m.modules[8][SIZE - 1 - i] = bit(i);
  for (let i = 8; i <= 14; i += 1) m.modules[SIZE - 15 + i][8] = bit(i);

  m.modules[SIZE - 8][8] = 1; // dark module, always set
}

/* ------------------------------------------------------- mask selection -- */

function penalty(m) {
  let score = 0;
  const at = (r, c) => m.modules[r][c];

  // Runs of five or more.
  for (let r = 0; r < SIZE; r += 1) {
    for (const horizontal of [true, false]) {
      let run = 1;
      for (let i = 1; i < SIZE; i += 1) {
        const current = horizontal ? at(r, i) : at(i, r);
        const previous = horizontal ? at(r, i - 1) : at(i - 1, r);
        if (current === previous) {
          run += 1;
        } else {
          if (run >= 5) score += run - 2;
          run = 1;
        }
      }
      if (run >= 5) score += run - 2;
    }
  }

  // 2x2 blocks of one colour.
  for (let r = 0; r < SIZE - 1; r += 1) {
    for (let c = 0; c < SIZE - 1; c += 1) {
      const v = at(r, c);
      if (v === at(r, c + 1) && v === at(r + 1, c) && v === at(r + 1, c + 1)) score += 3;
    }
  }

  // Finder-like patterns.
  const PATTERN = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  for (let r = 0; r < SIZE; r += 1) {
    for (let c = 0; c <= SIZE - 11; c += 1) {
      const row = [];
      const col = [];
      for (let i = 0; i < 11; i += 1) { row.push(at(r, c + i)); col.push(at(c + i, r)); }
      if (PATTERN.every((v, i) => v === row[i]) || PATTERN.every((v, i) => v === row[10 - i])) score += 40;
      if (PATTERN.every((v, i) => v === col[i]) || PATTERN.every((v, i) => v === col[10 - i])) score += 40;
    }
  }

  // Overall balance of dark to light.
  let dark = 0;
  for (let r = 0; r < SIZE; r += 1) for (let c = 0; c < SIZE; c += 1) dark += at(r, c);
  const percent = (dark * 100) / (SIZE * SIZE);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

/** @returns {number[][]} a 21x21 grid of 0 (light) and 1 (dark) */
export function encodeQR(text) {
  const codewords = encodeAlphanumeric(String(text).toUpperCase());

  let best = null;
  for (let mask = 0; mask < 8; mask += 1) {
    const m = blankMatrix();
    placeFunctionPatterns(m);
    placeData(m, codewords);
    applyMask(m, mask);
    placeFormat(m, mask);
    const score = penalty(m);
    if (!best || score < best.score) best = { score, modules: m.modules };
  }
  return best.modules;
}

/** Render as an SVG string. `quiet` is the mandatory white margin — four
 *  modules, per the spec. Drop it and many scanners simply will not see it. */
export function qrSVG(text, { size = 220, dark = '#0F3B44', light = '#FFFFFF', quiet = 4 } = {}) {
  const modules = encodeQR(text);
  const total = SIZE + quiet * 2;
  const scale = size / total;
  let rects = '';
  for (let r = 0; r < SIZE; r += 1) {
    for (let c = 0; c < SIZE; c += 1) {
      if (!modules[r][c]) continue;
      const x = ((c + quiet) * scale).toFixed(3);
      const y = ((r + quiet) * scale).toFixed(3);
      rects += `<rect x="${x}" y="${y}" width="${(scale + 0.4).toFixed(3)}" height="${(scale + 0.4).toFixed(3)}"/>`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR code ${text}"><rect width="${size}" height="${size}" fill="${light}"/><g fill="${dark}">${rects}</g></svg>`;
}
