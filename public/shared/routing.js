/**
 * Crowd-aware routing.
 *
 * Runs identically on the device and on the server, from the same graph file.
 * That matters for two reasons: the phone can route with no network at all,
 * and the AI assistant cannot invent a route — it calls this.
 *
 * We minimise *time through a crowd*, not distance. A 600 m walk down an empty
 * service lane beats a 200 m shove through a packed ghat approach, and on a
 * shahi snan day that difference is the whole product.
 */

import { NODES, EDGES, NODE_BY_ID, distance, CROWD } from './mela-map.js';

const ADJACENCY = (() => {
  const adj = Object.fromEntries(NODES.map((n) => [n.id, []]));
  for (const e of EDGES) {
    adj[e.a].push({ to: e.b, edge: e });
    adj[e.b].push({ to: e.a, edge: e });
  }
  return adj;
})();

/** Crowd level for one path: an admin flag wins, otherwise the baseline. */
export function levelFor(edge, flags = {}) {
  const flagged = flags[edge.id];
  return flagged ? flagged.level : edge.base;
}

function cost(edge, flags, avoidCrowds) {
  const level = levelFor(edge, flags);
  const metres = distance(edge.a, edge.b);
  if (level >= 4) return Infinity;
  if (!avoidCrowds) return metres;
  return metres * CROWD[level].multiplier;
}

/**
 * @returns {{ok: boolean, path: string[], edges: object[], metres: number,
 *            minutes: number, worst: number, reason?: string}}
 */
export function route(fromId, toId, { flags = {}, avoidCrowds = true, walkSpeed = 1.1 } = {}) {
  if (!NODE_BY_ID[fromId] || !NODE_BY_ID[toId]) {
    return { ok: false, path: [], edges: [], metres: 0, minutes: 0, worst: 1, reason: 'unknown_place' };
  }
  if (fromId === toId) {
    return { ok: true, path: [fromId], edges: [], metres: 0, minutes: 0, worst: 1 };
  }

  const dist = Object.fromEntries(NODES.map((n) => [n.id, Infinity]));
  const prev = {};
  dist[fromId] = 0;
  const unvisited = new Set(NODES.map((n) => n.id));

  while (unvisited.size) {
    let current = null;
    let best = Infinity;
    for (const id of unvisited) {
      if (dist[id] < best) {
        best = dist[id];
        current = id;
      }
    }
    if (current === null) break;
    if (current === toId) break;
    unvisited.delete(current);

    for (const { to, edge } of ADJACENCY[current]) {
      if (!unvisited.has(to)) continue;
      const c = cost(edge, flags, avoidCrowds);
      if (!Number.isFinite(c)) continue;
      const alt = dist[current] + c;
      if (alt < dist[to]) {
        dist[to] = alt;
        prev[to] = { from: current, edge };
      }
    }
  }

  if (!Number.isFinite(dist[toId])) {
    // Every route is closed. Fall back to distance-only so we can at least show
    // something, and tell the caller it is blocked.
    if (avoidCrowds) {
      const fallback = route(fromId, toId, { flags, avoidCrowds: false });
      return { ...fallback, ok: false, reason: 'all_routes_closed' };
    }
    return { ok: false, path: [], edges: [], metres: 0, minutes: 0, worst: 4, reason: 'no_path' };
  }

  const path = [toId];
  const edges = [];
  let cursor = toId;
  while (cursor !== fromId) {
    const step = prev[cursor];
    edges.unshift(step.edge);
    cursor = step.from;
    path.unshift(cursor);
  }

  let metres = 0;
  let slowSeconds = 0;
  let worst = 1;
  for (const edge of edges) {
    const level = levelFor(edge, flags);
    const d = distance(edge.a, edge.b);
    metres += d;
    slowSeconds += (d / walkSpeed) * Math.min(CROWD[level].multiplier, 6);
    worst = Math.max(worst, level);
  }

  return {
    ok: true,
    path,
    edges,
    metres: Math.round(metres),
    minutes: Math.max(1, Math.round(slowSeconds / 60)),
    worst,
  };
}

const COMPASS = [
  { max: 22.5,  en: 'straight ahead', hi: 'सीधे',        mr: 'सरळ' },
  { max: 67.5,  en: 'to your right',  hi: 'दाईं ओर',     mr: 'उजवीकडे' },
  { max: 112.5, en: 'right',          hi: 'दाएं मुड़ें',  mr: 'उजवे वळा' },
  { max: 157.5, en: 'sharp right',    hi: 'तेज दाएं',    mr: 'तीव्र उजवे' },
  { max: 202.5, en: 'turn around',    hi: 'पीछे मुड़ें',  mr: 'मागे वळा' },
  { max: 247.5, en: 'sharp left',     hi: 'तेज बाएं',    mr: 'तीव्र डावे' },
  { max: 292.5, en: 'left',           hi: 'बाएं मुड़ें',  mr: 'डावे वळा' },
  { max: 337.5, en: 'to your left',   hi: 'बाईं ओर',     mr: 'डावीकडे' },
  { max: 361,   en: 'straight ahead', hi: 'सीधे',        mr: 'सरळ' },
];

function turnWord(prevNode, node, nextNode, lang) {
  if (!prevNode) return { en: 'Start', hi: 'शुरू', mr: 'सुरू' }[lang];
  const inAngle = Math.atan2(node.y - prevNode.y, node.x - prevNode.x);
  const outAngle = Math.atan2(nextNode.y - node.y, nextNode.x - node.x);
  let deg = ((outAngle - inAngle) * 180) / Math.PI;
  deg = ((deg % 360) + 360) % 360;
  return COMPASS.find((c) => deg < c.max)[lang];
}

/**
 * Landmark directions. Never street names — nobody at a mela knows the street
 * names, and half the paths are three days old.
 */
export function directions(result, lang = 'hi') {
  if (!result.ok && !result.path.length) return [];
  const steps = [];
  for (let i = 0; i < result.path.length - 1; i += 1) {
    const from = NODE_BY_ID[result.path[i]];
    const to = NODE_BY_ID[result.path[i + 1]];
    const before = i > 0 ? NODE_BY_ID[result.path[i - 1]] : null;
    const edge = result.edges[i];
    const metres = Math.round(distance(from.id, to.id));
    steps.push({
      turn: turnWord(before, from, to, lang),
      target: to.name[lang] ?? to.name.en,
      targetType: to.type,
      metres,
      crowd: edge ? edge.base : 1,
      edgeId: edge?.id,
    });
  }
  return steps;
}

/** Nearest facility of a type, by crowd-aware travel cost. */
export function nearest(fromId, type, { flags = {} } = {}) {
  const candidates = NODES.filter((n) => n.type === type);
  let best = null;
  for (const c of candidates) {
    const r = route(fromId, c.id, { flags });
    if (!r.ok) continue;
    if (!best || r.minutes < best.result.minutes) best = { node: c, result: r };
  }
  return best;
}
