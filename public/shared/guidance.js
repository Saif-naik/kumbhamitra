/**
 * Turn-by-turn guidance along a crowd-aware route.
 *
 * Pure logic, no DOM: it runs the same in the browser and in tests. Given a
 * route from routing.js and a stream of positions (GPS or simulated), it
 * answers what a walking pilgrim needs at each moment:
 *
 *   - which leg of the route they are on, and how far to the next landmark
 *   - what to do there, as a sentence in their language AND as an arrow angle
 *     (an arrow needs no reading — many users here read little or not at all)
 *   - how much is left, in metres and in crowd-adjusted minutes
 *   - whether they have wandered off the route, or arrived
 *
 * Instructions name landmarks, never street names, for the same reason the
 * rest of the app does: mela roads are days old and nobody knows their names.
 */

import { NODES, NODE_BY_ID, GROUND, toUnits, nodeLatLng, metresBetween } from './mela-map.js';
import { route } from './routing.js';

const ARRIVE_METRES = 20;   // close enough to say "you are there"
const ADVANCE_METRES = 15;  // passed a landmark, move to the next leg
const NEAR_METRES = 60;     // time to announce the coming turn
const OFF_ROUTE_METRES = 45;
const RETREAT_METRES = 30;  // this much further from the next landmark than our best = walking away
const LOST_METRES = 250;    // this far from the route is off it, whichever way you walk
const WALK_SPEED = 1.1;     // m/s for the walk to the route, same as routing.js
const HERE = '@here';

/** Position in metres on a flat local grid (fine over a few kilometres). */
function local(lat, lng) {
  const { x, y } = toUnits(lat, lng);
  return { x: x * GROUND.metresPerUnit, y: y * GROUND.metresPerUnit };
}

function nodeLocal(id) {
  const p = nodeLatLng(id);
  return local(p.lat, p.lng);
}

/** Closest point on segment ab to p, with how far along (0..1) it is. */
function project(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  const q = { x: a.x + t * dx, y: a.y + t * dy };
  return { t, point: q, distance: Math.hypot(p.x - q.x, p.y - q.y) };
}

/**
 * Signed turn angle at node `at`, arriving from `from` and leaving to `to`.
 * 0 is straight on, positive is right, negative is left, ±180 is turn back.
 * (Map y grows downward, so a clockwise turn on screen is a right turn.)
 */
export function turnAngle(fromId, atId, toId) {
  return angleBetween(nodeLocal(fromId), nodeLocal(atId), nodeLocal(toId));
}

function angleBetween(a, b, c) {
  const inAngle = Math.atan2(b.y - a.y, b.x - a.x);
  const outAngle = Math.atan2(c.y - b.y, c.x - b.x);
  let deg = ((outAngle - inAngle) * 180) / Math.PI;
  deg = ((deg + 540) % 360) - 180;
  return Math.round(deg);
}

/** The turn, in words, for an angle. */
function turnWords(deg, lang) {
  const abs = Math.abs(deg);
  const right = deg > 0;
  const W = {
    straight: { en: 'go straight', hi: 'सीधे चलिए', mr: 'सरळ चला' },
    slightR: { en: 'keep right', hi: 'थोड़ा दाएँ रहिए', mr: 'थोडे उजवीकडे रहा' },
    slightL: { en: 'keep left', hi: 'थोड़ा बाएँ रहिए', mr: 'थोडे डावीकडे रहा' },
    right: { en: 'turn right', hi: 'दाएँ मुड़िए', mr: 'उजवीकडे वळा' },
    left: { en: 'turn left', hi: 'बाएँ मुड़िए', mr: 'डावीकडे वळा' },
    sharpR: { en: 'turn sharp right', hi: 'तेज़ दाएँ मुड़िए', mr: 'तीव्र उजवीकडे वळा' },
    sharpL: { en: 'turn sharp left', hi: 'तेज़ बाएँ मुड़िए', mr: 'तीव्र डावीकडे वळा' },
    back: { en: 'turn around', hi: 'पीछे मुड़िए', mr: 'मागे वळा' },
  };
  const key = abs < 25 ? 'straight'
    : abs < 60 ? (right ? 'slightR' : 'slightL')
    : abs < 135 ? (right ? 'right' : 'left')
    : abs < 165 ? (right ? 'sharpR' : 'sharpL')
    : 'back';
  return W[key][lang] ?? W[key].en;
}

const name = (id, lang) => NODE_BY_ID[id]?.name[lang] ?? NODE_BY_ID[id]?.name.en ?? '';

/** Round a distance the way people say it while walking. */
export function spokenMetres(m) {
  if (m < 30) return Math.max(5, Math.round(m / 5) * 5);
  if (m < 200) return Math.round(m / 10) * 10;
  return Math.round(m / 50) * 50;
}

const PHRASE = {
  en: {
    start: (target) => `Head towards ${target}`,
    inTurn: (m, turn, at, target) => `In ${m} m at ${at}, ${turn} towards ${target}`,
    nowTurn: (turn, at, target) => `At ${at}, ${turn} towards ${target}`,
    inArrive: (m, target) => `${target} is ${m} m ahead`,
    arrived: (target) => `You have arrived at ${target}`,
  },
  hi: {
    start: (target) => `${target} की ओर चलिए`,
    inTurn: (m, turn, at, target) => `${m} मीटर बाद ${at} पर ${turn} — ${target} की ओर`,
    nowTurn: (turn, at, target) => `${at} पर ${turn} — ${target} की ओर`,
    inArrive: (m, target) => `${target} ${m} मीटर आगे है`,
    arrived: (target) => `आप ${target} पहुँच गए`,
  },
  mr: {
    start: (target) => `${target} कडे चला`,
    inTurn: (m, turn, at, target) => `${m} मीटरनंतर ${at} येथे ${turn} — ${target} कडे`,
    nowTurn: (turn, at, target) => `${at} येथे ${turn} — ${target} कडे`,
    inArrive: (m, target) => `${target} ${m} मीटर पुढे आहे`,
    arrived: (target) => `तुम्ही ${target} येथे पोहोचलात`,
  },
};

/** Route as a list of lat/lng points, for drawing and for a simulated walk. */
export function routeLatLngs(result) {
  return (result?.path ?? []).map((id) => ({ id, ...nodeLatLng(id) }));
}

/**
 * Plan a walk from wherever the person is standing — usually partway along a
 * road, not on a landmark.
 *
 * Starting from the single nearest landmark can send someone backwards: the
 * nearest one may be 100 m behind them while the one 150 m ahead is on the
 * way. So try the few nearest landmarks and pick the one that makes the whole
 * trip quickest, counting the walk to reach it.
 *
 * @returns {{result, startId, walkMetres}|null}
 */
export function planFrom(lat, lng, toId, { flags = {}, candidates = 4 } = {}) {
  const here = { lat, lng };
  const nearby = NODES
    .map((node) => ({ node, metres: metresBetween(here, nodeLatLng(node.id)) }))
    .sort((a, b) => a.metres - b.metres)
    .slice(0, candidates);

  let best = null;
  for (const { node, metres } of nearby) {
    const result = route(node.id, toId, { flags });
    if (!result.ok) continue;
    const minutes = result.minutes + metres / WALK_SPEED / 60;
    if (!best || minutes < best.minutes) best = { result, startId: node.id, walkMetres: Math.round(metres), minutes };
  }
  return best;
}

/**
 * A guide for one route. Call update(position) on every fix.
 *
 * With `origin` (where the person is standing now), the guide adds a first
 * leg from that spot to the route's first landmark, so instructions start
 * from where they are rather than from a landmark they are not at.
 *
 * The leg index only moves forward (or back by one, if the walker really has
 * turned round), so a noisy GPS fix near a junction does not make the
 * instruction flicker between two legs.
 */
export function createGuide(result, lang = 'hi', { origin = null } = {}) {
  const path = result.path;
  // ids[i] names points[i]; HERE marks the walker's starting spot.
  const startsOff = origin && path.length && metresBetween(origin, nodeLatLng(path[0])) > ADVANCE_METRES;
  const ids = startsOff ? [HERE, ...path] : path;
  const points = ids.map((id) => (id === HERE ? local(origin.lat, origin.lng) : nodeLocal(id)));
  const legLengths = points.slice(1).map((p, i) => Math.hypot(p.x - points[i].x, p.y - points[i].y));
  const total = legLengths.reduce((a, b) => a + b, 0);
  // Crowd-adjusted minutes for the route, plus the plain walk to reach it.
  const totalMinutes = result.minutes + (startsOff ? legLengths[0] / WALK_SPEED / 60 : 0);
  const P = PHRASE[lang] ?? PHRASE.hi;
  let leg = 0;
  let closest = Infinity; // nearest we have been to the end of the current leg

  function update({ lat, lng, accuracy = 0 }) {
    const destination = ids[ids.length - 1];
    if (ids.length < 2) {
      return { leg: 0, arrived: true, offRoute: false, remainingMetres: 0, minutesLeft: 0, toNextMetres: 0,
        nextId: destination, angle: null, text: P.arrived(name(destination, lang)), phase: 'arrived', stepKey: 'arrived' };
    }

    const here = local(lat, lng);

    // Best leg near where we were: look one back and the rest ahead.
    let best = null;
    for (let i = Math.max(0, leg - 1); i < points.length - 1; i += 1) {
      const pr = project(here, points[i], points[i + 1]);
      // Prefer staying on the current leg when two are about equally close.
      const score = pr.distance - (i === leg ? 3 : 0);
      if (!best || score < best.score) best = { i, score, ...pr };
    }
    if (best.i !== leg) closest = Infinity;
    leg = best.i;

    let toNext = legLengths[leg] * (1 - best.t);
    // Passed the landmark at the end of this leg? Move on.
    if (toNext < ADVANCE_METRES && leg < points.length - 2) {
      leg += 1;
      toNext = legLengths[leg] + toNext;
      closest = Infinity;
    }

    const after = legLengths.slice(leg + 1).reduce((a, b) => a + b, 0);
    const remaining = Math.max(0, toNext + after);
    const offBy = best.distance;

    // Off the route means far from the line AND walking away from the next
    // landmark. The lines between landmarks are straight and real roads bend,
    // so being 60 m to one side while still closing in is not a mistake.
    const target = points[leg + 1];
    const straight = Math.hypot(here.x - target.x, here.y - target.y);
    closest = Math.min(closest, straight);
    const farFromLine = offBy > Math.max(OFF_ROUTE_METRES, accuracy * 1.2);
    const walkingAway = straight > closest + RETREAT_METRES;
    const lost = offBy > LOST_METRES;
    const offRoute = lost || (farFromLine && walkingAway);

    const lastLeg = leg === points.length - 2;
    const nextId = ids[leg + 1];
    const distToDest = Math.hypot(here.x - points[points.length - 1].x, here.y - points[points.length - 1].y);
    const arrived = lastLeg && (toNext < ARRIVE_METRES || distToDest < ARRIVE_METRES);

    let text;
    let angle = null;
    let phase;
    if (arrived) {
      text = P.arrived(name(destination, lang));
      phase = 'arrived';
    } else if (lastLeg) {
      text = P.inArrive(spokenMetres(toNext), name(destination, lang));
      phase = toNext <= NEAR_METRES ? 'near' : 'far';
      angle = 0;
    } else {
      angle = angleBetween(points[leg], points[leg + 1], points[leg + 2]);
      const turn = turnWords(angle, lang);
      const towards = name(ids[leg + 2], lang);
      phase = toNext <= NEAR_METRES ? 'near' : 'far';
      text = phase === 'near'
        ? P.nowTurn(turn, name(nextId, lang), towards)
        : P.inTurn(spokenMetres(toNext), turn, name(nextId, lang), towards);
    }

    // Minutes scale with the crowd-adjusted estimate for the whole route, so a
    // packed approach still reads as slow even when it is short.
    const minutesLeft = total ? Math.max(arrived ? 0 : 1, Math.round((totalMinutes * remaining) / total)) : 0;

    return {
      leg,
      nextId,
      toNextMetres: Math.round(toNext),
      remainingMetres: Math.round(remaining),
      minutesLeft,
      offRoute,
      offByMetres: Math.round(offBy),
      arrived,
      angle,
      phase,
      text,
      // Changes exactly when there is something new worth saying aloud.
      stepKey: `${leg}:${phase}`,
    };
  }

  return {
    update,
    path,
    origin: startsOff ? origin : null,
    totalMetres: Math.round(total),
    start: P.start(name(path[path.length - 1], lang)),
  };
}
