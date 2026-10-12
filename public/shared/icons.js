/**
 * One icon set for every screen.
 *
 * 24×24, 2 px rounded strokes, drawn to read at a glance in bright sun and on
 * small cracked screens. Inline SVG, so they paint with no network and take
 * the text colour. Decorative by default (aria-hidden); pass `label` when an
 * icon is the only thing on a button.
 */

const P = {
  home: 'M4 11 12 4l8 7v8a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1z',
  map: 'M9 4 3 6.5v14L9 18l6 2.5 6-2.5v-14L15 6.5zM9 4v14M15 6.5v14',
  family: 'M8 11a3.2 3.2 0 1 0 0-6.4A3.2 3.2 0 0 0 8 11zm8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2 20c0-3.2 2.7-5 6-5s6 1.8 6 5M15 15.3c2.8.3 5 2 5 4.7',
  chat: 'M4 5h16v11H9l-5 4zM8.5 10.5h.01M12 10.5h.01M15.5 10.5h.01',
  toilet: 'M8 3.5a1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 0 1 0-3.6zM16 3.5a1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 0 1 0-3.6zM6 21v-6H4.5l1.5-6h4l1.5 6H10v6M14 21v-6.5L13 9h6l-1 5.5V21',
  water: 'M12 3c4 5 6 7.3 6 10a6 6 0 0 1-12 0c0-2.7 2-5 6-10zM9.5 14a2.5 2.5 0 0 0 2.5 2.5',
  medical: 'M9.5 3.5h5v6h6v5h-6v6h-5v-6h-6v-5h6z',
  police: 'M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6zM9.5 12l1.8 1.8 3.4-3.6',
  food: 'M4 11h16a8 8 0 0 1-16 0zM8.5 4.5v3.5M12 3.5v4.5M15.5 4.5v3.5',
  ghat: 'M3 9q3-3 6 0t6 0 6 0M3 15q3-3 6 0t6 0 6 0',
  gate: 'M5 21V10a7 7 0 0 1 14 0v11M3 21h18M9.5 21v-5h5v5',
  camp: 'M3 20 12 4l9 16zM12 4v16M8.5 20l3.5-6 3.5 6',
  pin: 'M12 21s-7-6.2-7-12a7 7 0 0 1 14 0c0 5.8-7 12-7 12zM12 11.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  navigate: 'M12 2.5 4.8 20l.7.7L12 17.6l6.5 3.1.7-.7z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3.2 2',
  bell: 'M6 16v-5a6 6 0 0 1 12 0v5l2 2H4zM10 20.5a2 2 0 0 0 4 0',
  megaphone: 'M3 10v4h3.5l8.5 5V5L6.5 10zM18.5 9a4 4 0 0 1 0 6',
  warning: 'M12 3 2.5 20h19L12 3zM12 10v4M12 17.2v.1',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5.5M12 7.6v.1',
  share: 'M4 12.5V19a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-6.5M12 3.5V15M7.5 8 12 3.5 16.5 8',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  eyeOff: 'M3 3l18 18M10.6 5.1C11 5 11.5 5 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7c2 0 3.8-.6 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2',
  wristband: 'M3 8.5h18v7H3zM8 8.5V6.5a4 4 0 0 1 8 0v2M8 15.5v2a4 4 0 0 0 8 0v-2M7 12h.01M17 12h.01',
  leave: 'M14 4h5v16h-5M10 8l-4 4 4 4M6 12h11',
  mic: 'M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM5 11a7 7 0 0 0 14 0M12 18v3',
  speaker: 'M4 9v6h4l5 4V5L8 9zM16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12',
  mute: 'M4 9v6h4l5 4V5L8 9zM17 9l5 6M22 9l-5 6',
  phone: 'M5 3h3.5l2 5L8 9.5a11 11 0 0 0 6.5 6.5L16 13.5l5 2V19a2 2 0 0 1-2 2A16 16 0 0 1 3 5a2 2 0 0 1 2-2z',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c0-4 3.6-6 8-6s8 2 8 6',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3.5 9h17M3.5 15h17M12 3c2.4 2.5 3.6 5.5 3.6 9s-1.2 6.5-3.6 9c-2.4-2.5-3.6-5.5-3.6-9S9.6 5.5 12 3z',
  plane: 'M21 15.5V14l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v1.5l8-2.5V18l-2 1.5V21l3.5-1 3.5 1v-1.5L13 18v-5z',
  check: 'M5 12.5l4.5 4.5L19.5 7',
  chevron: 'M9 6l6 6-6 6',
  close: 'M6 6l12 12M18 6 6 18',
  crowd: 'M7 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM17 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM12 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM3 19c0-2.8 1.8-5 4-5M21 19c0-2.8-1.8-5-4-5M7 20c0-3.5 2.2-6 5-6s5 2.5 5 6',
  route: 'M6 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM6 16V10a4 4 0 0 1 4-4h6M18 8v6a4 4 0 0 1-4 4H8',
  flag: 'M6 21V4h11l-2 3.5 2 3.5H6',
  battery: 'M3 8h15v8H3zM21 11v2M6 11v2',
  queue: 'M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6zM9.5 12l1.8 1.8 3.4-3.6',
  chart: 'M4 19V10M10 19V5M16 19v-7M21 19H3',
  phoneApp: 'M7 2.5h10a1.5 1.5 0 0 1 1.5 1.5v16a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 20V4A1.5 1.5 0 0 1 7 2.5zM11 18.5h2',
  qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2.5v2.5H14zM17.5 17.5H20V20h-2.5zM14 19h1M19 14h1',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
  lock: 'M6 11h12v10H6zM8.5 11V7.5a3.5 3.5 0 0 1 7 0V11M12 15v2.5',
  logout: 'M10 4H5v16h5M14 8l4 4-4 4M18 12H9',
  bellOn: 'M6 16v-5a6 6 0 0 1 12 0v5l2 2H4zM10 20.5a2 2 0 0 0 4 0M3 6.5A9 9 0 0 1 6 3M21 6.5A9 9 0 0 0 18 3',
  moon: 'M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z',
  contrast: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 3v18M12 3a9 9 0 0 1 0 18',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  timer: 'M12 21a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM12 9v4l2.5 1.5M9.5 2.5h5',
  signal: 'M5 18v-2M9.5 18v-5M14 18v-8M18.5 18V7',
};

/** Icons drawn filled rather than stroked. */
const FILLED = new Set(['navigate']);

export function icon(name, { size = 24, cls = '', label = null } = {}) {
  const d = P[name] ?? P.info;
  const filled = FILLED.has(name);
  const a11y = label ? `role="img" aria-label="${String(label).replace(/"/g, '&quot;')}"` : 'aria-hidden="true"';
  return `<svg class="ico ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" ${a11y} ` +
    `fill="${filled ? 'currentColor' : 'none'}" stroke="${filled ? 'none' : 'currentColor'}" ` +
    `stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
}

/**
 * Colours per kind of place, shared with the maps so a tile on Home looks
 * like the pin on the map. Medical is a deep rose, not vermilion: vermilion
 * means "the SOS button" and nothing else.
 */
export const PLACE_COLOUR = {
  ghat: '#1B5A66',
  medical: '#A33B57',
  police: '#0F3B44',
  toilet: '#6B6257',
  water: '#2F7A52',
  food: '#D9822B',
  camp: '#8A6A3F',
  gate: '#0F3B44',
};
