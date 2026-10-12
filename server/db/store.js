/**
 * Development storage layer.
 *
 * This is a JSON-file store so the project runs with `npm install` and nothing
 * else — no Postgres, no Redis, no Docker. Every function here is an async
 * repository method, so swapping this file for a real Postgres implementation
 * later does not change a single caller. `schema.sql` in this folder is the
 * production DDL those tables map onto.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// KM_DATA_FILE lets tests and parallel demos use their own file.
const DATA_FILE = process.env.KM_DATA_FILE || path.join(HERE, 'data.json');

const EMPTY = {
  users: [],
  groups: [],
  memberships: [],
  positions: [],      // latest known position per user
  alerts: [],         // SOS
  alertEvents: [],    // append-only audit trail for every SOS
  edgeFlags: {},      // edgeId -> crowd level set by an admin
  notices: [],
  schedule: [],
  bandLookups: [],   // audit trail for every wristband lookup
  reunions: [],      // "we have your person" notices
  densityLog: {},    // aggregate head-counts only, never per-user
  secrets: {},
  messages: [],      // control room <-> one volunteer
  board: [],         // tasks for every volunteer       // hashed admin security key (never the key itself)
  seq: 1,
};

let data = null;
let writeTimer = null;

function load() {
  if (data) return data;
  try {
    data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const key of Object.keys(EMPTY)) {
      if (data[key] === undefined) data[key] = structuredClone(EMPTY[key]);
    }
  } catch {
    data = structuredClone(EMPTY);
  }
  return data;
}

/**
 * Write to a temp file then rename. A crash or power cut mid-write leaves the
 * previous good file in place instead of a truncated one that fails to parse —
 * which load() would otherwise treat as an empty database.
 */
function writeAtomic() {
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

function persist() {
  // Debounced: SOS writes must not block on disk I/O.
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    try { writeAtomic(); } catch (err) { console.error('  could not save data file:', err.message); }
  }, 120);
}

export function flush() {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  if (data) writeAtomic();
}

export function nextId(prefix) {
  const d = load();
  d.seq += 1;
  persist();
  return `${prefix}_${d.seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function all(collection) {
  return load()[collection];
}

export function insert(collection, row) {
  load()[collection].push(row);
  persist();
  return row;
}

export function update(collection, id, patch) {
  const row = load()[collection].find((r) => r.id === id);
  if (!row) return null;
  Object.assign(row, patch);
  persist();
  return row;
}

export function find(collection, predicate) {
  return load()[collection].find(predicate) ?? null;
}

export function filter(collection, predicate) {
  return load()[collection].filter(predicate);
}

export function setEdgeFlag(edgeId, level, actor) {
  const d = load();
  d.edgeFlags[edgeId] = { level, actor, at: new Date().toISOString() };
  persist();
  return d.edgeFlags[edgeId];
}

/** Drop an admin flag so the path goes back to its baseline crowding. */
export function clearEdgeFlag(edgeId) {
  const d = load();
  const existed = Boolean(d.edgeFlags[edgeId]);
  delete d.edgeFlags[edgeId];
  persist();
  return existed;
}

export function remove(collection, id) {
  const rows = load()[collection];
  const index = rows.findIndex((r) => r.id === id);
  if (index === -1) return null;
  const [row] = rows.splice(index, 1);
  persist();
  return row;
}

export function edgeFlags() {
  return load().edgeFlags;
}

export function replace(collection, rows) {
  load()[collection] = rows;
  persist();
}

export function reset() {
  data = structuredClone(EMPTY);
  flush();
}

export function dataFile() {
  return DATA_FILE;
}

export function raw() {
  return load();
}
