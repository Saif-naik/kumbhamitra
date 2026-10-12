/**
 * The mela ground as a graph.
 *
 * This ships with the app. It is ~6 KB, so it is available with zero network,
 * which is the whole point: the only thing that has to travel over the wire
 * during the event is one small number per path (how crowded it is).
 *
 * Coordinates are in map units (0..1000 x, 0..700 y). `geo` converts them to
 * lat/lng for a real basemap later. Swap ORIGIN for your actual ground.
 */

export const GROUND = {
  name: 'Triveni Mela Ground',
  width: 1000,
  height: 700,
  // Real-world anchor for the bottom-left corner of the map, so the graph can
  // be laid over street/satellite tiles. Placed on the south bank of the
  // Yamuna just upstream of the Sangam at Prayagraj, so the river runs along
  // the top of the ground as it does in the drawing. ILLUSTRATIVE: this demo
  // ground is invented. For a real mela, survey each landmark and give it
  // exact `lat`/`lng` (see nodeLatLng) instead of projecting from here.
  origin: { lat: 25.3997, lng: 81.8400 },
  metresPerUnit: 4.2,
};

const N = (id, type, x, y, en, hi, mr) => ({ id, type, x, y, name: { en, hi, mr } });

export const NODES = [
  // River front
  N('ghat_ram',     'ghat',     250,  92, 'Ram Ghat',        'राम घाट',        'राम घाट'),
  N('ghat_sangam',  'ghat',     500,  78, 'Sangam Ghat',     'संगम घाट',       'संगम घाट'),
  N('ghat_hanuman', 'ghat',     762,  95, 'Hanuman Ghat',    'हनुमान घाट',     'हनुमान घाट'),

  // River approach band
  N('j_river_w', 'junction', 250, 182, 'West Approach',   'पश्चिम मार्ग',   'पश्चिम मार्ग'),
  N('j_river_c', 'junction', 500, 178, 'Sangam Approach', 'संगम मार्ग',     'संगम मार्ग'),
  N('j_river_e', 'junction', 762, 186, 'East Approach',   'पूर्वी मार्ग',   'पूर्व मार्ग'),

  // Main spine
  N('j_w',  'junction', 168, 300, 'West Crossing',   'पश्चिम चौराहा', 'पश्चिम चौक'),
  N('j_cw', 'junction', 358, 300, 'Tent Crossing',   'तंबू चौराहा',   'तंबू चौक'),
  N('j_c',  'junction', 522, 300, 'Main Crossing',   'मुख्य चौराहा',  'मुख्य चौक'),
  N('j_ce', 'junction', 700, 300, 'Mela Crossing',   'मेला चौराहा',   'मेळा चौक'),
  N('j_e',  'junction', 886, 300, 'East Crossing',   'पूर्वी चौराहा', 'पूर्व चौक'),

  // Facilities
  N('med_1',    'medical', 300, 240, 'Medical Post 1',  'चिकित्सा केंद्र 1', 'वैद्यकीय केंद्र 1'),
  N('med_2',    'medical', 800, 372, 'Medical Post 2',  'चिकित्सा केंद्र 2', 'वैद्यकीय केंद्र 2'),
  N('police_1', 'police',  522, 384, 'Lost & Found Chowki', 'खोया-पाया चौकी', 'हरवले-सापडले चौकी'),
  N('toilet_1', 'toilet',  420, 232, 'Toilets (North)', 'शौचालय (उत्तर)',  'स्वच्छतागृह (उत्तर)'),
  N('toilet_2', 'toilet',  700, 474, 'Toilets (South)', 'शौचालय (दक्षिण)', 'स्वच्छतागृह (दक्षिण)'),
  N('water_1',  'water',   248, 352, 'Water Point 1',   'पानी केंद्र 1',   'पाणी केंद्र 1'),
  N('water_2',  'water',   640, 248, 'Water Point 2',   'पानी केंद्र 2',   'पाणी केंद्र 2'),
  N('food_1',   'food',    500, 500, 'Bhandara Hall',   'भंडारा',          'भंडारा'),

  // Camps
  N('camp_a', 'camp', 150, 432, 'Sector A Camp', 'सेक्टर A शिविर', 'सेक्टर A शिबिर'),
  N('camp_b', 'camp', 378, 432, 'Sector B Camp', 'सेक्टर B शिविर', 'सेक्टर B शिबिर'),
  N('camp_c', 'camp', 622, 432, 'Sector C Camp', 'सेक्टर C शिविर', 'सेक्टर C शिबिर'),
  N('camp_d', 'camp', 886, 432, 'Sector D Camp', 'सेक्टर D शिविर', 'सेक्टर D शिबिर'),

  // Entrances
  N('gate_1', 'gate', 200, 622, 'Gate 1 — Bus Stand', 'गेट 1 — बस अड्डा',  'गेट 1 — बस स्थानक'),
  N('gate_2', 'gate', 520, 622, 'Gate 2 — Railway',   'गेट 2 — रेलवे',     'गेट 2 — रेल्वे'),
  N('gate_3', 'gate', 866, 622, 'Gate 3 — Parking',   'गेट 3 — पार्किंग',  'गेट 3 — पार्किंग'),
];

const E = (id, a, b, base = 1) => ({ id, a, b, base });

export const EDGES = [
  E('e01', 'ghat_ram', 'ghat_sangam', 2),
  E('e02', 'ghat_sangam', 'ghat_hanuman', 2),
  E('e03', 'ghat_ram', 'j_river_w'),
  E('e04', 'ghat_sangam', 'j_river_c', 2),
  E('e05', 'ghat_hanuman', 'j_river_e'),
  E('e06', 'j_river_w', 'j_river_c'),
  E('e07', 'j_river_c', 'j_river_e'),
  E('e08', 'j_river_w', 'j_cw'),
  E('e09', 'j_river_c', 'j_c', 2),
  E('e10', 'j_river_e', 'j_ce'),
  E('e11', 'j_w', 'j_cw'),
  E('e12', 'j_cw', 'j_c'),
  E('e13', 'j_c', 'j_ce'),
  E('e14', 'j_ce', 'j_e'),
  E('e15', 'j_river_w', 'med_1'),
  E('e16', 'med_1', 'j_cw'),
  E('e17', 'j_cw', 'toilet_1'),
  E('e18', 'toilet_1', 'j_river_c'),
  E('e19', 'j_c', 'water_2'),
  E('e20', 'water_2', 'j_river_e'),
  E('e21', 'j_c', 'police_1'),
  E('e22', 'j_ce', 'med_2'),
  E('e23', 'med_2', 'camp_d'),
  E('e24', 'j_w', 'water_1'),
  E('e25', 'water_1', 'camp_a'),
  E('e26', 'j_w', 'camp_a'),
  E('e27', 'j_cw', 'camp_b'),
  E('e28', 'j_ce', 'camp_c'),
  E('e29', 'j_e', 'camp_d'),
  E('e30', 'police_1', 'camp_b'),
  E('e31', 'police_1', 'camp_c'),
  E('e32', 'camp_b', 'food_1'),
  E('e33', 'food_1', 'camp_c'),
  E('e34', 'camp_c', 'toilet_2'),
  E('e35', 'toilet_2', 'camp_d'),
  E('e36', 'camp_a', 'camp_b'),
  E('e37', 'gate_1', 'camp_a'),
  E('e38', 'gate_2', 'food_1'),
  E('e39', 'gate_3', 'camp_d'),
  E('e40', 'gate_1', 'gate_2'),
  E('e41', 'gate_2', 'gate_3'),
  E('e42', 'gate_2', 'camp_b'),
  E('e43', 'gate_2', 'camp_c'),
];

export const NODE_BY_ID = Object.fromEntries(NODES.map((n) => [n.id, n]));

/** Straight-line distance between two nodes, in metres. */
export function distance(aId, bId) {
  const a = NODE_BY_ID[aId];
  const b = NODE_BY_ID[bId];
  return Math.hypot(a.x - b.x, a.y - b.y) * GROUND.metresPerUnit;
}

/** Map units -> approximate lat/lng, for when a real basemap goes underneath. */
export function geo(x, y) {
  const mPerDegLat = 111_320;
  const lat = GROUND.origin.lat + ((GROUND.height - y) * GROUND.metresPerUnit) / mPerDegLat;
  const lng =
    GROUND.origin.lng +
    (x * GROUND.metresPerUnit) / (mPerDegLat * Math.cos((GROUND.origin.lat * Math.PI) / 180));
  return { lat: +lat.toFixed(6), lng: +lng.toFixed(6) };
}

const M_PER_DEG_LAT = 111_320;
const mPerDegLng = () => M_PER_DEG_LAT * Math.cos((GROUND.origin.lat * Math.PI) / 180);

/** lat/lng -> map units. The inverse of geo(). */
export function toUnits(lat, lng) {
  return {
    x: ((lng - GROUND.origin.lng) * mPerDegLng()) / GROUND.metresPerUnit,
    y: GROUND.height - ((lat - GROUND.origin.lat) * M_PER_DEG_LAT) / GROUND.metresPerUnit,
  };
}

/**
 * Where a landmark is on the real map. A surveyed `lat`/`lng` on the node
 * wins; otherwise it is projected from the drawing.
 */
export function nodeLatLng(id) {
  const node = NODE_BY_ID[id];
  if (!node) return null;
  if (Number.isFinite(node.lat) && Number.isFinite(node.lng)) return { lat: node.lat, lng: node.lng };
  return geo(node.x, node.y);
}

/** The ground's corners, for fitting the map and telling "on site" from "elsewhere". */
export function groundBounds() {
  const sw = geo(0, GROUND.height);
  const ne = geo(GROUND.width, 0);
  return { south: sw.lat, west: sw.lng, north: ne.lat, east: ne.lng };
}

/** Metres between two lat/lng points (equirectangular — plenty at mela scale). */
export function metresBetween(a, b) {
  const dy = (a.lat - b.lat) * M_PER_DEG_LAT;
  const dx = (a.lng - b.lng) * M_PER_DEG_LAT * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
  return Math.hypot(dx, dy);
}

/** Is this point on (or within `marginMetres` of) the mela ground? */
export function onGround(lat, lng, marginMetres = 300) {
  const { x, y } = toUnits(lat, lng);
  const m = marginMetres / GROUND.metresPerUnit;
  return x >= -m && x <= GROUND.width + m && y >= -m && y <= GROUND.height + m;
}

/**
 * The landmark nearest a GPS fix. This is what leaves the phone — a landmark,
 * never the raw coordinates. Junctions are allowed so a pilgrim walking a
 * path is placed on it, not at a toilet block 200 m away.
 */
export function nearestNode(lat, lng) {
  let best = null;
  for (const node of NODES) {
    const p = nodeLatLng(node.id);
    const d = metresBetween({ lat, lng }, p);
    if (!best || d < best.metres) best = { node, metres: d };
  }
  return best;
}

/** Coarse geohash-ish cell. What we store; never the precise point. */
export function cell(x, y) {
  return `${Math.floor(x / 50)}:${Math.floor(y / 50)}`;
}

export const CROWD = {
  1: { key: 'clear',  multiplier: 1,    en: 'Clear',      hi: 'खाली',      mr: 'मोकळे' },
  2: { key: 'busy',   multiplier: 2.4,  en: 'Busy',       hi: 'भीड़',      mr: 'गर्दी' },
  3: { key: 'heavy',  multiplier: 6,    en: 'Very heavy', hi: 'भारी भीड़', mr: 'खूप गर्दी' },
  4: { key: 'closed', multiplier: Infinity, en: 'Closed', hi: 'बंद',      mr: 'बंद' },
};
