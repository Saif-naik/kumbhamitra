/**
 * Crush prediction.
 *
 * A crowd crush does not begin when density is high. It begins when density is
 * high AND still rising AND the exits are already slower than the entrances.
 * By the time it is visible on a CCTV monitor it is usually too late to do
 * anything but treat casualties. The window where a crush is preventable is
 * roughly the few minutes before it happens, and the only thing that fits in
 * that window is a decision to close one path and open another.
 *
 * So this computes three things per landmark: how many people are there, how
 * fast that number is changing, and how long until it crosses the level where
 * movement stops. Then it hands the control room a ranked list.
 *
 * PRIVACY, and this is the important part: this never stores who was where.
 * When a phone reports its position we increment a counter for
 * (landmark, minute) and throw the identity away immediately. The density log
 * is a table of numbers with no user column, so it cannot be turned into a
 * movement history for any individual even by someone with full database
 * access. Crowd safety does not require surveillance, and building it this way
 * means we never have to be trusted not to look.
 */

import { raw, all } from '../db/store.js';
import { NODES, NODE_BY_ID } from '../../public/shared/mela-map.js';

const WINDOW_MINUTES = 12;

/** Rough standing capacity per landmark before movement becomes impossible. */
const CAPACITY = {
  ghat: 2400,
  junction: 1600,
  gate: 1200,
  camp: 2000,
  food: 900,
  medical: 300,
  police: 400,
  toilet: 250,
  water: 350,
};

const minuteKey = (date = new Date()) => Math.floor(date.getTime() / 60_000);

function log() {
  const db = raw();
  if (!db.densityLog) db.densityLog = {};
  return db.densityLog;
}

/**
 * Record one presence at a landmark. No user id is passed in and none is
 * stored — the caller drops it before calling this.
 */
export function recordPresence(nodeId, count = 1) {
  const store = log();
  const key = `${nodeId}:${minuteKey()}`;
  store[key] = (store[key] ?? 0) + count;

  // Forget anything older than the window. The data has no value after that
  // and keeping it only creates risk.
  const cutoff = minuteKey() - WINDOW_MINUTES;
  for (const existing of Object.keys(store)) {
    const minute = Number(existing.split(':')[1]);
    if (minute < cutoff) delete store[existing];
  }
}

function seriesFor(nodeId) {
  const store = log();
  const now = minuteKey();
  const series = [];
  for (let offset = WINDOW_MINUTES - 1; offset >= 0; offset -= 1) {
    series.push(store[`${nodeId}:${now - offset}`] ?? 0);
  }
  return series;
}

/**
 * @returns {{nodeId, count, capacity, load, trend, minutesToCritical, risk}}
 * risk: 0 calm, 1 filling, 2 warning, 3 critical
 */
export function pressureFor(nodeId) {
  const node = NODE_BY_ID[nodeId];
  const series = seriesFor(nodeId);
  const capacity = CAPACITY[node?.type] ?? 1000;

  // Present count is the last three minutes averaged, so one quiet minute does
  // not read as the crowd having left.
  const recent = series.slice(-3);
  const count = Math.round(recent.reduce((a, b) => a + b, 0) / Math.max(1, recent.length));

  // Trend: people per minute, from the slope across the last six minutes.
  const tail = series.slice(-6);
  const first = tail.slice(0, 3).reduce((a, b) => a + b, 0) / 3;
  const last = tail.slice(-3).reduce((a, b) => a + b, 0) / 3;
  const trend = Math.round((last - first) / 3);

  const load = capacity ? count / capacity : 0;
  const headroom = capacity * 0.85 - count;
  const minutesToCritical = trend > 0 && headroom > 0 ? Math.round(headroom / trend) : null;

  let risk = 0;
  if (load >= 0.85) risk = 3;
  else if (load >= 0.6 && trend > 0) risk = 2;
  else if (minutesToCritical !== null && minutesToCritical <= 10) risk = 2;
  else if (load >= 0.45 || trend > 0) risk = 1;

  // Rising fast in an enclosed approach is worse than the same load at a gate.
  if (risk === 2 && trend > capacity * 0.06 && node?.type !== 'gate') risk = 3;

  return { nodeId, count, capacity, load: Number(load.toFixed(2)), trend, minutesToCritical, risk };
}

export function pressureMap() {
  return NODES.map((node) => pressureFor(node.id));
}

/** Only the landmarks a human needs to look at right now, worst first. */
export function warnings() {
  return pressureMap()
    .filter((p) => p.risk >= 2)
    .sort((a, b) => {
      if (b.risk !== a.risk) return b.risk - a.risk;
      return (a.minutesToCritical ?? 999) - (b.minutesToCritical ?? 999);
    });
}

/**
 * Demo only: inject a synthetic crowd so the prediction can be shown without
 * five hundred real handsets. Clearly labelled in the console as simulated.
 */
export function simulateInflow(nodeId, people, minutesBack = 6) {
  const store = log();
  const now = minuteKey();
  for (let offset = minutesBack - 1; offset >= 0; offset -= 1) {
    // Ramp upward so the trend line is realistic rather than a flat block.
    const share = Math.round((people * (minutesBack - offset)) / (minutesBack * 1.6));
    const key = `${nodeId}:${now - offset}`;
    store[key] = (store[key] ?? 0) + share;
  }
  return pressureFor(nodeId);
}

export function clearSimulation() {
  const db = raw();
  db.densityLog = {};
}
